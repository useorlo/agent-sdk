/** Approval waits stay bounded, recover outages, and never turn a notification into execution. */
import { describe, expect, it, vi } from 'vitest';
import { OrloAgentClient, OrloAgentRun, OrloApiError, OrloApprovalTimeoutError } from './index.js';
const json = (status: string, id = 'approval-1') => new Response(JSON.stringify({ id, status }));
const make = (fetch: typeof globalThis.fetch) => new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId: 'org-1', fetch, retries: 0, circuitBreaker: false, timeoutMs: 25 });

describe('approval recovery', () => {
  it.each(['approved', 'rejected', 'expired'])('returns %s after pending without writing', async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(json('pending')).mockResolvedValueOnce(json(status));
    expect((await make(fetch).waitForApproval('approval-1', { pollIntervalMs: 1 })).status).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe('https://orlo.test/v1/agent-approvals/approval-1');
    expect(fetch.mock.calls.every(([, init]) => !init.method && !init.body)).toBe(true);
  });
  it('recovers a transient outage and can read an already decided approval', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(json('approved'));
    expect((await make(fetch).waitForApproval('approval-1', { pollIntervalMs: 1 })).status).toBe('approved');
    expect((await make(vi.fn().mockResolvedValue(json('rejected'))).getApproval('approval-1')).status).toBe('rejected');
  });
  it('stops on permission errors and malformed status or mismatched identity', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":"FORBIDDEN"}', { status: 403 }));
    await expect(make(fetch).waitForApproval('approval-1')).rejects.toBeInstanceOf(OrloApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(make(vi.fn().mockResolvedValue(json('allow'))).getApproval('approval-1')).rejects.toThrow('invalid approval');
    await expect(make(vi.fn().mockResolvedValue(json('approved', 'another'))).getApproval('approval-1')).rejects.toThrow('invalid approval');
  });
  it('times out while pending and cancels during sleep', async () => {
    const fetch = vi.fn().mockImplementation(async () => json('pending'));
    await expect(make(fetch).waitForApproval('approval-1', { timeoutMs: 10, pollIntervalMs: 100 })).rejects.toBeInstanceOf(OrloApprovalTimeoutError);
    const controller = new AbortController();
    const waiting = make(fetch).waitForApproval('approval-1', { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    const calls = fetch.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
  it('aborts an active read and bounds a stalled response body', async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(stream) { signal?.addEventListener('abort', () => stream.error(signal?.reason), { once: true }); } }));
    });
    const client = make(fetch);
    await expect(client.waitForApproval('approval-1', { timeoutMs: 10 })).rejects.toBeInstanceOf(OrloApprovalTimeoutError);
    expect(signal?.aborted).toBe(true);
    const controller = new AbortController();
    const waiting = client.getApproval('approval-1', { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects invalid timing without making a request', async () => {
    const fetch = vi.fn();
    for (const timeoutMs of [0, -1, Infinity, NaN, 2 ** 32]) await expect(make(fetch).waitForApproval('approval-1', { timeoutMs })).rejects.toBeInstanceOf(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('reattaches only to open sessions without creating or reopening a run', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'session-1', status: 'paused' } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'session-1', status: 'completed' } })));
  const client = make(fetch);
  const run = await OrloAgentRun.resume(client, 'session-1');
  expect(run.sessionId).toBe('session-1');
  expect(run.blockingStepTypes.has('tool_request')).toBe(true);
  await expect(OrloAgentRun.resume(client, 'session-1')).rejects.toThrow('active or paused');
  expect(fetch.mock.calls.every(([url, init]) => url.endsWith('/agent-sessions/session-1') && !init.method)).toBe(true);
});
