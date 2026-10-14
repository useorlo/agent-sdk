# Tests for OrloLangGraphCallbackHandler that call its callback methods directly, so they run
# without langchain-core. They cover which callbacks become governed steps or trace events, and
# how the handler and the governed wrappers share step ids. Uses the fixtures in _support.py.

from __future__ import annotations

import unittest
from unittest.mock import patch
from uuid import uuid4

from _support import SessionTestCase
from orlo_langgraph.wrappers import create_governed_model, govern_tool


async def send_email(address: str) -> str:
    """Send an email."""
    return f"sent to {address}"


class _RecordingModel:
    def __init__(self) -> None:
        self.configs: list[dict | None] = []

    async def ainvoke(self, input_value, config=None):
        self.configs.append(config)
        return "hello back"


class ToolCallbackTests(SessionTestCase):
    async def test_unwrapped_tool_result_carries_tool_name(self):
        await self.handler.on_tool_start({"name": "send_email", "description": "Send an email"}, "user@example.com", run_id="run-1")
        await self.handler.on_tool_end("sent", run_id="run-1")

        [step] = self.transport.governed_steps()
        self.assertEqual(step["step_type"], "tool_result")
        self.assertEqual(step["tool_name"], "send_email")
        self.assertEqual(self.session._tool_runs, {})

    async def test_serialized_name_takes_precedence_over_run_name(self):
        await self.handler.on_tool_start({"name": "send_email"}, "user@example.com", run_id="run-1", name="nightly-digest")
        await self.handler.on_tool_end("sent", run_id="run-1")

        [step] = self.transport.governed_steps()
        self.assertEqual(step["tool_name"], "send_email")

    async def test_tool_name_falls_back_to_name_kwarg(self):
        await self.handler.on_tool_start({}, "refund policy", run_id="run-1", name="search_docs")
        await self.handler.on_tool_end("results", run_id="run-1")
        await self.handler.on_tool_start(None, "refund policy", run_id="run-2", name="search_docs")
        await self.handler.on_tool_end("results", run_id="run-2")

        self.assertEqual([step["tool_name"] for step in self.transport.governed_steps()], ["search_docs", "search_docs"])

    async def test_interleaved_tool_runs_keep_their_own_names(self):
        await self.handler.on_tool_start({"name": "search_docs"}, "refund policy", run_id="run-a")
        await self.handler.on_tool_start({"name": "send_email"}, "user@example.com", run_id="run-b")
        await self.handler.on_tool_end("sent", run_id="run-b")
        await self.handler.on_tool_end("results", run_id="run-a")

        names = {step["step_id"]: step["tool_name"] for step in self.transport.governed_steps()}
        self.assertEqual(names, {"tool_run-a": "search_docs", "tool_run-b": "send_email"})
        self.assertEqual(self.session._tool_runs, {})

    async def test_wrapped_tool_end_only_imports_event(self):
        self.session.mark_wrapped("run-1")
        await self.handler.on_tool_start({"name": "send_email"}, "user@example.com", run_id="run-1")
        await self.handler.on_tool_end("sent", run_id="run-1")

        self.assertEqual(self.transport.governed_steps(), [])
        self.assertEqual([event["event_type"] for event in self.transport.imported_events()], ["callback:tool_start", "callback:tool_end"])
        self.assertEqual(self.session._tool_runs, {})

    async def test_tool_error_forgets_tool_name(self):
        await self.handler.on_tool_start({"name": "send_email"}, "user@example.com", run_id="run-1")
        await self.handler.on_tool_error(RuntimeError("smtp unavailable"), run_id="run-1")

        self.assertEqual(self.transport.governed_steps(), [])
        error_event = self.transport.imported_events()[-1]
        self.assertEqual(error_event["event_type"], "callback:tool_error")
        self.assertEqual(error_event["step_id"], "tool_run-1")
        self.assertEqual(error_event["payload"]["tool_name"], "send_email")
        self.assertEqual(self.session._tool_runs, {})


