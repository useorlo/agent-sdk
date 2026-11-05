/** Token callbacks supply application tokens only when needed; refreshed transport does not retain token text. */
import {it,expect,vi} from 'vitest';
import {OrloAgentClient} from './index.js';
const token=(iat:number,exp:number)=>`header.${Buffer.from(JSON.stringify({iat,exp})).toString('base64url')}.signature`;
it('gets identity at session start and refreshes near expiry without resending the same token',async()=>{
  const now=Math.floor(Date.now()/1000),first=token(now,now+60),second=token(now+1,now+3600);
  const identityTokenProvider=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({session:{id:'session'}})).mockImplementation(async()=>Response.json({decision:'allow'}));
  const client=new OrloAgentClient({baseUrl:'https://orlo.test',orgId:'org',identityTokenProvider,fetch,retries:0});
  await client.createSession({task_id:'task'});
  const step={step_id:'step',step_type:'tool_request' as const};
  await client.governStep('session',step);await client.governStep('session',step);await client.governStep('session',step);
  expect(identityTokenProvider).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetch.mock.calls[0][1].body).identity_token).toBe(first);
  expect(JSON.parse(fetch.mock.calls[1][1].body).identity_token).toBeUndefined();
  expect(JSON.parse(fetch.mock.calls[2][1].body).identity_token).toBe(second);
  expect(JSON.parse(fetch.mock.calls[3][1].body).identity_token).toBeUndefined();
});
it('retries the same token after unknown bootstrap identity and bounds repeated recovery attempts',async()=>{
  vi.useFakeTimers();
  try{
    const now=Math.floor(Date.now()/1000),raw=token(now,now+3600);
    const identityTokenProvider=vi.fn().mockResolvedValue(raw);
    const unknown={source:'unknown',claim_names:[],reason:'IDENTITY_KEYS_STALE',retryable:true};
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({session:{id:'session'},resource_identity:unknown}))
      .mockResolvedValueOnce(Response.json({decision:'reject',resource_identity:unknown}))
      .mockResolvedValueOnce(Response.json({decision:'reject',resource_identity:unknown}))
      .mockImplementation(async()=>Response.json({decision:'allow',resource_identity:{source:'authentication_verified',claim_names:[]}}));
    const client=new OrloAgentClient({baseUrl:'https://orlo.test',orgId:'org',identityTokenProvider,fetch,retries:0});
    await client.createSession({task_id:'task'});
    const step={step_id:'step',step_type:'tool_request' as const};
    await client.governStep('session',step);
    await client.governStep('session',step);
    expect(identityTokenProvider).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body).identity_token).toBe(raw);
    expect(JSON.parse(fetch.mock.calls[2][1].body).identity_token).toBeUndefined();
    vi.advanceTimersByTime(1000);
    await client.governStep('session',step);await client.governStep('session',step);
    expect(identityTokenProvider).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[3][1].body).identity_token).toBe(raw);
    expect(JSON.parse(fetch.mock.calls[4][1].body).identity_token).toBeUndefined();
  }finally{vi.useRealTimers();}
});
it('re-presents identity after a trust change without replaying the refused action',async()=>{
  const now=Math.floor(Date.now()/1000),raw=token(now,now+3600),identityTokenProvider=vi.fn().mockResolvedValue(raw);
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({session:{id:'session'}}))
    .mockResolvedValueOnce(Response.json({decision:'reject',resource_identity:{source:'unknown',claim_names:[],reason:'IDENTITY_TRUST_CHANGED',retryable:true}}))
    .mockResolvedValueOnce(Response.json({decision:'allow',resource_identity:{source:'authentication_verified',claim_names:[]}}));
  const client=new OrloAgentClient({baseUrl:'https://orlo.test',orgId:'org',identityTokenProvider,fetch,retries:0});
  await client.createSession({task_id:'task'});
  expect((await client.governStep('session',{step_id:'one',step_type:'tool_request'})).decision).toBe('reject');
  expect(fetch).toHaveBeenCalledTimes(2);
  await client.governStep('session',{step_id:'next',step_type:'tool_request'});
  expect(JSON.parse(fetch.mock.calls[2][1].body).identity_token).toBe(raw);
});
