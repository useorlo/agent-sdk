# Optional execution reports preserve the tool result and keep business outcomes explicit.
from __future__ import annotations

import unittest
from uuid import uuid4

from orlo_langgraph.client import OrloLangGraphClient
from orlo_langgraph.exceptions import OrloGovernanceBlocked, OrloSessionError
from orlo_langgraph.session import OrloLangGraphSession
from orlo_langgraph.wrappers import govern_tool


class ReportTransport:
    def __init__(self, decision="allow", reports_fail=False, legacy=False):
        self.decision, self.reports_fail, self.legacy = decision, reports_fail, legacy
        self.reports = []

    def __call__(self, method, url, headers, payload):
        if url.endswith("/agent-sessions"):
            return {"session": {"id": "run"}, "blocking_step_types": ["tool_request"]}
        if url.endswith("/steps/govern"):
            return {"decision": self.decision, **({} if self.legacy else {"action_id": "action"})}
        if url.endswith("/reports"):
            self.reports.append((url, payload))
            if self.reports_fail:
                raise ConnectionError("Report unavailable")
            return {"report_id": payload["report_id"], "source": "application_report"}
        return {}


class ActionReportTests(unittest.IsolatedAsyncioTestCase):
    async def start(self, transport):
        client = OrloLangGraphClient(base_url="https://orlo.test", org_id="org", transport=transport, retries=0)
        session = OrloLangGraphSession(orlo_client=client, task_id="task")
        await session.__aenter__()
        return session

    async def test_opt_in_execution_and_separate_durable_business_report(self):
        transport = ReportTransport()
        session = await self.start(transport)

        async def refund(amount):
            return amount

        self.assertEqual(await govern_tool(session, "refund")(refund)(50), 50)
        await session.flush()
        self.assertFalse(transport.reports)
        self.assertEqual(await govern_tool(session, "refund", report_execution=True)(refund)(50), 50)
        await session.flush()
        self.assertEqual(transport.reports[0][1]["outcome"], "succeeded")
        report_id = str(uuid4())
        receipt = await session.record_action_report("action", {"report_id": report_id, "kind": "business", "criterion": "Issue resolved", "outcome": "unknown"})
        self.assertEqual(receipt["report_id"], report_id)
        self.assertTrue(transport.reports[-1][0].endswith("/actions/action/reports"))

    async def test_report_failure_preserves_tool_error_and_missing_server_support_stops_execution(self):
        transport = ReportTransport(reports_fail=True)
        session = await self.start(transport)
        error = RuntimeError("Tool failed")

        async def refund():
            raise error

        with self.assertRaises(RuntimeError) as raised:
            await govern_tool(session, "refund", report_execution=True)(refund)()
        self.assertIs(raised.exception, error)
        await session.flush()
        self.assertEqual(session.unsent_steps, 1)
        self.assertEqual(transport.reports[0][1]["outcome"], "failed")
        legacy = await self.start(ReportTransport(legacy=True))
        with self.assertRaises(OrloSessionError):
            await govern_tool(legacy, "refund", report_execution=True)(refund)()

    async def test_blocked_tool_reports_not_executed(self):
        transport = ReportTransport(decision="reject")
        session = await self.start(transport)
        ran = []

        async def refund():
            ran.append(True)

        with self.assertRaises(OrloGovernanceBlocked):
            await govern_tool(session, "refund", report_execution=True)(refund)()
        await session.flush()
        self.assertFalse(ran)
        self.assertEqual(transport.reports[0][1]["outcome"], "not_executed")
