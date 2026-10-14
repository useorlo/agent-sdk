# @orlo/agent-sdk

Thin wrapper SDK for Orlo agent-step governance.

## Purpose

This package is the developer-facing adoption surface for Orlo agent governance.
It wraps the raw HTTP API with:

- session bootstrap
- semantic step helpers
- tool-check helpers
- optional approval auto-requesting
- a small callback surface that frameworks can adapt to
- a generic JS runtime adapter for wrapping ordinary async model/tool functions

## Install and check the connection

Open **Connect your agent → Run the connection check** in the Orlo console. Copy its versioned SDK download and installation command. The download is self-contained; it needs no Orlo checkout. Requires Node.js 20 or later.

Set `ORLO_API_URL` (gateway), `ORLO_ORG_ID`, `ORLO_TASK_ID`, `ORLO_CONSOLE_URL`, and `ORLO_API_KEY` using the values shown there. The key needs `agent_governance.run` and `agent_governance.read`.

```sh
npx --no-install orlo-agent-check --expect blocked
```

The check wraps a harmless local tool named `orlo_setup_check`. It makes no model call and changes no permissions. Set that tool's permission explicitly in the console, then repeat with `--expect allowed`. Inherited restrictions still apply. The command prints links to the exact run and its verification page. Missing reports, a rejected key, an unreachable gateway, or an unexpected decision return a nonzero exit code. Every action stops if Orlo is unreachable.

The package is not yet published on npm. Do not substitute a registry installation command for the console download. For development in this repository, build `@orlo/agent-sdk` with npm workspaces. The SDK has no dependency on private Orlo packages.

## Minimal usage

Point `baseUrl` at an Orlo gateway and send a runtime API key for the org. The key decides the org, and the gateway signs each request it forwards; the API refuses requests that reach it without that signature.

```ts
import { OrloAgentClient, OrloAgentRun, createOrloStepCallbacks, createStepId } from '@orlo/agent-sdk';

const client = new OrloAgentClient({
  baseUrl: 'https://orlo.example.com', // your Orlo gateway
  orgId: '00000000-0000-0000-0000-000000000001',
  headers: { Authorization: `Bearer ${process.env.ORLO_API_KEY}` },
});

const run = await OrloAgentRun.start(client, {
  task_id: 'task-123',
  framework: 'custom-js-runtime',
  goal: 'Resolve a support escalation safely',
});

const callbacks = createOrloStepCallbacks({ run, autoRequestApproval: true });

await callbacks.beforeModelCall({
  step_id: createStepId('llm'),
  model_name: 'gpt-4.1-mini',
  input: { messages: [{ role: 'user', content: 'Summarize the case' }] },
});
```

## Design constraints

- No runtime dependency on third-party HTTP clients
- No framework lock-in
- No orchestration ownership
- Semantic helpers over raw endpoint construction

## Generic runtime adapter

The generic runtime adapter is the first thin veneer above the SDK. It wraps normal async model and tool functions, applies Orlo governance before and after execution, and throws a typed error if Orlo blocks the step.

```ts
import {
  OrloAgentClient,
  OrloAgentRun,
  OrloGovernanceBlockedError,
  createGenericRuntimeAdapter,
} from '@orlo/agent-sdk';

const client = new OrloAgentClient({
  baseUrl: 'https://orlo.example.com', // your Orlo gateway
  orgId: '00000000-0000-0000-0000-000000000001',
  headers: { Authorization: `Bearer ${process.env.ORLO_API_KEY}` },
});

const run = await OrloAgentRun.start(client, {
  task_id: 'task-123',
  framework: 'custom-js-runtime',
  goal: 'Resolve a support escalation safely',
});

const runtime = createGenericRuntimeAdapter({ run, autoRequestApproval: true });

try {
  const result = await runtime.runToolStep({
    stepId: 'tool_send_email',
    toolName: 'send_email',
    actionClass: 'network',
    arguments: { to: 'ops@example.com', subject: 'Escalation' },
    execute: async (args) => sendEmail(args),
  });

  console.log(result.output);
} catch (error) {
  if (error instanceof OrloGovernanceBlockedError) {
    console.error(error.decision, error.reason, error.approval?.id);
  }
}
```

## Shared skills

Load exact published versions from the organization's library before starting an agent. Add `skills.read` to the runtime key's agent scopes. The SDK verifies each content hash and the server records the declared versions on the run.

```ts
const { run, instructions, skills } = await OrloAgentRun.startWithSkills(
  client,
  { task_id, framework: 'custom-js-runtime', goal: 'Triage a support ticket' },
  [{ skillId, versionId }],
);
const runtime = createGenericRuntimeAdapter({ run });
// Pass instructions to your model. Wrap model and tool calls with runtime.
// skills contains the original content and supporting files; scripts are not executed.
```

