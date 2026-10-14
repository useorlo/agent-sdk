/** Bounded, cancellable approval reads. Notifications and decisions never execute a tool. */
import type { AgentApproval } from './protocol.js';
import { OrloUnavailableError, sleep } from './transport.js';

export interface WaitForApprovalOptions {
  /** Total wait, including transport retries. Default five minutes. */
  timeoutMs?: number;
  /** Interval between successful pending reads. Default two seconds. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export class OrloApprovalTimeoutError extends Error {
  constructor(readonly approvalId: string, readonly timeoutMs: number) {
    super(`Approval ${approvalId} did not resolve within ${timeoutMs} ms. Read its status before retrying the governed step.`);
    this.name = 'OrloApprovalTimeoutError';
  }
}

export function validateApproval(value: unknown, id: string): AgentApproval {
  const approval = value as Partial<AgentApproval> | null;
  if (!approval || approval.id !== id || !['pending', 'approved', 'rejected', 'expired'].includes(String(approval.status))) {
    throw new Error('Orlo returned an invalid approval response');
  }
  return approval as AgentApproval;
}

export async function waitForApprovalDecision(
  read: (signal: AbortSignal) => Promise<AgentApproval>, id: string, options: WaitForApprovalOptions,
): Promise<AgentApproval> {
  const timeout = options.timeoutMs ?? 300_000;
  const interval = options.pollIntervalMs ?? 2_000;
  if (!id.trim() || !Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647 || !Number.isFinite(interval) || interval <= 0 || interval > 2_147_483_647) {
    throw new TypeError('approvalId and positive, finite timeoutMs and pollIntervalMs are required (maximum 2147483647 ms)');
  }
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new OrloApprovalTimeoutError(id, timeout)), timeout);
  let failures = 0;
  try {
    while (true) {
      controller.signal.throwIfAborted();
      try {
        const approval = await read(controller.signal);
        controller.signal.throwIfAborted();
        if (approval.status !== 'pending') return approval;
        failures = 0;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (!(error instanceof OrloUnavailableError)) throw error;
        failures = Math.min(failures + 1, 4);
      }
      await sleep(failures ? Math.min(10_000, interval * 2 ** failures) : interval, controller.signal);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
