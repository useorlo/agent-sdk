# orlo-langgraph

`orlo-langgraph` is the first Python adapter for connecting LangGraph or LangChain-based applications to Orlo agent governance.

It keeps the boundary clean:

- LangGraph owns orchestration
- your app owns tools and runtime behavior
- Orlo governs step execution, approvals, trace evidence, and policy decisions

## What it includes

- async HTTP client for Orlo agent-governance endpoints
- async session context manager
- callback handler for trace continuity
- governed model wrapper
- governed tool decorator
- typed blocked / approval-required exceptions

## What it does not do

- build or own your graph
- replace LangGraph runtime services
- capture hidden reasoning traces
- execute tools on Orlo's behalf

## Install and check the connection

Open **Connect your agent → Run the connection check** in the Orlo console. Copy the versioned Python download and `pip install` command into a Python 3.10+ virtual environment. No Orlo checkout or model-provider key is required. Registry publication is a separate release step; use the console download until it is verified.

Set `ORLO_API_URL` (gateway), `ORLO_ORG_ID`, `ORLO_TASK_ID`, `ORLO_CONSOLE_URL`, and `ORLO_API_KEY` using the values shown there. The key needs `agent_governance.run` and `agent_governance.read`.

```sh
python -m orlo_langgraph.check --expect blocked
```

Set the harmless `orlo_setup_check` tool's permission explicitly in the console, then repeat with `--expect allowed`. The command never changes permissions, calls a model, or changes external data. It prints the exact run and verification links. Missing reports, unexpected decisions, authentication failures, and unreachable gateways return a nonzero exit code. Every action stops when Orlo is unreachable.

For a LangGraph application, install `langgraph` alongside this package. The optional `[langgraph]` extra supplies LangChain Core callback classes; it does not install the graph runtime itself. A callback records evidence; use `govern_tool` around the actual tool implementation to stop execution before a denied call.

For development, run `pip install -e '.[langgraph]' langgraph` in this package directory.

## Quickstart

```python
import os

from orlo_langgraph import (
    OrloLangGraphClient,
    OrloLangGraphSession,
    OrloLangGraphCallbackHandler,
    create_governed_model,
    govern_tool,
)

client = OrloLangGraphClient(
    base_url="https://api.useorlo.com",  # your Orlo gateway
    org_id="00000000-0000-0000-0000-000000000001",
    headers={"Authorization": f"Bearer {os.environ['ORLO_API_KEY']}"},
)

async with OrloLangGraphSession(
    orlo_client=client,
    task_id="task-123",
    goal="Resolve a support escalation safely",
    framework="langgraph-python",
) as session:
    callbacks = [OrloLangGraphCallbackHandler(session=session)]

    model = create_governed_model(
        session=session,
        model=base_model,
        model_name="gpt-4.1-mini",
    )

    send_email = govern_tool(
        session=session,
        tool_name="send_email",
        action_class="network",
    )(send_email_impl)

    graph = compiled_graph.with_config({"callbacks": callbacks})
```

## Retrying after approval

When a tool policy requires approval, a `govern_tool` wrapper opens an approval and raises `OrloApprovalRequired`. The approval is bound to that exact call: the tool name plus its arguments. Once a reviewer decides, call the tool again with the same arguments and pass the blocked step id as the reserved `orlo_step_id` keyword:

```python
from orlo_langgraph import OrloApprovalRequired

try:
    await send_email("ops@example.com", subject="Escalation")
except OrloApprovalRequired as blocked:
    saved_step_id = blocked.step_id  # keep with your run state; blocked.approval["id"] is what the reviewer sees

# later, after the reviewer has decided
await send_email("ops@example.com", subject="Escalation", orlo_step_id=saved_step_id)
```

On that retry Orlo:

- allows the call if the approval was approved, consumes the approval, and records its id in the step's policy decision and an `approval:consumed` event. A second retry needs a new approval.
- raises `OrloGovernanceBlocked` with `decision="reject"`, citing the approval, if the reviewer rejected it.
- applies the approval's `timeout_action` if it expired: `reject` and `escalate` reject the call, `contain` contains it.
- raises `OrloApprovalRequired` again if the arguments changed, or if the approval belongs to another session.

