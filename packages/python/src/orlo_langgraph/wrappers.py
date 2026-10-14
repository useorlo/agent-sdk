# Wrappers that put an application's model and tool calls under Orlo governance.
# create_governed_model wraps a chat model and govern_tool decorates a sync or async tool function,
# so each call goes to Orlo through OrloLangGraphSession before it runs (model_call, tool_request)
# and after (model_output, tool_result). When Orlo rejects, contains, or requires approval, the
# wrapper raises OrloGovernanceBlocked or OrloApprovalRequired; govern_tool opens the approval
# request first unless auto_request_approval is false.

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import wraps
from typing import Any, Awaitable, Callable, Mapping, TypeVar
from uuid import uuid4

from ._compat import current_run_id, is_runnable, to_jsonable
from .exceptions import OrloApprovalRequired, OrloGovernanceBlocked, OrloUnavailableError
from .session import OrloLangGraphSession


T = TypeVar("T")


def _raise_if_blocked(
    response: Mapping[str, Any],
    approval: Mapping[str, Any] | None = None,
    step_id: str | None = None,
) -> None:
    decision = response.get("decision")
    if decision not in {"reject", "require_approval", "contain"}:
        return
    error_cls = OrloApprovalRequired if decision == "require_approval" else OrloGovernanceBlocked
    raise error_cls(
        decision=str(decision),
        reason=response.get("reason"),
        containment=response.get("containment"),
        trace_id=response.get("trace_id"),
        response=response,
        approval=approval,
        step_id=step_id,
    )


def _with_run_id(args: tuple[Any, ...], kwargs: dict[str, Any]) -> tuple[str, tuple[Any, ...], dict[str, Any]]:
    # A Runnable takes its run id from the config passed after the input, so setting it there makes
    # the model's callbacks report the run this wrapper governs.
    config = dict((args[0] if args else kwargs.get("config")) or {})
    config["run_id"] = config.get("run_id") or uuid4()
    if args:
        return str(config["run_id"]), (config, *args[1:]), kwargs
    return str(config["run_id"]), args, {**kwargs, "config": config}


@dataclass
class GovernedChatModel:
    session: OrloLangGraphSession
    model: Any
    model_name: str
    metadata: Mapping[str, Any] | None = None

    async def ainvoke(self, input_value: Any, *args: Any, **kwargs: Any) -> Any:
        run_id = str(kwargs.get("run_id") or "")
        model_args, model_kwargs = args, kwargs
        if not run_id and is_runnable(self.model):
            run_id, model_args, model_kwargs = _with_run_id(args, kwargs)
        step_id = self.session.make_step_id("llm", run_id or None)
        self.session.mark_wrapped(run_id or None)

        pre_payload = {
            "step_id": step_id,
            "step_type": "model_call",
            "phase": "pre",
            "actor": "runtime",
            "model_name": self.model_name,
            "request": {
                "input": to_jsonable(input_value),
                "args": to_jsonable(args),
                "kwargs": to_jsonable(kwargs),
            },
            "metadata": dict(self.metadata or {}),
            "trace_id": run_id or None,
        }
        if self.session.is_blocking("model_call"):
            pre = await self.session.govern_step(pre_payload)
            _raise_if_blocked(pre, step_id=step_id)
        else:
            self.session.report_step(pre_payload)

        if hasattr(self.model, "ainvoke"):
            result = await self.model.ainvoke(input_value, *model_args, **model_kwargs)
        else:
            result = await asyncio.to_thread(self.model.invoke, input_value, *model_args, **model_kwargs)

        post_payload = {
            "step_id": step_id,
            "step_type": "model_output",
            "phase": "post",
            "actor": "model",
            "model_name": self.model_name,
            "request": {"input": to_jsonable(input_value)},
            "result": {
                "content": to_jsonable(result),
                "model": self.model_name,
            },
            "metadata": dict(self.metadata or {}),
            "trace_id": run_id or None,
        }
        if self.session.is_blocking("model_output"):
            post = await self.session.govern_step(post_payload)
            _raise_if_blocked(post, step_id=step_id)
        else:
            self.session.report_step(post_payload)
        return result

    def invoke(self, input_value: Any, *args: Any, **kwargs: Any) -> Any:
        async def invoke_and_flush() -> Any:
            try:
                return await self.ainvoke(input_value, *args, **kwargs)
            finally:
                # asyncio.run cancels unfinished tasks on exit, so send background steps first.
                await self.session.flush()

        return asyncio.run(invoke_and_flush())


def create_governed_model(
    session: OrloLangGraphSession,
    model: Any,
    model_name: str,
    metadata: Mapping[str, Any] | None = None,
) -> GovernedChatModel:
    return GovernedChatModel(session=session, model=model, model_name=model_name, metadata=metadata)


