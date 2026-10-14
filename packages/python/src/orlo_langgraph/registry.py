# One registration point for tools exposed to an agent. The inventory describes this mapping only.
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Callable, Mapping

from .session import OrloLangGraphSession
from .wrappers import govern_tool


@dataclass(frozen=True)
class ToolDefinition:
    execute: Callable[..., Any]
    action_class: str
    environment: str | None = None


class GovernedToolRegistry:
    """Expose only wrapped callables to the host. Unknown names never fall back to raw tools."""

    def __init__(self, session: OrloLangGraphSession, tools: Mapping[str, ToolDefinition], *, auto_request_approval: bool = True):
        wrapped: dict[str, Callable[..., Any]] = {}
        self._definitions = dict(tools)
        self._session = session
        for name, definition in self._definitions.items():
            if not name.strip() or not isinstance(definition, ToolDefinition) or not callable(definition.execute) or definition.action_class not in {"read", "write", "delete", "network", "control"}:
                raise ValueError(f"Tool {name!r} needs an implementation and an explicit action class.")
            tool = govern_tool(session=session, tool_name=name, action_class=definition.action_class,
                               environment=definition.environment, auto_request_approval=auto_request_approval,
                               metadata={"orlo_tool_registration": "registry"})(definition.execute)
            tool.__name__ = name
            wrapped[name] = tool
        self.tools: Mapping[str, Callable[..., Any]] = MappingProxyType(wrapped)

    def resolve(self, name: str) -> Callable[..., Any]:
        try:
            return self.tools[name]
        except KeyError:
            raise ValueError(f"Tool {name!r} is not registered.") from None

    def describe(self) -> list[dict[str, str]]:
        return [{"name": name, "action_class": definition.action_class,
                 "when_unavailable": "continue" if self._session.fail_mode_for(definition.action_class) == "open" else "stop"}
                for name, definition in self._definitions.items()]
