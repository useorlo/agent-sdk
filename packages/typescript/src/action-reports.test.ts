/** Optional execution reports preserve tool results/errors and keep later business outcomes explicit. */
import {it,expect,vi} from 'vitest';
import {OrloAgentClient,OrloAgentRun,createGenericRuntimeAdapter} from './index.js';
function fixture(decision='allow',reportsFail=false) {
  const sent:Array<{path:string;body:any}>=[];
  const client=new OrloAgentClient({baseUrl:'https://orlo.test',orgId:'org',retries:0,circuitBreaker:false,fetch:vi.fn(async(url,init)=>{
    const path=String(url),body=init?.body?JSON.parse(String(init.body)):null;sent.push({path,body});
    if(path.endsWith('/agent-sessions'))return Response.json({session:{id:'run'},blocking_step_types:['tool_request']});
    if(path.endsWith('/steps/govern'))return Response.json({decision:body.step_type==='tool_request'?decision:'allow',action_id:'action',reason:null});
    if(path.endsWith('/reports'))return Response.json({report_id:body.report_id,source:'application_report'},{status:reportsFail?503:200});
    return Response.json({});
  })});
  return {client,sent};
}
it('reports execution only when opted in and does not infer a business outcome',async()=>{
  const {client,sent}=fixture();const run=await OrloAgentRun.start(client,{task_id:'task'});
  const input={stepId:'one',toolName:'refund',arguments:{amount:50},execute:async()=>({ok:true})};
  await createGenericRuntimeAdapter({run}).runToolStep(input);await run.flush();expect(sent.filter(r=>r.path.endsWith('/reports'))).toHaveLength(0);
  const result=await createGenericRuntimeAdapter({run,reportExecution:true}).runToolStep({...input,stepId:'two'});await run.flush();
  expect(result.output).toEqual({ok:true});
  const reports=sent.filter(r=>r.path.endsWith('/reports'));expect(reports).toHaveLength(1);expect(reports[0].body).toMatchObject({kind:'execution',outcome:'succeeded'});
  expect(reports[0].path).toContain('/actions/action/reports');
  await run.recordActionReport('action',{report_id:'stable-id',kind:'business',criterion:'Issue resolved',outcome:'unknown'});
  expect(sent.at(-1)?.body.report_id).toBe('stable-id');
});
it('keeps execution errors intact even when reporting fails and reports blocked calls as not executed',async()=>{
  const {client,sent}=fixture('allow',true);const run=await OrloAgentRun.start(client,{task_id:'task'});
  const error=new Error('Tool failed');
  await expect(createGenericRuntimeAdapter({run,reportExecution:true}).runToolStep({stepId:'one',toolName:'refund',arguments:{},execute:async()=>{throw error;}})).rejects.toBe(error);
  await run.flush();expect(run.unsentSteps).toBe(1);expect(sent.find(r=>r.path.endsWith('/reports'))?.body.outcome).toBe('failed');
  const blocked=fixture('reject');const blockedRun=await OrloAgentRun.start(blocked.client,{task_id:'task'});const execute=vi.fn();
  await expect(createGenericRuntimeAdapter({run:blockedRun,reportExecution:true}).runToolStep({stepId:'one',toolName:'refund',arguments:{},execute})).rejects.toThrow();
  await blockedRun.flush();expect(execute).not.toHaveBeenCalled();expect(blocked.sent.find(r=>r.path.endsWith('/reports'))?.body.outcome).toBe('not_executed');
});
