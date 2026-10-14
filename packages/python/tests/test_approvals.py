"""Approval recovery polls one ID, stays bounded, and never executes the waiting tool."""
import asyncio
import unittest
from orlo_langgraph import OrloLangGraphSession, OrloLangGraphClient, OrloApprovalTimeoutError, OrloSessionError

class ApprovalTests(unittest.IsolatedAsyncioTestCase):
    def client(self, transport):
        return OrloLangGraphClient(base_url="https://orlo.test", org_id="org-1", transport=transport, retries=0)

    async def test_final_states_after_outage_and_pending(self):
        for status in ("approved", "rejected", "expired"):
            calls = []
            def transport(method, url, headers, payload):
                calls.append((method, url, payload))
                if len(calls) == 1:
                    raise ConnectionError("offline")
                return {"id": "approval-1", "status": "pending" if len(calls) == 2 else status}
            result = await self.client(transport).wait_for_approval("approval-1", poll_interval_seconds=0.001)
            self.assertEqual(result["status"], status)
            self.assertTrue(all(call == ("GET", "https://orlo.test/v1/agent-approvals/approval-1", None) for call in calls))

    async def test_timeout_and_cancel_do_not_decide(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return {"id": "approval-1", "status": "pending"}
        client = self.client(transport)
        with self.assertRaises(OrloApprovalTimeoutError):
            await client.wait_for_approval("approval-1", timeout_seconds=0.01)
        waiting = asyncio.create_task(client.wait_for_approval("approval-1"))
        await asyncio.sleep(0.01)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        count = len(calls)
        await asyncio.sleep(0.01)
        self.assertEqual(len(calls), count)

    async def test_bad_status_identity_and_auth_fail_immediately(self):
        for payload in ({"id": "other", "status": "approved"}, {"id": "approval-1", "status": "allow"}):
            with self.assertRaises(OrloSessionError):
                await self.client(lambda *args: payload).get_approval("approval-1")
        def denied(*args):
            raise OrloSessionError("Forbidden")
        with self.assertRaisesRegex(OrloSessionError, "Forbidden"):
            await self.client(denied).wait_for_approval("approval-1")

    async def test_invalid_intervals(self):
        for timeout in (0, -1, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                await self.client(lambda *args: None).wait_for_approval("approval-1", timeout_seconds=timeout)

    async def test_resume_does_not_create_or_reopen_a_session(self):
        calls = []
        status = "paused"
        def transport(method, url, headers, payload):
            calls.append((method, url))
            return {"session": {"id": "session-1", "task_id": "task-1", "status": status}}
        client = self.client(transport)
        resumed = await OrloLangGraphSession.resume(client, "session-1")
        self.assertIs(await resumed.__aenter__(), resumed)
        self.assertEqual(resumed.require_session_id(), "session-1")
        self.assertEqual(calls, [("GET", "https://orlo.test/v1/agent-sessions/session-1")])
        status = "completed"
        with self.assertRaises(OrloSessionError):
            await OrloLangGraphSession.resume(client, "session-1")
