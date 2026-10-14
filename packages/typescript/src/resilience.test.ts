/**
 * Vitest tests for how @orlo/agent-sdk behaves when Orlo is slow, unreachable, or answers with an
 * error, and for which steps it waits on Orlo's answer. Covers OrloAgentClient, OrloAgentRun, and
 * the generic runtime adapter against a mocked fetch.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OrloAgentClient,
  OrloAgentRun,
  OrloApiError,
  OrloUnavailableError,
  createGenericRuntimeAdapter,
} from './index.js';

function sessionJson(blockingStepTypes?: string[]) {
  const now = new Date().toISOString();
  return {
    session: {
      id: 'session-1',
      task_id: 'task-1',
      external_run_id: null,
      goal: null,
      expected_outcome: null,
      framework: 'test',
      risk_tier: 'medium',
      autonomy_level: 'assisted',
      status: 'active',
      containment_state: null,
      step_count: 0,
      tool_call_count: 0,
      write_action_count: 0,
      external_side_effect_count: 0,
      started_at: now,
      completed_at: null,
      last_activity_at: now,
      created_at: now,
      updated_at: now,
    },
    policy_cache_ttl_s: 60,
    ...(blockingStepTypes ? { blocking_step_types: blockingStepTypes } : {}),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function governResponse(decision: string) {
  return {
    decision,
    reason: null,
    trace_id: 'trace-1',
    risk_tier: 'medium',
    containment: null,
    validation: null,
    policy_decision: { decision, reason_code: null, reason_summary: null, matched_policies: [], decision_latency_ms: 1, degraded_mode: false },
    citations: [],
    state_change: null,
    envelope: { step_id: 'step-1' },
    retrieval: null,
  };
}

/** A fetch that never answers until its request is aborted. */
function hangingFetch(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe('transport resilience', () => {
  it('retries a timed-out write once with the same Idempotency-Key', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init);
      if (calls.length === 1) return hangingFetch(init?.signal);
      return json(governResponse('allow'));
    });
    const client = new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId: 'org-1', fetch: fetchMock as never, timeoutMs: 30 });

    const result = await client.governStep('session-1', { step_id: 'step-1', step_type: 'tool_request', tool_name: 'lookup_order' });
    expect(result.decision).toBe('allow');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headerOf(calls[0], 'Idempotency-Key')).toBeTruthy();
    expect(headerOf(calls[1], 'Idempotency-Key')).toBe(headerOf(calls[0], 'Idempotency-Key'));
  });

  it('does not retry a 4xx answer', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'SESSION_NOT_ACTIVE', message: 'Session is not active' }, 409));
    const client = new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId: 'org-1', fetch: fetchMock as never });

    await expect(client.governStep('session-1', { step_id: 's', step_type: 'model_call' })).rejects.toBeInstanceOf(OrloApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('waits for a duplicate that is still running and takes its replayed answer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'IDEMPOTENCY_IN_PROGRESS', message: 'still running' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json', 'retry-after': '0.01' },
      }))
      .mockResolvedValueOnce(json(governResponse('require_approval')));
    const client = new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId: 'org-1', fetch: fetchMock as never });

    const result = await client.governStep('session-1', { step_id: 's', step_type: 'tool_request', tool_name: 'issue_refund' });
    expect(result.decision).toBe('require_approval');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit after repeated failures and stops calling Orlo', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new OrloAgentClient({
      baseUrl: 'https://orlo.test',
      orgId: 'org-1',
      fetch: fetchMock as never,
      retries: 0,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
    });

    for (let i = 0; i < 2; i += 1) {
      await expect(client.governStep('session-1', { step_id: `s${i}`, step_type: 'model_call' })).rejects.toBeInstanceOf(OrloUnavailableError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(client.governStep('session-1', { step_id: 's3', step_type: 'model_call' })).rejects.toBeInstanceOf(OrloUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fail modes and background steps', () => {
  async function startRun(fetchMock: ReturnType<typeof vi.fn>, blockingStepTypes?: string[]) {
    fetchMock.mockResolvedValueOnce(json(sessionJson(blockingStepTypes), 201));
    const client = new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId: 'org-1', fetch: fetchMock as never, retries: 0 });
    return OrloAgentRun.start(client, { task_id: 'task-1' });
  }

  it('lets a read run when Orlo is unreachable and records it later', async () => {
    const fetchMock = vi.fn();
    const run = await startRun(fetchMock);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const adapter = createGenericRuntimeAdapter({ run });
    const execute = vi.fn(async () => ({ status: 'shipped' }));

    const result = await adapter.runToolStep({ stepId: 'step-read', toolName: 'lookup_order', arguments: { order_id: '1' }, actionClass: 'read', execute });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.pre.failedOpen).toBe(true);
    expect(result.pre.governance.policy_decision.reason_code).toBe('orlo_unreachable_fail_open');

    await run.flush();
    const importCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/traces/import'));
    expect(importCall).toBeTruthy();
  });

  it('blocks a write when Orlo is unreachable', async () => {
    const fetchMock = vi.fn();
    const run = await startRun(fetchMock);
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const adapter = createGenericRuntimeAdapter({ run });
    const execute = vi.fn(async () => ({ refunded: true }));

    await expect(adapter.runToolStep({ stepId: 'step-write', toolName: 'issue_refund', arguments: { amount: 10 }, actionClass: 'write', execute }))
      .rejects.toBeInstanceOf(OrloUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('sends non-blocking steps in the background and flushes them before completing', async () => {
    const fetchMock = vi.fn();
    const run = await startRun(fetchMock, ['tool_request', 'retrieval']);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/steps/govern')) {
        await gate;
        return json(governResponse('allow'));
      }
      return json(sessionJson().session);
    });
    const adapter = createGenericRuntimeAdapter({ run });

    const result = await adapter.runModelStep({ stepId: 'step-model', modelName: 'gpt-4o-mini', input: {}, execute: async () => ({ content: 'ok' }) });
    expect(result.pre).toBeNull();
    expect(result.post).toBeNull();
    expect(result.output).toEqual({ content: 'ok' });

    const completing = run.complete();
    const patchedEarly = fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patchedEarly).toBe(false);
    release();
    await completing;
    const governCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/steps/govern'));
    expect(governCalls).toHaveLength(2);
    expect(run.unsentSteps).toBe(0);
  });

  it('treats every step as blocking when the server does not say otherwise', async () => {
    const fetchMock = vi.fn();
    const run = await startRun(fetchMock);
    expect(run.isBlocking('model_call')).toBe(true);
    expect(run.isBlocking('tool_result')).toBe(true);
  });
});