class WrappedRunTests(SessionTestCase):
    async def _run_as_tool(self, run_id, tool_name: str, governed, *args) -> None:
        # Fire the callbacks around a governed call the way LangChain runs a tool called `tool_name`.
        await self.handler.on_tool_start({"name": tool_name}, str(args), run_id=run_id)
        with patch("orlo_langgraph.wrappers.current_run_id", return_value=str(run_id)):
            await governed(*args)
        await self.handler.on_tool_end("sent", run_id=run_id)

    async def test_wrapped_tool_claims_the_callback_tool_run(self):
        run_id = uuid4()
        governed = govern_tool(session=self.session, tool_name="send_email")(send_email)
        await self._run_as_tool(run_id, "send_email", governed, "user@example.com")

        steps = self.transport.governed_steps()
        self.assertEqual([step["step_type"] for step in steps], ["tool_request", "tool_result"])
        self.assertEqual({step["step_id"] for step in steps}, {f"tool_{run_id}"})
        self.assertEqual(self.transport.imported_events()[-1]["event_type"], "callback:tool_end")

    async def test_wrapped_tool_matches_on_function_name(self):
        # `@tool` names the LangChain tool after the function, which can differ from the Orlo tool name.
        run_id = uuid4()
        governed = govern_tool(session=self.session, tool_name="email_customer")(send_email)
        await self._run_as_tool(run_id, "send_email", governed, "user@example.com")

        self.assertEqual({step["step_id"] for step in self.transport.governed_steps()}, {f"tool_{run_id}"})

    async def test_governed_helper_does_not_claim_another_tool_run(self):
        run_id = uuid4()
        governed = govern_tool(session=self.session, tool_name="send_email")(send_email)
        await self._run_as_tool(run_id, "notify_customer", governed, "user@example.com")

        request, result, outer = self.transport.governed_steps()
        self.assertNotEqual(request["step_id"], f"tool_{run_id}")
        self.assertEqual((outer["step_type"], outer["step_id"], outer["tool_name"]), ("tool_result", f"tool_{run_id}", "notify_customer"))

    async def test_tool_run_is_claimed_once(self):
        run_id = uuid4()
        governed = govern_tool(session=self.session, tool_name="send_email")(send_email)
        await self.handler.on_tool_start({"name": "send_email"}, "user@example.com", run_id=run_id)
        with patch("orlo_langgraph.wrappers.current_run_id", return_value=str(run_id)):
            await governed("first@example.com")
            await governed("second@example.com")

        step_ids = [step["step_id"] for step in self.transport.governed_steps()]
        self.assertEqual(step_ids[:2], [f"tool_{run_id}"] * 2)
        self.assertNotIn(f"tool_{run_id}", step_ids[2:])

    async def test_governed_model_names_its_langchain_run(self):
        model = _RecordingModel()
        governed = create_governed_model(session=self.session, model=model, model_name="fake-model")
        with patch("orlo_langgraph.wrappers.is_runnable", return_value=True):
            await governed.ainvoke("hello")
        run_id = model.configs[0]["run_id"]
        await self.handler.on_llm_end("hello back", run_id=run_id)

        steps = self.transport.governed_steps()
        self.assertEqual([step["step_type"] for step in steps], ["model_call", "model_output"])
        self.assertEqual({step["step_id"] for step in steps}, {f"llm_{run_id}"})
        self.assertEqual(steps[0]["request"]["kwargs"], {})
        self.assertEqual(self.transport.imported_events()[-1]["event_type"], "callback:llm_end")

    async def test_governed_model_leaves_the_callers_config_alone(self):
        model = _RecordingModel()
        governed = create_governed_model(session=self.session, model=model, model_name="fake-model")
        config = {"tags": ["support"]}
        with patch("orlo_langgraph.wrappers.is_runnable", return_value=True):
            await governed.ainvoke("hello", config)
            await governed.ainvoke("hello again", config)

        self.assertEqual(config, {"tags": ["support"]})
        first, second = model.configs
        self.assertEqual(first["tags"], ["support"])
        self.assertNotEqual(first["run_id"], second["run_id"])


if __name__ == "__main__":
    unittest.main()
