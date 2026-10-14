# Integration tests that run governed tools and a governed chat model through real langchain-core
# runnables with OrloLangGraphCallbackHandler attached, and check that each call is governed once.
# Skipped when langchain-core is not installed. Uses the fixtures in _support.py.

from __future__ import annotations

import asyncio
import unittest

from _support import SessionTestCase
from orlo_langgraph.wrappers import create_governed_model, govern_tool

try:
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.runnables import RunnableLambda
    from langchain_core.tools import tool
except ImportError:  # pragma: no cover - langchain-core is an optional extra
    tool = None


async def send_email(address: str) -> str:
    """Send an email."""
    return f"sent to {address}"


def send_sms(number: str) -> str:
    """Send a text message."""
    return f"texted {number}"


@unittest.skipIf(tool is None, "langchain-core is not installed")
class LangChainRunTests(SessionTestCase):
    def config(self) -> dict:
        return {"callbacks": [self.handler]}

    def assert_governed_once(self, step_types: list[str]) -> None:
        steps = self.transport.governed_steps()
        self.assertEqual([step["step_type"] for step in steps], step_types)
        [step_id] = {step["step_id"] for step in steps}
        # The callback events for the same call share the wrapper's step id.
        self.assertIn(step_id, {event["step_id"] for event in self.transport.imported_events()})

    async def test_wrapped_async_tool_is_governed_once(self):
        send = tool(govern_tool(session=self.session, tool_name="send_email")(send_email))
        await send.ainvoke({"address": "user@example.com"}, config=self.config())

        self.assert_governed_once(["tool_request", "tool_result"])

    async def test_wrapped_sync_tool_is_governed_once(self):
        send = tool(govern_tool(session=self.session, tool_name="send_sms")(send_sms))
        await asyncio.to_thread(send.invoke, {"number": "555-0100"}, config=self.config())

        self.assert_governed_once(["tool_request", "tool_result"])

    async def test_governed_helper_keeps_the_outer_tool_checked(self):
        governed_send = govern_tool(session=self.session, tool_name="send_email")(send_email)

        @tool
        async def notify_customer(address: str) -> str:
            """Tell a customer their order shipped."""
            return await governed_send(address)

        await notify_customer.ainvoke({"address": "user@example.com"}, config=self.config())

        steps = [(step["step_type"], step["tool_name"]) for step in self.transport.governed_steps()]
        self.assertEqual(steps, [("tool_request", "send_email"), ("tool_result", "send_email"), ("tool_result", "notify_customer")])

    async def test_governed_model_is_governed_once(self):
        model = FakeListChatModel(responses=["hello back"])
        governed = create_governed_model(session=self.session, model=model, model_name="fake-model")

        async def node(state: str):
            return await governed.ainvoke(state)

        await RunnableLambda(node).ainvoke("hello", config=self.config())

        self.assert_governed_once(["model_call", "model_output"])


if __name__ == "__main__":
    unittest.main()
