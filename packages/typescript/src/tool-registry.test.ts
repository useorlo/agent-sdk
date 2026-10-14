/** Dispatch never falls back to raw tools; permissions, outage defaults, and typed results remain intact. */
import { describe, expect, it, vi } from 'vitest';
import { createToolRegistry, OrloAgentClient, OrloAgentRun, OrloGovernanceBlockedError, OrloUnavailableError } from './index.js';
async function fixture(decision = 'allow', open = false) {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'run' }, blocking_step_types: ['tool_request'] })))
    .mockImplementation(async () => new Response(JSON.stringify({ decision, envelope: { step_id: 'call' } })));
  const client = new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId: 'org', fetch, retries: 0 });
  const run = await OrloAgentRun.start(client, { task_id: 'task' }, open ? { failMode: { read: 'open' } } : {});
  const execute = vi.fn(async (args: { id: string }) => ({ found: args.id }));
  const tools = { lookup: { actionClass: 'read' as const, execute } };
  return { fetch, run, execute, tools, registry: createToolRegistry({ run, tools, autoRequestApproval: false }) };
}
describe('registered tools', () => {
  it('retains argument and result types and sends both sides of a governed call', async () => {
    const { registry, fetch, run, execute } = await fixture();
    const result = await registry.invoke('lookup', { id: '42' }, { stepId: 'call' });
    const value: string = result.found;
    expect(value).toBe('42'); expect(execute).toHaveBeenCalledOnce();
    await run.flush();
    const steps = fetch.mock.calls.slice(1).map(([, init]) => JSON.parse(init.body));
    expect(steps.map(s => s.step_type)).toEqual(['tool_request', 'tool_result']);
    expect(steps[0]).toMatchObject({ tool_name: 'lookup', action_class: 'read', metadata: { orlo_tool_registration: 'registry' } });
  });
  it.each(['reject', 'require_approval', 'contain'])('never executes a %s call', async decision => {
    const { registry, execute } = await fixture(decision);
    await expect(registry.invoke('lookup', { id: '42' }, { stepId: 'call' })).rejects.toBeInstanceOf(OrloGovernanceBlockedError);
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects unknown names and missing call IDs without consulting Orlo or executing', async () => {
    const { registry, fetch, execute } = await fixture();
    await expect(registry.invoke('__proto__' as 'lookup', { id: '42' }, { stepId: 'call' })).rejects.toThrow('not registered');
    await expect(registry.invoke('lookup', { id: '42' }, { stepId: '' })).rejects.toThrow('stepId');
    expect(fetch).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
  it('snapshots registration and reports the actual outage setting', async () => {
    const { registry, tools, execute, run } = await fixture('allow', true);
    tools.lookup.execute = vi.fn(async () => ({ found: 'wrong' }));
    expect(registry.describe()).toEqual([{ name: 'lookup', actionClass: 'read', whenUnavailable: 'continue' }]);
    await registry.invoke('lookup', { id: '42' }, { stepId: 'call' }); await run.flush();
    expect(execute).toHaveBeenCalledOnce(); expect(tools.lookup.execute).not.toHaveBeenCalled();
    expect(() => createToolRegistry({ run, tools: { broken: { execute } } as any })).toThrow('explicit action class');
  });
  it('stops a registered read during an outage by default', async () => {
    const { registry, fetch, execute } = await fixture(); fetch.mockRejectedValue(new TypeError('offline'));
    expect(registry.describe()[0].whenUnavailable).toBe('stop');
    await expect(registry.invoke('lookup', { id: '42' }, { stepId: 'call' })).rejects.toBeInstanceOf(OrloUnavailableError);
    expect(execute).not.toHaveBeenCalled();
  });
});
