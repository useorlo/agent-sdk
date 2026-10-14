#!/usr/bin/env node
/** Run one harmless tool through the real wrapper. This command never creates or changes permissions. */
import { parseArgs } from 'node:util';
import { OrloAgentClient, OrloAgentRun, OrloGovernanceBlockedError, createGenericRuntimeAdapter } from './index.js';

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { expect: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('orlo-agent-check --expect blocked|allowed\nSet ORLO_API_URL, ORLO_ORG_ID, ORLO_TASK_ID, ORLO_API_KEY and ORLO_CONSOLE_URL. No model key is needed. Permissions are never changed.');
    return;
  }
  if (!['blocked', 'allowed'].includes(values.expect ?? '')) throw new Error('Choose --expect blocked or --expect allowed.');
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`Set ${name} before running the check.`); return value; };
  const baseUrl = required('ORLO_API_URL'), orgId = required('ORLO_ORG_ID'), taskId = required('ORLO_TASK_ID'), key = required('ORLO_API_KEY');
  const consoleUrl = new URL(required('ORLO_CONSOLE_URL'));
  for (const url of [new URL(baseUrl), consoleUrl]) {
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use HTTPS addresses, or HTTP on localhost, without credentials or query parameters.');
  }
  for (const id of [orgId, taskId]) if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('ORLO_ORG_ID and ORLO_TASK_ID must be UUIDs from setup.');
  const client = new OrloAgentClient({ baseUrl, orgId, headers: { Authorization: `Bearer ${key}` }, fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
  const run = await OrloAgentRun.start(client, { task_id: taskId, goal: 'Check the Orlo wrapper', framework: 'orlo-connection-check', metadata: { expected_outcome: values.expect } }, { failMode: { default: 'closed', read: 'closed' } });
  const setup = new URL('/setup', consoleUrl); setup.search = new URLSearchParams({ task: taskId, step: 'agent', check_run: run.sessionId }).toString();
  const inspect = new URL('/runs', consoleUrl); inspect.search = new URLSearchParams({ agent: taskId, run: run.sessionId }).toString();
  console.log(`Run: ${inspect.href}\nVerify this check: ${setup.href}`);
  const runtime = createGenericRuntimeAdapter({ run, autoRequestApproval: false });
  let executed = false, decision = '', finished = false;
  try {
    try {
      const result = await runtime.runToolStep({ stepId: 'orlo-setup-check', toolName: 'orlo_setup_check', actionClass: 'read', arguments: {}, execute: async () => { executed = true; return { ok: true }; } });
      decision = result.pre.governance.decision;
    } catch (error) {
      if (!(error instanceof OrloGovernanceBlockedError) || executed) throw error;
      decision = error.decision;
      await run.recordDecision({ step_id: 'orlo-setup-receipt', input: { request_step_id: 'orlo-setup-check', applied_decision: decision, tool_executed: false } });
    }
    await runtime.close(executed ? 'completed' : 'cancelled'); finished = true;
    if (run.unsentSteps) throw new Error('Some wrapper reports could not be delivered. Inspect the run and retry.');
    console.log(`Decision: ${decision}. Local tool ${executed ? 'ran and returned {ok:true}' : 'did not run'}.`);
    if (decision === 'require_approval') console.log('This sample did not request approval. Review the tool permission; use Allow or Block for these two checks.');
    if ((values.expect === 'allowed') !== executed) throw new Error(`Expected ${values.expect}, received ${decision}. Review this agent’s permission for orlo_setup_check, then rerun. The command did not change permissions.`);
    console.log('Open the verification link to confirm Orlo received the matching wrapper report. This checks one tool only.');
  } finally {
    if (!finished) await runtime.close('failed').catch(() => {});
  }
}

if (require.main === module) main().catch((error: unknown) => { console.error(`Check incomplete: ${error instanceof Error ? error.message : 'Unexpected failure'}`); console.error('Check the gateway address, key, organization, task, and run limits. Inspect the run if one was created.'); process.exitCode = 1; });
