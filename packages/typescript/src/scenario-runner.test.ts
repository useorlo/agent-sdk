/** The local scenario runner bounds work, preserves cleanup failures, and delivers stable receipts. */
import { describe, expect, it, vi } from 'vitest';
import { OrloAgentClient } from './index.js';
import { evaluateAuthoritativeStateVerifier, OrloScenarioRunner, ScenarioTrialDeliveryError, runScenarioTrials, type ScenarioEnvironment, type ScenarioTrialAssignment } from './scenario-runner.js';

const assignment: ScenarioTrialAssignment = {
  trial_id: 'trial-1', task_id: 'task-1', execution_token: 'secret',
  candidate:{version:1,key:'baseline'},repetition:1,attempt:1,lease_expires_at:new Date(Date.now()+60_000).toISOString(),
  scenario: { version: 1, environment:{name:'fixture',version:'1',implementation_hash:'a'.repeat(64)},simulator:{kind:'scripted',version:'1',implementation_hash:'a'.repeat(64)}, initial_state: { order: 'open' }, interactions: [{ after_turn: 0, actor: 'user', content: 'Help' }],
    verifiers: [],
    budgets: { max_turns: 4, max_tool_calls: 2, max_duration_ms: 1000, max_cost_usd: 1 } },
};

function session() {
  return { id: 'session-1', task_id: 'task-1', activity_kind: 'scenario_test', scenario_trial_id: 'trial-1', external_run_id: null, goal: null,
    expected_outcome: null, framework: 'test', risk_tier: 'medium', autonomy_level: 'assisted', status: 'active', containment_state: null,
    step_count: 0, tool_call_count: 0, write_action_count: 0, external_side_effect_count: 0, started_at: new Date().toISOString(),
    completed_at: null, last_activity_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

function client(fetchMock: ReturnType<typeof vi.fn>) {
  return new OrloAgentClient({ baseUrl: 'https://orlo.test', orgId: 'org-1', fetch: fetchMock as unknown as typeof fetch, retries: 0 });
}

describe('OrloScenarioRunner', () => {
  it('prepares, executes, cleans up, and delivers an authenticated receipt', async () => {
    const received: Array<{url:string;init?:RequestInit}> = [];
    const fetchMock = vi.fn(async (url:string, init?:RequestInit) => {
      received.push({url,init});
      if (url.endsWith('/v1/agent-sessions')) return new Response(JSON.stringify({ session: session(), policy_cache_ttl_s: 30 }), { status: 201, headers: {'Content-Type':'application/json'} });
      return new Response(JSON.stringify({ trial_id:'trial-1',status:'completed',receipt_id:'receipt',recorded:true }), { status: 200, headers: {'Content-Type':'application/json'} });
    });
    const environment: ScenarioEnvironment = { prepare: vi.fn(async()=>{}), cleanup: vi.fn(async()=>({status:'succeeded'})) };
    const result = await new OrloScenarioRunner(client(fetchMock)).run(assignment, environment, async ({run}) => {
      expect(run.session.activity_kind).toBe('scenario_test');
      return { status:'completed', metrics:{turns:2,tool_calls:1,cost_usd:.02} };
    });
    expect(result).toMatchObject({status:'completed',recorded:true});
    expect(environment.prepare).toHaveBeenCalledWith({order:'open'},expect.any(AbortSignal));
    const createBody = JSON.parse(String(received[0]!.init?.body));
    expect(createBody.test_context).toEqual({kind:'scenario_trial',trial_id:'trial-1',execution_token:'secret'});
    expect(received[1]!.init?.headers).toMatchObject({'X-Orlo-Scenario-Token':'secret'});
  });

  it('records cleanup failure as invalid and keeps the failure visible', async () => {
    let receipt: Record<string,unknown> = {};
    const fetchMock = vi.fn(async (url:string, init?:RequestInit) => {
      if (url.endsWith('/v1/agent-sessions')) return new Response(JSON.stringify({ session: session(), policy_cache_ttl_s: 30 }), { status: 201, headers: {'Content-Type':'application/json'} });
      receipt = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ trial_id:'trial-1',status:'invalid',receipt_id:receipt.receipt_id,recorded:true }), { status: 200, headers: {'Content-Type':'application/json'} });
    });
    const environment: ScenarioEnvironment = { prepare: async()=>{}, cleanup: async()=>({status:'failed',detail:'fixture still dirty'}) };
    const result = await new OrloScenarioRunner(client(fetchMock)).run(assignment, environment, async()=>({status:'completed'}));
    expect(result.status).toBe('invalid');
    expect(receipt).toMatchObject({status:'invalid',failure:{cleanup:'fixture still dirty'}});
  });

  it('returns the unsent receipt when delivery is unavailable', async () => {
    const fetchMock = vi.fn(async (url:string) => url.endsWith('/v1/agent-sessions')
      ? new Response(JSON.stringify({session:session(),policy_cache_ttl_s:30}),{status:201,headers:{'Content-Type':'application/json'}})
      : new Response(JSON.stringify({error:'down'}),{status:503,headers:{'Content-Type':'application/json'}}));
    await expect(new OrloScenarioRunner(client(fetchMock)).run(assignment,{prepare:async()=>{},cleanup:async()=>({status:'succeeded'})},async()=>({status:'completed',metrics:{turns:1,tool_calls:0,cost_usd:0}})))
      .rejects.toMatchObject({name:'ScenarioTrialDeliveryError',receipt:{status:'completed'}} satisfies Partial<ScenarioTrialDeliveryError>);
  });

  it('enforces the deadline and still runs cleanup with a fresh signal', async () => {
    let receipt: Record<string,unknown> = {};
    const fetchMock = vi.fn(async (url:string, init?:RequestInit) => {
      if (url.endsWith('/v1/agent-sessions')) return new Response(JSON.stringify({session:session(),policy_cache_ttl_s:30}),{status:201,headers:{'Content-Type':'application/json'}});
      receipt=JSON.parse(String(init?.body));return new Response(JSON.stringify({trial_id:'trial-1',status:'failed',receipt_id:receipt.receipt_id,recorded:true}),{status:200,headers:{'Content-Type':'application/json'}});
    });
    const timed={...assignment,scenario:{...assignment.scenario,budgets:{...assignment.scenario.budgets,max_duration_ms:10}}};
    const cleanup=vi.fn(async(signal:AbortSignal)=>({status:signal.aborted?'failed':'succeeded' as const}));
    await new OrloScenarioRunner(client(fetchMock)).run(timed,{prepare:async()=>{},cleanup},async()=>new Promise(()=>{}));
    expect(cleanup).toHaveBeenCalled();expect(receipt).toMatchObject({status:'failed',cleanup:{status:'succeeded'}});
  });

  it('bounds preparation and cleans up a partially prepared environment', async () => {
    const timed={...assignment,scenario:{...assignment.scenario,budgets:{...assignment.scenario.budgets,max_duration_ms:10}}};
    const cleanup=vi.fn(async()=>({status:'succeeded' as const}));
    await expect(new OrloScenarioRunner(client(vi.fn())).run(timed,{prepare:async()=>new Promise(()=>{}),cleanup},async()=>({status:'completed',metrics:{turns:1,tool_calls:0,cost_usd:0}})))
      .rejects.toMatchObject({name:'TimeoutError'});
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('honours an already aborted caller signal before preparation', async () => {
    const controller=new AbortController();controller.abort(new DOMException('Stopped','AbortError'));
    const prepare=vi.fn(async()=>{});const cleanup=vi.fn(async()=>({status:'succeeded' as const}));
    await expect(new OrloScenarioRunner(client(vi.fn())).run(assignment,{prepare,cleanup},async()=>({status:'completed',metrics:{turns:1,tool_calls:0,cost_usd:0}}),{signal:controller.signal}))
      .rejects.toMatchObject({name:'AbortError'});
    expect(prepare).not.toHaveBeenCalled();expect(cleanup).not.toHaveBeenCalled();
  });

  it('bounds batch concurrency and retains one result per assignment', async () => {
    let active=0,max=0;
    const rows=await runScenarioTrials(Array.from({length:7},(_,index)=>({...assignment,trial_id:`trial-${index}`})),2,async item=>{
      active+=1;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,5));active-=1;
      return {trial_id:item.trial_id,session_id:'s',status:'completed',receipt_id:'r',recorded:true};
    });
    expect(max).toBe(2); expect(rows).toHaveLength(7); expect(rows.every(row=>row.status==='fulfilled')).toBe(true);
  });

  it('checks authoritative state without using the agent answer as evidence', () => {
    const declaration = { key:'refund_state',version:'1',implementation_hash:'a'.repeat(64),dimension:'outcome' as const,
      evidence_source:'authoritative_state' as const,mandatory:true,specification:{path:'/order/status',equals:'refunded'} };
    expect(evaluateAuthoritativeStateVerifier(declaration,{order:{status:'refunded'}},'fixture:order-1')).toMatchObject({status:'passed',evidence:{observed:'refunded'}});
    expect(evaluateAuthoritativeStateVerifier(declaration,{order:{status:'open'}},'fixture:order-1')).toMatchObject({status:'failed',evidence:{observed:'open'}});
    expect(evaluateAuthoritativeStateVerifier({...declaration,specification:{path:'/items/0',absent:true}},{items:['present']},'fixture:list')).toMatchObject({status:'failed'});
    expect(evaluateAuthoritativeStateVerifier({...declaration,specification:{path:'/value',equals:1}},{value:true},'fixture:types')).toMatchObject({status:'failed'});
  });

  it('asks the environment for declared evidence after execution', async () => {
    let receipt: Record<string,unknown> = {};
    const declaration = { key:'refund_state',version:'1',implementation_hash:'a'.repeat(64),dimension:'outcome' as const,
      evidence_source:'authoritative_state' as const,mandatory:true,specification:{path:'/order/status',equals:'refunded'} };
    const fetchMock = vi.fn(async (url:string, init?:RequestInit) => {
      if (url.endsWith('/v1/agent-sessions')) return new Response(JSON.stringify({session:session(),policy_cache_ttl_s:30}),{status:201,headers:{'Content-Type':'application/json'}});
      receipt=JSON.parse(String(init?.body));return new Response(JSON.stringify({trial_id:'trial-1',status:'completed',receipt_id:receipt.receipt_id,recorded:true}),{status:200,headers:{'Content-Type':'application/json'}});
    });
    const scenarioAssignment={...assignment,scenario:{...assignment.scenario,verifiers:[declaration]}};
    const environment:ScenarioEnvironment={prepare:async()=>{},cleanup:async()=>({status:'succeeded'}),verify:async rows=>rows.map(row=>evaluateAuthoritativeStateVerifier(row,{order:{status:'refunded'}},'fixture:order-1'))};
    await new OrloScenarioRunner(client(fetchMock)).run(scenarioAssignment,environment,async()=>({status:'completed',metrics:{turns:1,tool_calls:0,cost_usd:0}}));
    expect(receipt.verifier_results).toEqual([expect.objectContaining({verifier_key:'refund_state',status:'passed'})]);
  });
});