`orlo_step_id` is never passed to your tool. The wrapper does not wait or poll for the decision: resume the run when your runtime learns of it, for example from an `approval:decided` event on the session's event stream.

## Development notes

- The adapter uses Python standard-library HTTP primitives by default.
- Wrapper-based governance owns hard pre-execution blocking.
- Callback-based governance owns trace continuity and post-step evidence when wrappers are not used.
- With the callback handler attached, each wrapped call is governed once. `govern_tool` adopts the LangChain tool run it executes as, and `GovernedChatModel` sets the run id of the LangChain model it calls, so the callback records those runs as trace events only. `govern_tool` adopts a run only when the LangChain tool's name matches its `tool_name` or the wrapped function's name; under any other name, the callback also governs the result.

## Timeouts, retries, and when Orlo is down

`OrloLangGraphClient` gives each attempt `timeout_seconds` (default 3.0) and retries once (`retries`, default 1) after a timeout, a network error, or a 5xx. Every write carries an `Idempotency-Key` that stays the same across its retries, so the API replays its first answer instead of recording the step twice. After `failure_threshold` consecutive failures (default 5) the client stops calling Orlo for `cooldown_seconds` (default 30) and raises `OrloUnavailableError`, a subclass of `OrloSessionError`.

When a tool check can't reach Orlo, the session's `fail_mode` for that action class decides. The default is `{"default": "closed"}`: every tool action stops. To deliberately allow reads during an outage, set `fail_mode={"read": "open", "default": "closed"}`. A read can disclose sensitive data; its action class is supplied by your application. Tools that read governed data always stop during an outage: mark them with `govern_tool(..., resource_bound=True)`, and any tool Orlo has answered with a resource contract or verified identity earlier in the session is treated the same way.

- `"open"`: the tool runs, and background reporting is attempted with `metadata.fail_open`. Delivery is not guaranteed.
- `"closed"`: `OrloUnavailableError` is raised and the tool doesn't run.

## Steps the wrapper doesn't wait for

When a session starts, Orlo returns `blocking_step_types`. `govern_tool` and `GovernedChatModel` wait only on those, and send other steps in the background. Orlo still records and checks them. `session.close()` waits for background steps first. Sync tools and `GovernedChatModel.invoke` send theirs before their event loop closes. `session.unsent_steps` counts steps that couldn't be sent even after retries. A server that doesn't return `blocking_step_types` gets the old behaviour: every step blocks.

## Reporting guarantees

Background reports use bounded retries in memory. There is no durable outbox or automatic replay after recovery. Closing or flushing waits for those attempts; it does not recover lost reports. Inspect `session.unsent_steps` before declaring evidence complete. Process termination can lose reports without leaving a count. If delivery must survive an outage or restart, the application needs its own persistent reporting mechanism.

The default changed from allowing reads during an outage to stopping all tool calls. Existing applications that require the old behavior must opt in explicitly.

## Register tools in one place

```python
from orlo_langgraph import GovernedToolRegistry, ToolDefinition

registry = GovernedToolRegistry(session, {
    "lookup_order": ToolDefinition(execute=lookup_order_impl, action_class="read"),
})
# Give these wrapped callables to your framework, never the raw implementations.
tools = list(registry.tools.values())
result = await registry.resolve("lookup_order")(order_id="123")
print(registry.describe())  # Names, action classes, and outage behavior for this mapping.
```

Unknown names are rejected. The tool mapping cannot be edited after registration. Async and sync implementations retain their wrapper behavior; use `orlo_step_id` with the original arguments to resume after approval. The inventory describes registered tools only. Other execution paths, host-provided tools, and arbitrary code remain outside this boundary. Callback traces alone do not prevent execution.


## Execution and business reports (unreleased)

These helpers require an Orlo server that returns `action_id` on governed steps. Use the 0.1.2 archive or later with the corresponding server update. Python refuses resource contracts; use the TypeScript resource executor for field and record limits.

Opt in to execution reporting to record whether a wrapped tool succeeded, failed, or was not executed because permission was refused. A successful return says nothing about the later business result. Your application reports that result explicitly and names the criterion it assessed.

