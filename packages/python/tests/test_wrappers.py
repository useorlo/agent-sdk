# Unit tests for govern_tool against an in-memory fake session, with no HTTP calls and no
# langchain-core. They cover the approval flow: when Orlo requires approval, the wrapper opens an
# approval request and raises OrloApprovalRequired instead of running the tool.

from __future__ import annotations

import unittest
from uuid import uuid4

from orlo_langgraph.exceptions import OrloApprovalRequired
from orlo_langgraph.wrappers import govern_tool


class _FakeSession:
    def __init__(self) -> None:
        self._wrapped: set[str] = set()
        self.calls: list[tuple[str, dict]] = []

    def make_step_id(self, prefix: str, run_id: str | None = None) -> str:
        return f"{prefix}_{run_id or 'generated'}"

    def mark_wrapped(self, run_id: str | None) -> None:
        if run_id:
            self._wrapped.add(run_id)

    def claim_tool_run(self, run_id: str | None, names) -> bool:
        return False

    # Every step blocks, as with a server that doesn't send blocking_step_types.
    def is_blocking(self, step_type: str) -> bool:
        return True

    def fail_mode_for(self, action_class: str | None) -> str:
        return "closed"

    def report_step(self, payload: dict) -> None:
        self.calls.append(("report", payload))

    def report_import(self, payload: dict) -> None:
        self.calls.append(("import", payload))

    async def flush(self) -> None:
        return None

    async def govern_step(self, payload: dict):
        self.calls.append(("govern", payload))
        if payload["step_type"] == "tool_request":
            return {
                "decision": "require_approval",
                "reason": "Approval required",
                "containment": None,
                "trace_id": "trace-1",
            }
        return {
            "decision": "allow",
            "reason": None,
            "containment": None,
            "trace_id": "trace-1",
        }

    async def request_approval(self, step_id: str, payload: dict):
        self.calls.append(("approval", {"step_id": step_id, **payload}))
        return {"id": "approval-1"}


class _ApprovedOnRetrySession(_FakeSession):
    """Gates the first tool request and allows the next, as Orlo does once its approval is granted."""

    def make_step_id(self, prefix: str, run_id: str | None = None) -> str:
        return f"{prefix}_{run_id or uuid4().hex}"

    async def govern_step(self, payload: dict):
        gated = payload["step_type"] == "tool_request" and not self.tool_requests()
        self.calls.append(("govern", payload))
        return {
            "decision": "require_approval" if gated else "allow",
            "reason": "Approval required" if gated else None,
            "containment": None,
            "trace_id": "trace-1",
        }

    def tool_requests(self) -> list[dict]:
        return [call for kind, call in self.calls if kind == "govern" and call["step_type"] == "tool_request"]


class GovernToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_govern_tool_requests_approval_and_raises(self):
        session = _FakeSession()

        @govern_tool(session=session, tool_name="send_email", action_class="network")
        async def send_email(address: str) -> str:
            return address

        with self.assertRaises(OrloApprovalRequired) as blocked:
            await send_email("user@example.com")

        self.assertEqual(blocked.exception.step_id, "tool_generated")
        self.assertEqual(blocked.exception.approval, {"id": "approval-1"})

    async def test_retry_reuses_the_blocked_step_id_with_the_same_arguments(self):
        session = _ApprovedOnRetrySession()
        received: list[dict] = []

        @govern_tool(session=session, tool_name="issue_refund", action_class="write")
        async def issue_refund(order_id: str, **kwargs) -> str:
            received.append(kwargs)
            return order_id

        with self.assertRaises(OrloApprovalRequired) as blocked:
            await issue_refund("ord_123", amount_cents=4200)

        result = await issue_refund("ord_123", amount_cents=4200, orlo_step_id=blocked.exception.step_id)

        self.assertEqual(result, "ord_123")
        self.assertEqual(received, [{"amount_cents": 4200}])
        first, retry = session.tool_requests()
        self.assertEqual(retry["step_id"], first["step_id"])
        self.assertEqual(retry["request"], first["request"])


if __name__ == "__main__":
    unittest.main()
