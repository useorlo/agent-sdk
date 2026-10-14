/**
 * Vitest tests for @orlo/agent-sdk against a mocked fetch: the org header the client sends, an
 * approval request for a gated tool call through createOrloStepCallbacks, and the generic runtime
 * adapter, including the OrloGovernanceBlockedError it throws when Orlo blocks a step.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OrloAgentClient,
  OrloAgentRun,
  OrloGovernanceBlockedError,
  createGenericRuntimeAdapter,
  createOrloStepCallbacks,
} from './index.js';

describe('@orlo/agent-sdk', () => {
  it('sends org-scoped requests through the thin client', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/json',
        'X-Orlo-Org-Id': 'org-123',
      });
      return new Response(JSON.stringify({
        session: {
          id: 'session-1',
          task_id: 'task-1',
          external_run_id: null,
          goal: 'Review a claim',
          expected_outcome: null,
          framework: 'test',
          risk_tier: 'high',
          autonomy_level: 'assisted',
          status: 'active',
          containment_state: null,
          step_count: 0,
          tool_call_count: 0,
          write_action_count: 0,
          external_side_effect_count: 0,
          started_at: new Date().toISOString(),
          completed_at: null,
          last_activity_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        policy_cache_ttl_s: 60,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new OrloAgentClient({
      baseUrl: 'https://orlo.test',
      orgId: 'org-123',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const session = await client.createSession({
      task_id: 'task-1',
      goal: 'Review a claim',
      framework: 'test',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(session.session.id).toBe('session-1');
    expect(session.policy_cache_ttl_s).toBe(60);
  });

  it('auto-requests approval for gated tool checks through callbacks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
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
          started_at: new Date().toISOString(),
          completed_at: null,
          last_activity_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        policy_cache_ttl_s: 60,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        decision: 'require_approval',
        reason: 'Approval required for send_email',
        trace_id: 'trace-1',
        risk_tier: 'high',
        containment: null,
        validation: null,
        retrieval: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'approval-1',
        session_id: 'session-1',
        step_id: 'step-1',
        task_id: 'task-1',
        policy_reason: 'Approval required for send_email',
        status: 'pending',
        request_payload: null,
        timeout_at: null,
        decided_at: null,
        decided_by: null,
        decision_payload: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));

    const client = new OrloAgentClient({
      baseUrl: 'https://orlo.test',
      orgId: 'org-123',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const run = await OrloAgentRun.start(client, { task_id: 'task-1', framework: 'test' });
    const callbacks = createOrloStepCallbacks({ run, autoRequestApproval: true });
    const result = await callbacks.beforeToolCall({
      step_id: 'step-1',
      tool_name: 'send_email',
      arguments: { to: 'ops@example.com' },
      action_class: 'network',
      environment: 'staging',
    });

    expect(result.governance.decision).toBe('require_approval');
    expect(result.approval?.id).toBe('approval-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('wraps generic model execution with pre/post governance', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
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
          started_at: new Date().toISOString(),
          completed_at: null,
          last_activity_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        policy_cache_ttl_s: 60,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        decision: 'allow',
        reason: null,
        trace_id: 'trace-pre',
        risk_tier: 'medium',
        containment: null,
        validation: null,
        retrieval: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        decision: 'allow_with_warning',
        reason: 'Minor warning',
        trace_id: 'trace-post',
        risk_tier: 'medium',
        containment: null,
        validation: {
          valid: true,
          warnings: ['Minor warning'],
          score: 0.9,
          abstain: false,
          escalate: false,
        },
        retrieval: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const client = new OrloAgentClient({
      baseUrl: 'https://orlo.test',
      orgId: 'org-123',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const run = await OrloAgentRun.start(client, { task_id: 'task-1', framework: 'test' });
    const adapter = createGenericRuntimeAdapter({ run });

    const result = await adapter.runModelStep({
      stepId: 'model-step-1',
      modelName: 'gpt-test',
      input: { messages: [{ role: 'user', content: 'Summarize this' }] },
      execute: async () => ({ content: 'Done', tokens_used: { input: 10, output: 5 } }),
    });

    expect(result.output).toMatchObject({ content: 'Done' });
    expect(result.pre.decision).toBe('allow');
    expect(result.post.decision).toBe('allow_with_warning');
  });

  it('throws a typed error when the generic runtime adapter is blocked', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session: {
          id: 'session-1',
          task_id: 'task-1',
          external_run_id: null,
          goal: null,
          expected_outcome: null,
          framework: 'test',
          risk_tier: 'high',
          autonomy_level: 'assisted',
          status: 'active',
          containment_state: null,
          step_count: 0,
          tool_call_count: 0,
          write_action_count: 0,
          external_side_effect_count: 0,
          started_at: new Date().toISOString(),
          completed_at: null,
          last_activity_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        policy_cache_ttl_s: 60,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        decision: 'contain',
        reason: 'Runtime limit exceeded',
        trace_id: 'trace-1',
        risk_tier: 'high',
        containment: 'read_only_mode',
        validation: null,
        retrieval: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const client = new OrloAgentClient({
      baseUrl: 'https://orlo.test',
      orgId: 'org-123',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const run = await OrloAgentRun.start(client, { task_id: 'task-1', framework: 'test' });
    const adapter = createGenericRuntimeAdapter({ run });

    await expect(adapter.runModelStep({
      stepId: 'model-step-2',
      modelName: 'gpt-test',
      input: { messages: [{ role: 'user', content: 'Do something risky' }] },
      execute: async () => ({ content: 'Should not run' }),
    })).rejects.toBeInstanceOf(OrloGovernanceBlockedError);
  });

  it('retries a blocked tool step under its original step id once the approval is decided', async () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ session: { id: 'session-1', task_id: 'task-1', status: 'active' }, policy_cache_ttl_s: 60 }, 201))
      .mockResolvedValueOnce(json({ decision: 'require_approval', reason: 'Tool "issue_refund" resolved to require_approval', trace_id: 'trace-1', risk_tier: 'high', containment: null }))
      .mockResolvedValueOnce(json({ id: 'approval-1', session_id: 'session-1', step_id: 'tool_refund', status: 'pending' }, 201))
      .mockResolvedValueOnce(json({ decision: 'allow', reason: 'Allowed by approval approval-1', trace_id: 'trace-2', risk_tier: 'high', containment: null }))
      .mockResolvedValueOnce(json({ decision: 'allow', reason: null, trace_id: 'trace-3', risk_tier: 'high', containment: null }));

    const client = new OrloAgentClient({
      baseUrl: 'https://orlo.test',
      orgId: 'org-123',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const run = await OrloAgentRun.start(client, { task_id: 'task-1', framework: 'test' });
    const adapter = createGenericRuntimeAdapter({ run, autoRequestApproval: true });
    const execute = vi.fn(async () => ({ refunded: true }));
    const step = {
      stepId: 'tool_refund',
      toolName: 'issue_refund',
      actionClass: 'write' as const,
      arguments: { order_id: 'ord_123', amount_cents: 4200 },
      execute,
    };

    const blocked = await adapter.runToolStep(step).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(OrloGovernanceBlockedError);
    expect(blocked).toMatchObject({ decision: 'require_approval', stepId: 'tool_refund', approval: { id: 'approval-1' } });
    expect(execute).not.toHaveBeenCalled();

    const retried = await adapter.runToolStep({ ...step, stepId: (blocked as OrloGovernanceBlockedError).stepId! });
    expect(retried.output).toEqual({ refunded: true });
    expect(execute).toHaveBeenCalledOnce();

    const governedRequest = (callIndex: number) => JSON.parse(String((fetchMock.mock.calls[callIndex][1] as RequestInit).body));
    expect(governedRequest(3)).toMatchObject({ step_id: 'tool_refund', step_type: 'tool_request', input: step.arguments });
    expect(governedRequest(3)).toEqual(governedRequest(1));
  });
});
