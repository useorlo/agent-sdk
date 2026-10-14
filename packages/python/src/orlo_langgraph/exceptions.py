# Exceptions raised by the orlo_langgraph adapter. OrloSessionError covers session and transport
# failures in the client and the session. The governed wrappers raise OrloGovernanceBlocked when
# Orlo rejects or contains a step, and its subclass OrloApprovalRequired when a step needs
# approval; both carry Orlo's decision, reason, and full response.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


class OrloSessionError(RuntimeError):
    """Raised when Orlo session lifecycle or transport operations fail."""


class OrloUnavailableError(OrloSessionError):
    """Raised when Orlo can't be reached after retries, or while the circuit breaker is open."""


@dataclass(slots=True)
class OrloGovernanceBlocked(RuntimeError):
    decision: str
    reason: str | None
    containment: str | None
    trace_id: str | None
    response: Mapping[str, Any]
    approval: Mapping[str, Any] | None = None
    # The blocked step. After its approval is decided, retry the tool with orlo_step_id=step_id.
    step_id: str | None = None

    def __post_init__(self) -> None:
        message = self.reason or f"Orlo blocked execution with decision={self.decision}"
        RuntimeError.__init__(self, message)


class OrloApprovalRequired(OrloGovernanceBlocked):
    """Raised when Orlo requires approval before a step can continue."""


class OrloApprovalTimeoutError(OrloSessionError, TimeoutError):
    """The local wait ended; it does not cancel or decide the approval."""

    def __init__(self, approval_id: str, timeout_seconds: float) -> None:
        self.approval_id = approval_id
        self.timeout_seconds = timeout_seconds
        super().__init__(f"Approval {approval_id} did not resolve within {timeout_seconds} seconds. Read its status before retrying the governed step.")