def govern_tool(
    session: OrloLangGraphSession,
    tool_name: str,
    action_class: str | None = None,
    environment: str | None = None,
    auto_request_approval: bool = True,
    metadata: Mapping[str, Any] | None = None,
) -> Callable[[Callable[..., T]], Callable[..., Awaitable[T]] | Callable[..., T]]:
    """Govern every call of a tool with Orlo before and after it runs.

    When a policy requires approval, the wrapper opens one (unless
    ``auto_request_approval`` is false) and raises ``OrloApprovalRequired``. The
    approval is bound to that exact call: the tool name plus its arguments. Once
    a reviewer decides, call the tool again with the same arguments and pass the
    blocked step id as the reserved ``orlo_step_id`` keyword::

        try:
            await issue_refund(order_id="ord_123", amount_cents=4200)
        except OrloApprovalRequired as blocked:
            saved_step_id = blocked.step_id  # keep with your run state

        # later, after the reviewer has decided
        await issue_refund(order_id="ord_123", amount_cents=4200, orlo_step_id=saved_step_id)

    Orlo allows an approved call once, rejects a rejected one, applies the
    timeout action of an expired one, and asks again if the arguments changed.
    ``orlo_step_id`` is never passed to the tool. The wrapper does not wait or
    poll for the decision.
    """

    def decorator(func: Callable[..., T]) -> Callable[..., Awaitable[T]] | Callable[..., T]:
        is_async = asyncio.iscoroutinefunction(func)

        async def run(*args: Any, **kwargs: Any) -> T:
            # Popped first: the governed arguments must match the original call for its approval to apply.
            retry_step_id = kwargs.pop("orlo_step_id", None)
            run_id = str(kwargs.get("run_id") or "")
            if not run_id:
                # Inside a LangChain tool, govern the tool run the callback handler saw start.
                context_run_id = current_run_id()
                if self_session.claim_tool_run(context_run_id, (tool_name, getattr(func, "__name__", None))):
                    run_id = context_run_id
            step_id = retry_step_id or self_session.make_step_id("tool", run_id or None)
            self_session.mark_wrapped(run_id or None)

            request_payload = {
                "tool_name": tool_name,
                "arguments": {
                    "args": to_jsonable(args),
                    "kwargs": to_jsonable(kwargs),
                },
                "action_class": action_class,
                "environment": environment,
                "metadata": dict(metadata or {}),
                "trace_id": run_id or None,
            }
            pre_payload = {
                "step_id": step_id,
                "step_type": "tool_request",
                "phase": "pre",
                "actor": "runtime",
                "tool_name": tool_name,
                "action_class": action_class,
                "environment": environment,
                "request": request_payload["arguments"],
                "metadata": dict(metadata or {}),
                "trace_id": run_id or None,
            }
            failed_open = False
            try:
                pre = await self_session.govern_step(pre_payload)
            except OrloUnavailableError as exc:
                if self_session.fail_mode_for(action_class) != "open":
                    raise
                # Explicit fail-open: reporting has bounded retries, not a persistent replay queue.
                failed_open = True
                pre = {
                    "decision": "allow",
                    "reason": "Orlo couldn't be reached. Allowed because this action class fails open.",
                    "containment": None,
                    "trace_id": None,
                }
                self_session.report_import(
                    {
                        "steps": [
                            {
                                **pre_payload,
                                "decision": "allow",
                                "metadata": {**dict(metadata or {}), "fail_open": True, "fail_open_reason": str(exc)},
                            }
                        ],
                        "events": [
                            {
                                "step_id": step_id,
                                "event_type": "sdk:fail_open",
                                "event_source": self_session.framework,
                                "payload": {"tool_name": tool_name, "action_class": action_class},
                            }
                        ],
                    }
                )
            approval = None
            if not failed_open and pre.get("decision") == "require_approval" and auto_request_approval:
                approval = await self_session.request_approval(
                    step_id,
                    {
                        "policy_reason": pre.get("reason") or f'Tool "{tool_name}" requires approval',
                        "request_payload": request_payload,
                    },
                )
            _raise_if_blocked(pre, approval, step_id=step_id)

            if is_async:
                result = await func(*args, **kwargs)
            else:
                result = await asyncio.to_thread(func, *args, **kwargs)

            post_payload = {
                "step_id": step_id,
                "step_type": "tool_result",
                "phase": "post",
                "actor": "tool",
                "tool_name": tool_name,
                "action_class": action_class,
                "environment": environment,
                "request": request_payload["arguments"],
                "result": {
                    "content": to_jsonable(result),
                },
                "metadata": dict(metadata or {}),
                "trace_id": run_id or None,
            }
            # After a fail-open call Orlo was unreachable moments ago, so report the result instead of waiting.
            if self_session.is_blocking("tool_result") and not failed_open:
                try:
                    post = await self_session.govern_step(post_payload)
                except OrloUnavailableError:
                    if self_session.fail_mode_for(action_class) != "open":
                        raise
                    self_session.report_step(post_payload)
                else:
                    _raise_if_blocked(post, step_id=step_id)
            else:
                self_session.report_step(post_payload)
            return result

        self_session = session

        if is_async:
            @wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> T:
                return await run(*args, **kwargs)

            return async_wrapper

        @wraps(func)
        def sync_wrapper(*args: Any, **kwargs: Any) -> T:
            async def run_and_flush() -> T:
                try:
                    return await run(*args, **kwargs)
                finally:
                    # asyncio.run cancels unfinished tasks on exit, so send background steps first.
                    await self_session.flush()

            return asyncio.run(run_and_flush())

        return sync_wrapper

    return decorator