```python
@govern_tool(session, 'refund', action_class='write', report_execution=True)
async def refund(order_id):
    return await issue_refund(order_id)

# With action_id from the governed tool request saved in your operation state:
await session.record_action_report(action_id, {
    'report_id': str(uuid4()), 'kind': 'business',
    'criterion': 'Customer issue resolved', 'outcome': 'unknown',
})
```

Keep the report ID and original values in your application state when retrying delivery. The server records each ID once; changed content under the same ID returns a conflict. Later reports append history, including after the run ends. They never alter permission or erase previous reports.

Automatic execution reports use the existing best-effort background queue. Flush before exit and inspect `session.unsent_steps`. Missing reports remain unknown, including fail-open calls without a saved action ID. A reporting failure does not replace a tool result or its error. For durable delivery, await the report receipt and use your application's persistent retry mechanism; do not rerun a tool just to resend its report.


## Measured permission context (unreleased)

When starting a run that should earn measured permission, set `metadata.permission_context` to `{ "model": "your-exact-model-revision", "runtime_version": "your-application-revision" }`. Declare shared skill versions through the existing `skill_versions` field. Keep those declarations accurate for the run; start a new run after changing the model, runtime, or skills. Orlo records these application declarations; it does not attest which external model your application called.

A member defines the argument conditions, starts measurement, and explicitly enables a qualifying configuration in the console. Outside those conditions or that configuration, approval is required. A suspension applies to subsequent permission checks in existing runs. It cannot recall a tool call already authorized and dispatched. Only a signed-in member can resume a suspended band; ordinary one-call approvals remain separate.

A governed action authorized by a measured band includes `policy_decision.permission_bands` with its permission revision, lifecycle revision, scope hash, and decision-time review bounds. These are judgments about permission, not proof that the tool ran or achieved its business outcome. Existing applications without measured bands retain their permission behavior.

## Multi-turn scenario trials (unreleased)

`OrloScenarioRunner` runs a frozen scenario through your existing agent and tools. Orlo supplies a one-trial credential and records governance evidence, but it does not download or execute your application code.

```python
runner = OrloScenarioRunner(client)

async def execute(context):
    result = await run_my_agent(context.session, context.scenario)
    return {
        "status": "completed",
        "metrics": {"turns": result.turns, "tool_calls": result.tool_calls, "cost_usd": result.cost_usd},
    }

await runner.run(assignment, test_environment, execute)
```

The environment must prepare isolated state and clean it up. A failed cleanup makes the trial invalid. The executor must respond to task cancellation so work stops at the declared deadline; Python cannot safely terminate arbitrary application code that suppresses cancellation. Budget excesses fail the trial.

Implement `environment.verify(declarations)` to read final state from the test system after the agent finishes. `evaluate_authoritative_state_verifier` applies the frozen JSON-pointer check and returns only the observed value needed for evidence. Orlo derives `permission_receipt` checks from its own governed steps, so the runner never supplies those results. Missing or contradictory mandatory evidence makes the trial invalid; a verified mismatch is a failed outcome.

If an approval pauses the agent, return `awaiting_approval` with the approval ID and an opaque checkpoint reference. Persist the agent state in your own runtime, then call the runner again with `ScenarioResume` after Orlo reports an approved decision. Do not place checkpoint contents or secrets in the reference.

Lifecycle receipts are idempotent. If `ScenarioTrialDeliveryError` is raised, persist its `receipt` and redeliver it with `record_scenario_trial_receipt`; do not rerun a tool or the whole scenario just to resend evidence. `run_scenario_trials` provides bounded local concurrency and retains the result or error for every assignment.

## Qualified production configurations (unreleased)

A passed confirmatory comparison can qualify one complete configuration. A person adopts it in the task's Changes area; the test does not change production on its own. If the task requires qualified configurations, provide the qualification ID and the exact manifest when the production session starts:

```python
async with OrloLangGraphSession(
    orlo_client=client,
    task_id=task_id,
    qualified_configuration={
        "qualification_id": qualification["id"],
        "manifest": qualification["manifest"],
    },
) as session:
    await run_agent(session)
```

Orlo checks the binding once and records it with the run. Changing the artifact, model settings, task version, shared skills, source set, tool schemas, or permission specification needs new evidence. Qualification does not grant permission; current rules, revocations, approvals, and containment still apply to each action.