Changing a skill's published default does not change these pinned versions. Skill instructions grant no tool permissions. Run attribution records the versions the agent declared; the application is responsible for passing those instructions to its model.

This package also provides `orlo-skills install --skill <id> --version <id> --project <directory>` for project-scoped Claude Code skills. Set `ORLO_API_URL`, `ORLO_ORG_ID`, and `ORLO_API_KEY` (`skills.read`). Add `--replace` to explicitly switch versions; the installer preserves older files and refuses to overwrite local skills. Run `orlo-skills --help` for installer options. On Windows, directory symlinks require Developer Mode or elevation. The console download includes this command. Source is available in this repository; npm publication is a separate release step.

## Retrying after approval

When a tool policy requires approval, `runToolStep` (or `beforeToolCall` with `autoRequestApproval`) opens an approval and throws `OrloGovernanceBlockedError` with `decision: 'require_approval'`. The approval is bound to that exact call: the tool name plus its arguments.

To continue once a reviewer decides, run the step again with the original `stepId` and the same arguments:

```ts
const args = { order_id: 'ord_123', amount_cents: 4200 };

try {
  await runtime.runToolStep({ stepId: 'tool_issue_refund', toolName: 'issue_refund', actionClass: 'write', arguments: args, execute: issueRefund });
} catch (error) {
  if (error instanceof OrloGovernanceBlockedError && error.decision === 'require_approval') {
    // Keep error.stepId and args with your run state; error.approval?.id is what the reviewer sees.
  }
}

// Later, after the reviewer has decided:
await runtime.runToolStep({ stepId: 'tool_issue_refund', toolName: 'issue_refund', actionClass: 'write', arguments: args, execute: issueRefund });
```

On that retry Orlo:

- allows the call if the approval was approved, consumes the approval, and records its id in the step's policy decision and an `approval:consumed` event. A second retry needs a new approval.
- rejects the call, citing the approval, if the reviewer rejected it.
- applies the approval's `timeout_action` if it expired: `reject` and `escalate` reject the call, `contain` contains it.
- asks for a new approval if the arguments changed, or if the approval belongs to another session.

A retry under a new step id with the same tool and arguments also matches, but reusing `stepId` keeps the trace readable. The SDK does not wait or poll for the decision: resume the run when your runtime learns of it, for example from an `approval:decided` event on the session's event stream.

## Timeouts, retries, and when Orlo is down

`OrloAgentClient` gives each attempt `timeoutMs` (default 3000) and retries once (`retries`, default 1) after a timeout, a network error, or a 5xx. Every write carries an `Idempotency-Key` that stays the same across its retries, so the API replays its first answer instead of recording the step twice. After `circuitBreaker.failureThreshold` consecutive failures (default 5) the client stops calling Orlo for `cooldownMs` (default 30 s) and throws `OrloUnavailableError` straight away.

When a tool check can't reach Orlo, the run's fail mode for that action class decides:

```ts
const run = await OrloAgentRun.start(client, { task_id }, {
  failMode: { read: 'open', default: 'closed' }, // the default
});
```

- `open`: the call runs, `beforeToolCall` returns `failedOpen: true`, and the step is imported with `metadata.fail_open` once Orlo answers again.
- `closed`: `OrloUnavailableError` is thrown and the tool doesn't run.

## Steps the SDK doesn't wait for

When a session starts, Orlo returns `blocking_step_types`: the steps whose answer can change what the agent does. Tool requests and retrieval always block. Model outputs and tool results block only when the task has rules or result schemas to check them against. The generic runtime adapter sends every other step in the background with `run.report()`. Orlo still records and checks those steps, but the agent doesn't wait, so `pre` or `post` is `null` in the result.

`run.complete()` waits for background steps first. Call `run.flush()` yourself before a process exits without completing the run. `run.unsentSteps` counts steps that couldn't be sent even after retries. A server that doesn't return `blocking_step_types` gets the old behaviour: every step blocks.

### Adding a saved step to examples

`promoteTraceSampleToDataset(traceSampleId, datasetId)` treats `datasetId` as the latest baseline. It creates a new version containing the baseline examples plus the saved step. Use `result.dataset.id` for the next comparison; the supplied dataset remains unchanged. A stale baseline returns `DATASET_BASE_CHANGED` (409). Refresh the examples and review the new baseline before retrying.

Repeated promotion of the same step returns `already_added: true` and the version where it was first added, with `dataset_sample_id: null`. This also applies when two saved samples refer to the same run step.
