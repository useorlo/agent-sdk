# OrloLangGraphSession: one Orlo agent session for a LangGraph or LangChain run. Use it as an
# async context manager: it creates the session through OrloLangGraphClient on entry and marks it
# completed or failed on exit. The callback handler and the governed wrappers send their steps,
# approval requests, and trace events through it, with step ids built from LangChain run ids.

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping
from uuid import UUID, uuid4

from .client import OrloLangGraphClient
from .exceptions import OrloSessionError

# All tool calls stop during an outage unless the application explicitly opts in for an action class.
DEFAULT_FAIL_MODE: Mapping[str, str] = {"default": "closed"}


@dataclass
class OrloLangGraphSession:
    orlo_client: OrloLangGraphClient
    task_id: str
    goal: str | None = None
    framework: str = "langgraph-python"
    risk_tier: str | None = None
    autonomy_level: str = "assisted"
    metadata: Mapping[str, Any] | None = None
    # What a tool call does when Orlo can't be reached: "open" runs it and attempts background reporting, "closed"
    # blocks it. Keyed by action class, with "default" for the rest. Merged over DEFAULT_FAIL_MODE.
    fail_mode: Mapping[str, str] | None = None

    session_id: str | None = field(default=None, init=False)
    session: Mapping[str, Any] | None = field(default=None, init=False)
    # Steps that couldn't be sent in the background, even after retries.
    unsent_steps: int = field(default=0, init=False)
    _closed: bool = field(default=False, init=False)
    _wrapped_run_ids: set[str] = field(default_factory=set, init=False)
    _tool_runs: dict[str, str | None] = field(default_factory=dict, init=False)
    _blocking_step_types: frozenset[str] | None = field(default=None, init=False)
    _pending: set[asyncio.Task] = field(default_factory=set, init=False)

    async def __aenter__(self) -> "OrloLangGraphSession":
        result = await self.orlo_client.create_session(
            {
                "task_id": self.task_id,
                "goal": self.goal,
                "framework": self.framework,
                "risk_tier": self.risk_tier,
                "autonomy_level": self.autonomy_level,
                "metadata": dict(self.metadata or {}),
            }
        )
        self.session = result.get("session")
        self.session_id = self.session.get("id") if self.session else None
        if not self.session_id:
            raise OrloSessionError("Orlo did not return a session id")
        blocking = result.get("blocking_step_types")
        self._blocking_step_types = frozenset(blocking) if isinstance(blocking, list) else None
        return self

    async def __aexit__(self, exc_type, exc, _tb) -> None:
        if self._closed or not self.session_id:
            return
        status = "failed" if exc else "completed"
        try:
            await self.close(status)
        except Exception:
            # Session close should not hide the original application error.
            if exc is None:
                raise

    def require_session_id(self) -> str:
        if not self.session_id:
            raise OrloSessionError("Orlo session has not been started")
        return self.session_id

    def make_step_id(self, prefix: str, run_id: str | None = None) -> str:
        suffix = run_id or uuid4().hex
        return f"{prefix}_{suffix}"

    def mark_wrapped(self, run_id: str | UUID | None) -> None:
        if run_id:
            self._wrapped_run_ids.add(str(run_id))

    def is_wrapped(self, run_id: str | UUID | None) -> bool:
        return bool(run_id and str(run_id) in self._wrapped_run_ids)

    def start_tool_run(self, run_id: str | UUID | None, tool_name: str | None) -> None:
        if run_id:
            self._tool_runs[str(run_id)] = tool_name

    def end_tool_run(self, run_id: str | UUID | None) -> str | None:
        return self._tool_runs.pop(str(run_id), None) if run_id else None

    def claim_tool_run(self, run_id: str | UUID | None, names: Iterable[str | None]) -> bool:
        # Adopt an open tool run only once, and only when it is named like the wrapper's tool, so a
        # governed helper called inside some other tool can't switch off that tool's own checks.
        key = str(run_id) if run_id else None
        if key is None or key in self._wrapped_run_ids or key not in self._tool_runs:
            return False
        if self._tool_runs[key] not in {name for name in names if name}:
            return False
        self._wrapped_run_ids.add(key)
        return True

    def is_blocking(self, step_type: str) -> bool:
        """Whether the wrapper must wait for Orlo's answer. Servers that don't say treat every step as blocking."""
        return self._blocking_step_types is None or step_type in self._blocking_step_types

    def fail_mode_for(self, action_class: str | None) -> str:
        modes = {**DEFAULT_FAIL_MODE, **(self.fail_mode or {})}
        return modes.get(action_class or "", modes.get("default", "closed"))

    def _track(self, sending: Any) -> None:
        async def quietly() -> None:
            try:
                await sending
            except Exception:
                self.unsent_steps += 1

        task = asyncio.ensure_future(quietly())
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    def report_step(self, payload: Mapping[str, Any]) -> None:
        """Send a step without waiting for Orlo's answer. Orlo still records and checks it."""
        self._track(self.orlo_client.govern_step(self.require_session_id(), dict(payload)))

    def report_import(self, payload: Mapping[str, Any]) -> None:
        """Import steps or events in the background, for example a call that ran while Orlo was unreachable."""
        self._track(self.orlo_client.import_trace(self.require_session_id(), dict(payload)))

    async def flush(self) -> None:
        """Wait for steps sent in the background. close() calls this first."""
        loop = asyncio.get_running_loop()
        pending = [task for task in self._pending if task.get_loop() is loop]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def govern_step(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self.orlo_client.govern_step(self.require_session_id(), dict(payload))

    async def request_approval(self, step_id: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self.orlo_client.request_approval(self.require_session_id(), step_id, dict(payload))

    async def import_trace(self, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        return await self.orlo_client.import_trace(self.require_session_id(), dict(payload))

    async def close(self, status: str = "completed") -> Mapping[str, Any]:
        if self._closed:
            return self.session or {}
        await self.flush()
        result = await self.orlo_client.update_session_status(self.require_session_id(), status)
        self._closed = True
        self.session = result
        return result

    async def safe_import_event(self, event_type: str, payload: Mapping[str, Any], step_id: str | None = None) -> None:
        try:
            await self.import_trace(
                {
                    "steps": [],
                    "events": [
                        {
                            "step_id": step_id,
                            "event_type": event_type,
                            "event_source": self.framework,
                            "payload": dict(payload),
                        }
                    ],
                }
            )
        except Exception:
            # Trace continuity should not crash the host runtime.
            await asyncio.sleep(0)
