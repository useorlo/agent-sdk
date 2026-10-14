# LangChain callback handler that reports a LangGraph run to an Orlo session. Attach it through
# the run config's callbacks. Model outputs, tool results, and retrieval results become governed
# steps on the OrloLangGraphSession; starts, chain ends, and errors are imported as trace events.
# When the top-level chain ends or fails, the handler closes the session.

from __future__ import annotations

from typing import Any, Mapping

from ._compat import AsyncCallbackHandler, to_jsonable
from .session import OrloLangGraphSession


def _tool_name(serialized: Mapping[str, Any] | None, kwargs: Mapping[str, Any]) -> str | None:
    # LangChain puts the tool's own name in `serialized`; the `name` kwarg is the run name.
    name = (serialized.get("name") if isinstance(serialized, Mapping) else None) or kwargs.get("name")
    return str(name) if name else None


class OrloLangGraphCallbackHandler(AsyncCallbackHandler):
    def __init__(self, session: OrloLangGraphSession):
        self.session = session

    async def on_chat_model_start(self, serialized: Mapping[str, Any], messages: Any, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        await self.session.safe_import_event(
            "callback:model_start",
            {
                "serialized": to_jsonable(serialized),
                "messages": to_jsonable(messages),
                "parent_run_id": parent_run_id,
                "metadata": to_jsonable(kwargs),
            },
            step_id=self.session.make_step_id("llm", run_id),
        )

    async def on_llm_start(self, serialized: Mapping[str, Any], prompts: Any, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        await self.session.safe_import_event(
            "callback:llm_start",
            {
                "serialized": to_jsonable(serialized),
                "prompts": to_jsonable(prompts),
                "parent_run_id": parent_run_id,
                "metadata": to_jsonable(kwargs),
            },
            step_id=self.session.make_step_id("llm", run_id),
        )

    async def on_llm_end(self, response: Any, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        step_id = self.session.make_step_id("llm", run_id)
        payload = {
            "output": {
                "content": to_jsonable(response),
            },
            "metadata": {
                "callback": True,
                "parent_run_id": parent_run_id,
                **to_jsonable(kwargs),
            },
        }
        if self.session.is_wrapped(run_id):
            await self.session.safe_import_event("callback:llm_end", payload, step_id=step_id)
            return
        await self.session.govern_step(
            {
                "step_id": step_id,
                "parent_step_id": self.session.make_step_id("parent", parent_run_id) if parent_run_id else None,
                "step_type": "model_output",
                "phase": "post",
                "actor": "model",
                **payload,
            }
        )

    async def on_tool_start(self, serialized: Mapping[str, Any], input_str: Any, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        self.session.start_tool_run(run_id, _tool_name(serialized, kwargs))
        await self.session.safe_import_event(
            "callback:tool_start",
            {
                "serialized": to_jsonable(serialized),
                "input": to_jsonable(input_str),
                "parent_run_id": parent_run_id,
                "metadata": to_jsonable(kwargs),
            },
            step_id=self.session.make_step_id("tool", run_id),
        )

    async def on_tool_end(self, output: Any, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        tool_name = self.session.end_tool_run(run_id)
        step_id = self.session.make_step_id("tool", run_id)
        payload = {
            "output": {
                "content": to_jsonable(output),
            },
            "metadata": {
                "callback": True,
                "parent_run_id": parent_run_id,
                **to_jsonable(kwargs),
            },
        }
        if self.session.is_wrapped(run_id):
            await self.session.safe_import_event("callback:tool_end", payload, step_id=step_id)
            return
        await self.session.govern_step(
            {
                "step_id": step_id,
                "parent_step_id": self.session.make_step_id("parent", parent_run_id) if parent_run_id else None,
                "step_type": "tool_result",
                "phase": "post",
                "actor": "tool",
                "tool_name": tool_name,
                **payload,
            }
        )

    async def on_tool_error(self, error: BaseException, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        tool_name = self.session.end_tool_run(run_id)
        await self.session.safe_import_event(
            "callback:tool_error",
            {
                "error": str(error),
                "tool_name": tool_name,
                "parent_run_id": parent_run_id,
                "metadata": to_jsonable(kwargs),
            },
            step_id=self.session.make_step_id("tool", run_id),
        )

    async def on_retriever_start(self, serialized: Mapping[str, Any], query: str, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        await self.session.safe_import_event(
            "callback:retriever_start",
            {
                "serialized": to_jsonable(serialized),
                "query": query,
                "parent_run_id": parent_run_id,
                "metadata": to_jsonable(kwargs),
            },
            step_id=self.session.make_step_id("retrieval", run_id),
        )

    async def on_retriever_end(self, documents: Any, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        await self.session.govern_step(
            {
                "step_id": self.session.make_step_id("retrieval", run_id),
                "parent_step_id": self.session.make_step_id("parent", parent_run_id) if parent_run_id else None,
                "step_type": "retrieval",
                "phase": "post",
                "actor": "runtime",
                "result": {
                    "content": to_jsonable(documents),
                },
                "metadata": {
                    "callback": True,
                    **to_jsonable(kwargs),
                },
            }
        )

    async def on_chain_end(self, outputs: Any, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        await self.session.safe_import_event(
            "callback:chain_end",
            {
                "outputs": to_jsonable(outputs),
                "run_id": run_id,
                "parent_run_id": parent_run_id,
                "metadata": to_jsonable(kwargs),
            },
        )
        if parent_run_id is None:
            await self.session.close("completed")

    async def on_chain_error(self, error: BaseException, *, run_id: str, parent_run_id: str | None = None, **kwargs: Any) -> None:
        await self.session.safe_import_event(
            "callback:chain_error",
            {
                "error": str(error),
                "run_id": run_id,
                "parent_run_id": parent_run_id,
                "metadata": to_jsonable(kwargs),
            },
        )
        if parent_run_id is None:
            await self.session.close("failed")
