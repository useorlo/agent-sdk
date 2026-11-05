/** Resource executors refuse unknown contracts and unsupported limits before any external operation. */
import {it,expect,vi} from 'vitest';
import {createToolRegistry} from './tool-registry.js';
import {OrloAgentClient,OrloAgentRun} from './index.js';
const resource={version:1 as const,resource_type:'profile',operation:'read'};
const contract={version:1,resource,access_limits:{allowed_fields:['name'],max_rows:1},policy_versions:[{id:'policy',version:1}],authorization_hash:'a'.repeat(64)};
function fixture(response:any,supported=['allowed_fields','max_rows'],attest:(limits:any)=>void=limits=>limits.applied()){
  const execute=vi.fn(async(_args,_contract,limits)=>{attest(limits);return [{name:'Alice'}];});
  const run={beforeToolCall:vi.fn(async()=>({governance:{decision:'allow',action_id:'action',...response}})),isBlocking:()=>false,reportAction:vi.fn(),report:vi.fn(),failModeFor:()=> 'open'};
  const registry=createToolRegistry({run:run as any,tools:{profile:{actionClass:'read',resource:{resolve:()=>resource,supportedLimitTypes:supported},execute}}});
  return {execute,run,registry};
}
it('passes immutable exact limits to the handler and reports only safe outcome metadata',async()=>{
  const f=fixture({resource_contract:structuredClone(contract)});
  expect(await f.registry.invoke('profile',{}, {stepId:'one'})).toEqual([{name:'Alice'}]);
  const received=f.execute.mock.calls[0][1];expect(Object.isFrozen(received.access_limits)).toBe(true);
  expect(f.run.reportAction.mock.calls[0][1].resource_access.status).toBe('applied');
  expect(JSON.stringify(f.run.report.mock.calls)).not.toContain('Alice');
  expect(f.registry.describe()[0].whenUnavailable).toBe('stop');
});
it('never executes absent, wrong-version, mismatched, or unsupported contracts',async()=>{
  for(const response of [{},{resource_contract:{...contract,version:2}},{resource_contract:{...contract,access_limits:{allowed_fields:[]}}},{resource_contract:{...contract,access_limits:{unsupported:'field'}}},{resource_contract:{...contract,resource:{...resource,operation:'write'}}}]){
    const f=fixture(response);await expect(f.registry.invoke('profile',{}, {stepId:'one'})).rejects.toThrow('RESOURCE_CONTRACT');expect(f.execute).not.toHaveBeenCalled();
  }
  const f=fixture({resource_contract:contract},[]);await expect(f.registry.invoke('profile',{}, {stepId:'one'})).rejects.toThrow('RESOURCE_LIMIT_UNSUPPORTED');expect(f.execute).not.toHaveBeenCalled();
});
it('forces stop on resource reads even when ordinary reads explicitly fail open',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({session:{id:'session'},blocking_step_types:['tool_request']})).mockRejectedValue(new Error('offline'));
  const client=new OrloAgentClient({baseUrl:'https://orlo.test',orgId:'org',fetch,retries:0});
  const run=await OrloAgentRun.start(client,{task_id:'task'},{failMode:{read:'open'}});
  await expect(run.beforeToolCall({step_id:'step',tool_name:'profile',action_class:'read',resource,arguments:{}})).rejects.toThrow();
});
it('reports limits as applied only when the handler says so',async()=>{
  const status=async(attest:(limits:any)=>void)=>{const f=fixture({resource_contract:structuredClone(contract)},undefined,attest);await f.registry.invoke('profile',{}, {stepId:'one'});return f.run.reportAction.mock.calls[0][1].resource_access;};
  expect(await status(()=>{})).toMatchObject({status:'unknown',limit_types:['allowed_fields','max_rows']});
  expect((await status(()=>{})).applied_limit_types).toBeUndefined();
  expect(await status(l=>l.applied(['max_rows','invented']))).toMatchObject({status:'unknown',applied_limit_types:['max_rows']});
  expect(await status(l=>l.applied(['allowed_fields','max_rows']))).toMatchObject({status:'applied'});
  const failing=fixture({resource_contract:structuredClone(contract)},undefined,l=>{l.applied();throw new Error('source down');});
  await expect(failing.registry.invoke('profile',{}, {stepId:'one'})).rejects.toThrow('source down');
  expect(failing.run.reportAction.mock.calls[0][1].resource_access.status).toBe('failed');
});
