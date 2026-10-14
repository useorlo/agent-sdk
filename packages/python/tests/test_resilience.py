# Tests for how the adapter behaves when Orlo is slow or unreachable, and for which steps it waits
# on Orlo's answer. Covers OrloLangGraphClient, OrloLangGraphSession, and govern_tool on async and
# sync tools. ScriptedTransport stands in for Orlo's HTTP API and can time out or refuse
# connections on cue.

from __future__ import annotations

import asyncio
import unittest

from orlo_langgraph.client import OrloLangGraphClient
from orlo_langgraph.exceptions import OrloSessionError, OrloUnavailableError
from orlo_langgraph.session import OrloLangGraphSession
from orlo_langgraph.wrappers import govern_tool


class ScriptedTransport:
    """Answers each request from a script. An exception in the script is raised instead of answering."""

    def __init__(self, blocking_step_types: list[str] | None = None) -> None:
        self.requests: list[tuple[str, str, dict, dict | None]] = []
        self.blocking_step_types = blocking_step_types
        self.down = False
        self.failures_left = 0

    def __call__(self, method: str, url: str, headers: dict, payload: dict | None):
        self.requests.append((method, url, dict(headers), payload))
        if url.endswith("/v1/agent-sessions"):
            response = {"session": {"id": "session-1"}}
            if self.blocking_step_types is not None:
                response["blocking_step_types"] = self.blocking_step_types
            return response
        if self.down:
            raise ConnectionError("connection refused")
        if self.failures_left > 0:
            self.failures_left -= 1
            raise TimeoutError("timed out")
        if url.endswith("/steps/govern"):
            return {"decision": "allow", "reason": None, "containment": None, "trace_id": "trace-1"}
        return {}

    def calls_to(self, suffix: str) -> list[tuple[str, str, dict, dict | None]]:
        return [request for request in self.requests if request[1].endswith(suffix)]


def make_client(transport: ScriptedTransport, **options) -> OrloLangGraphClient:
    return OrloLangGraphClient(base_url="https://orlo.test", org_id="org-1", transport=transport, **options)


class ClientResilienceTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_once_with_the_same_idempotency_key(self):
        transport = ScriptedTransport()
        transport.failures_left = 1
        client = make_client(transport)

        result = await client.govern_step("session-1", {"step_id": "s1", "step_type": "model_call"})

        self.assertEqual(result["decision"], "allow")
        first, retry = transport.calls_to("/steps/govern")
        self.assertTrue(first[2]["Idempotency-Key"])
        self.assertEqual(first[2]["Idempotency-Key"], retry[2]["Idempotency-Key"])

    async def test_opens_the_circuit_after_repeated_failures(self):
        transport = ScriptedTransport()
        transport.down = True
        client = make_client(transport, retries=0, failure_threshold=2, cooldown_seconds=60)

        for _ in range(2):
            with self.assertRaises(OrloUnavailableError):
                await client.govern_step("session-1", {"step_id": "s", "step_type": "model_call"})
        sent = len(transport.calls_to("/steps/govern"))
        with self.assertRaises(OrloUnavailableError):
            await client.govern_step("session-1", {"step_id": "s", "step_type": "model_call"})
        self.assertEqual(len(transport.calls_to("/steps/govern")), sent)

    async def test_unavailable_is_still_a_session_error(self):
        self.assertTrue(issubclass(OrloUnavailableError, OrloSessionError))


class WrapperResilienceTests(unittest.IsolatedAsyncioTestCase):
    async def start(self, transport: ScriptedTransport, fail_mode=None) -> OrloLangGraphSession:
        session = OrloLangGraphSession(orlo_client=make_client(transport, retries=0), task_id="task-1", fail_mode=fail_mode)
        await session.__aenter__()
        return session

    async def test_an_opted_in_read_runs_but_lost_reports_are_not_replayed(self):
        transport = ScriptedTransport()
        session = await self.start(transport, {"read": "open"})

        @govern_tool(session=session, tool_name="lookup_order", action_class="read")
        async def lookup_order(order_id: str) -> str:
            return f"order {order_id}"

        transport.down = True
        self.assertEqual(await lookup_order("10482"), "order 10482")
        await session.flush()
        self.assertEqual(session.unsent_steps, 2)
        transport.down = False
        request_count = len(transport.requests)
        await session.close()
        self.assertEqual(len(transport.requests), request_count + 1)
        self.assertEqual(transport.requests[-1][0], "PATCH")
        self.assertEqual(session.unsent_steps, 2)
        imported = transport.calls_to("/traces/import")
        self.assertTrue(imported)
        self.assertEqual(imported[0][3]["steps"][0]["decision"], "allow")
        self.assertTrue(imported[0][3]["steps"][0]["metadata"]["fail_open"])

    async def test_all_action_classes_stop_by_default_during_an_outage(self):
        for action_class in ["read", "write", "delete", "network", "control", None]:
            with self.subTest(action_class=action_class):
                transport = ScriptedTransport()
                session = await self.start(transport)
                ran: list[str] = []

                @govern_tool(session=session, tool_name="example_tool", action_class=action_class)
                async def example_tool(value: str) -> str:
                    ran.append(value)
                    return value

                transport.down = True
                with self.assertRaises(OrloUnavailableError):
                    await example_tool("10482")
                self.assertEqual(ran, [])

    async def test_non_blocking_results_are_sent_in_the_background(self):
        transport = ScriptedTransport(blocking_step_types=["tool_request", "retrieval"])
        session = await self.start(transport)

        @govern_tool(session=session, tool_name="lookup_order", action_class="read")
        async def lookup_order(order_id: str) -> str:
            return order_id

        await lookup_order("1")
        await session.close()
        steps = [payload["step_type"] for _, _, _, payload in transport.calls_to("/steps/govern")]
        self.assertEqual(sorted(steps), ["tool_request", "tool_result"])
        self.assertEqual(session.unsent_steps, 0)

    async def test_every_step_blocks_when_the_server_does_not_say(self):
        session = await self.start(ScriptedTransport())
        self.assertTrue(session.is_blocking("model_call"))
        self.assertEqual(session.fail_mode_for("read"), "closed")
        self.assertEqual(session.fail_mode_for("delete"), "closed")


class SyncToolTests(unittest.TestCase):
    def test_a_sync_tool_sends_background_steps_before_its_loop_closes(self):
        transport = ScriptedTransport(blocking_step_types=["tool_request", "retrieval"])
        session = OrloLangGraphSession(orlo_client=make_client(transport, retries=0), task_id="task-1")
        asyncio.run(session.__aenter__())

        @govern_tool(session=session, tool_name="lookup_order", action_class="read")
        def lookup_order(order_id: str) -> str:
            return order_id

        self.assertEqual(lookup_order("7"), "7")
        steps = [payload["step_type"] for _, _, _, payload in transport.calls_to("/steps/govern")]
        self.assertIn("tool_result", steps)


if __name__ == "__main__":
    unittest.main()
