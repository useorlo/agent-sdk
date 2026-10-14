# Resume work after an approval

These helpers are in source for the next SDK release. Published TypeScript 0.0.2 and Python 0.1.1 do not contain them. Deploy an API with `GET /v1/agent-approvals/:id` before upgrading clients.

Persist the organization, session ID, step ID, approval ID, tool name, action class, and exact arguments when a wrapper raises an approval-required error. Keep that session open. An approval is scoped to that session, step, and request; starting another run does not resume it.

## TypeScript

Given the `client`, `runtime`, and `toolStep` used for the original call:

```ts
import { OrloGovernanceBlockedError, OrloApprovalTimeoutError } from '@orlo/agent-sdk';

try {
  await runtime.runToolStep(toolStep);
} catch (error) {
  if (!(error instanceof OrloGovernanceBlockedError) || error.decision !== 'require_approval' || !error.approval) throw error;
  // Save error.approval.id, run.sessionId, error.stepId, and toolStep in your durable run state.
  try {
    const approval = await client.waitForApproval(error.approval.id, {
      timeoutMs: 300_000, pollIntervalMs: 2_000, signal: shutdown.signal,
    });
    if (approval.status === 'approved' && !approval.consumed_at) {
      await runtime.runToolStep(toolStep); // Same session, step ID, and arguments; still asks Orlo.
    } else {
      // Hand back to your workflow for rejection, expiry, or an already consumed approval.
    }
  } catch (waitError) {
    if (!(waitError instanceof OrloApprovalTimeoutError)) throw waitError;
    // The local wait ended. Save the checkpoint; do not execute the tool.
  }
}
```

`shutdown` is your application's `AbortController`. Cancellation stops waiting without deciding or cancelling the approval. The default total timeout is five minutes; successful pending reads are two seconds apart. Temporary transport failures back off up to ten seconds within that deadline. Authentication, permission, missing approval, and invalid response errors stop immediately.

After a webhook or process restart, use `await client.getApproval(savedApprovalId)`. To rebuild the governed wrapper, use `await OrloAgentRun.resume(client, savedSessionId)`, then `createGenericRuntimeAdapter({ run })`. Resume refuses completed or otherwise closed sessions, creates no new session, and conservatively waits for every reported step. Restore your tool implementation from trusted application code and use the saved step ID and arguments.

## Python

For an in-process wait, keep the original session open and catch the approval-required exception around the governed tool:

```python
from orlo_langgraph import OrloApprovalRequired, OrloApprovalTimeoutError

try:
    await send_email("ops@example.com", subject="Escalation", orlo_step_id="send-1")
except OrloApprovalRequired as blocked:
    if not blocked.approval:
        raise
    # Persist session, step, approval, and exact call arguments before waiting.
    try:
        approval = await client.wait_for_approval(blocked.approval["id"], timeout_seconds=300)
    except OrloApprovalTimeoutError:
        approval = None  # Keep the checkpoint and the session open for later recovery.
    if approval and approval["status"] == "approved" and not approval.get("consumed_at"):
        await send_email("ops@example.com", subject="Escalation", orlo_step_id=blocked.step_id)
```

For durable workflows, catch the wait timeout without leaving a context that completes or fails the session. Restore it later with `await OrloLangGraphSession.resume(client, saved_session_id)` and rebuild the governed tool against that session. `get_approval(id)` reads current status without waiting. Cancel the asyncio task to stop a wait. An HTTP read already running in a worker thread can finish afterwards, subject to the client's HTTP timeout; no tool is run by the waiter.

## Delivery and recovery

Subscribe to signed `approval.approved`, `approval.rejected`, and `approval.expired` webhooks for long-lived jobs. Save the event durably, acknowledge it, and queue a worker; do not hold the webhook request while the tool runs. Deduplicate by event ID. Read the current approval before resuming because deliveries can be repeated or delayed. Existing webhook subscriptions must opt into the new decision events.

A notification is not a reusable permission token. On retry, Orlo checks the original request and current session state, then consumes an applicable approval. It still may stop the call. A consumed approval does not prove the tool completed: a process can fail after authorization but before the external operation. Use the external service's idempotency key and your own durable result record to reconcile that case. Do not blindly execute or create a new step after a timeout.

These helpers need `agent_governance.read`; running the governed step also needs `agent_governance.run`.
