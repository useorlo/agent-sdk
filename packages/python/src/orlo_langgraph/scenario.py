"""Bounded local runner for frozen scenarios; application agent code stays in its own runtime."""
from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Protocol, Sequence
from uuid import uuid4

from .client import OrloLangGraphClient
from .session import OrloLangGraphSession


class ScenarioEnvironment(Protocol):
    async def prepare(self, initial_state: Mapping[str, Any]) -> None: ...
    async def verify(self, declarations: Sequence[Mapping[str, Any]]) -> Sequence[Mapping[str, Any]]: ...
    async def cleanup(self) -> Mapping[str, Any]: ...


@dataclass(frozen=True)
class ScenarioTrialAssignment:
    trial_id: str
    task_id: str
    execution_token: str
    scenario: Mapping[str, Any]
    candidate: Mapping[str, Any] | None = None
    repetition: int = 1
    attempt: int = 1
    lease_expires_at: str | None = None


@dataclass(frozen=True)
class ScenarioResume:
    session_id: str
    checkpoint_reference: str


@dataclass(frozen=True)
class ScenarioExecutionContext:
    session: OrloLangGraphSession
    scenario: Mapping[str, Any]
    candidate: Mapping[str, Any]
    resumed: bool


class ScenarioTrialDeliveryError(RuntimeError):
    def __init__(self, receipt: Mapping[str, Any], cause: BaseException) -> None:
        super().__init__("The scenario ran, but Orlo did not acknowledge its lifecycle receipt.")
        self.receipt = dict(receipt)
        self.__cause__ = cause


def _pointer_value(value: Any, pointer: str) -> tuple[bool, Any]:
    if pointer == "":
        return True, value
    current = value
    for raw in pointer[1:].split("/"):
        part = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, Mapping):
            if part not in current:
                return False, None
            current = current[part]
        elif isinstance(current, Sequence) and not isinstance(current, (str, bytes, bytearray)):
            if not part.isdigit() or (len(part) > 1 and part.startswith("0")):
                return False, None
            index = int(part)
            if index >= len(current):
                return False, None
            current = current[index]
        else:
            return False, None
    return True, current


def _json_equal(left: Any, right: Any) -> bool:
    """Match JSON values without Python's bool/int equality shortcut."""
    if left is None or right is None:
        return left is right
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        if not isinstance(left, (int, float)) or isinstance(left, bool) or not isinstance(right, (int, float)) or isinstance(right, bool):
            return False
        return math.isfinite(float(left)) and math.isfinite(float(right)) and left == right
    if isinstance(left, str) or isinstance(right, str):
        return isinstance(left, str) and isinstance(right, str) and left == right
    if isinstance(left, Mapping) or isinstance(right, Mapping):
        return isinstance(left, Mapping) and isinstance(right, Mapping) and set(left) == set(right) and all(_json_equal(left[key], right[key]) for key in left)
    if isinstance(left, Sequence) or isinstance(right, Sequence):
        if isinstance(left, (str, bytes, bytearray)) or isinstance(right, (str, bytes, bytearray)):
            return False
        return isinstance(left, Sequence) and isinstance(right, Sequence) and len(left) == len(right) and all(_json_equal(a, b) for a, b in zip(left, right))
    return False


def evaluate_authoritative_state_verifier(declaration: Mapping[str, Any], final_state: Any, evidence_reference: str) -> Mapping[str, Any]:
    """Check frozen expected state without using model output as outcome evidence."""
    if declaration.get("evidence_source") != "authoritative_state":
        raise ValueError("The verifier must use authoritative_state evidence.")
    specification = declaration.get("specification") or {}
    path = specification.get("path")
    if not isinstance(path, str) or (path and not path.startswith("/")):
        raise ValueError("The verifier path must be a JSON pointer.")
    present, observed = _pointer_value(final_state, path)
    absent = specification.get("absent") is True
    passed = not present if absent else present and _json_equal(observed, specification.get("equals"))
    return {"version": 1, "verifier_key": declaration["key"], "verifier_version": declaration["version"],
        "implementation_hash": declaration["implementation_hash"], "dimension": declaration["dimension"],
        "evidence_source": declaration["evidence_source"], "status": "passed" if passed else "failed",
        "mandatory": declaration["mandatory"], "evidence_reference": evidence_reference,
        "reason": f"The authoritative state {'matched' if passed else 'did not match'} {path or 'the root value'}.",
        "evidence": {"present": present, **({} if absent else {"observed": observed})}}


def _failure(error: BaseException) -> dict[str, str]:
    return {"name": type(error).__name__, "message": str(error)}


def _budget_failure(result: Mapping[str, Any], scenario: Mapping[str, Any]) -> tuple[str, bool] | None:
    metrics = result.get("metrics") or {}
    budgets = scenario.get("budgets") or {}
    turns = metrics.get("turns")
    tool_calls = metrics.get("tool_calls")
    if not isinstance(turns, (int, float)) or isinstance(turns, bool) or not math.isfinite(float(turns)) or turns < 0:
        return "The runner did not report a valid turn count.", True
    if not isinstance(tool_calls, (int, float)) or isinstance(tool_calls, bool) or not math.isfinite(float(tool_calls)) or tool_calls < 0:
        return "The runner did not report a valid tool-call count.", True
    if turns > budgets.get("max_turns", float("inf")):
        return "The agent exceeded the declared turn budget.", False
    if tool_calls > budgets.get("max_tool_calls", float("inf")):
        return "The agent exceeded the declared tool-call budget.", False
    maximum_cost = budgets.get("max_cost_usd")
    cost = metrics.get("cost_usd")
    if maximum_cost is not None and (not isinstance(cost, (int, float)) or isinstance(cost, bool) or not math.isfinite(float(cost)) or cost < 0):
        return "The runner did not report a valid cost.", True
    if maximum_cost is not None and cost > maximum_cost:
        return "The agent exceeded the declared cost budget.", False
    return None


class OrloScenarioRunner:
    def __init__(self, client: OrloLangGraphClient) -> None:
        self.client = client

    async def run(
        self,
        assignment: ScenarioTrialAssignment,
        environment: ScenarioEnvironment,
        execute: Callable[[ScenarioExecutionContext], Awaitable[Mapping[str, Any]]],
        *,
        resume: ScenarioResume | None = None,
    ) -> Mapping[str, Any]:
        started = time.monotonic()
        session: OrloLangGraphSession | None = None
        prepared = False
        result: Mapping[str, Any] | None = None
        verifier_results: Sequence[Mapping[str, Any]] = []
        failure: BaseException | None = None
        duration = float((assignment.scenario.get("budgets") or {}).get("max_duration_ms", 30000)) / 1000
        try:
            async with asyncio.timeout(duration):
                if resume:
                    resumed = await self.client.resume_scenario_trial(assignment.trial_id, assignment.execution_token)
                    if resumed.get("session_id") != resume.session_id or resumed.get("checkpoint_reference") != resume.checkpoint_reference:
                        raise RuntimeError("The saved continuation does not match Orlo's paused trial.")
                    restore = getattr(environment, "restore", None)
                    if not restore:
                        raise RuntimeError("This environment cannot restore a paused scenario.")
                    await restore(resume.checkpoint_reference)
                    prepared = True
                    session = await OrloLangGraphSession.resume(self.client, resume.session_id)
                else:
                    await environment.prepare(assignment.scenario.get("initial_state") or {})
                    prepared = True
                    session = OrloLangGraphSession(orlo_client=self.client, task_id=assignment.task_id, framework="orlo-scenario-runner",
                        test_context={"kind": "scenario_trial", "trial_id": assignment.trial_id, "execution_token": assignment.execution_token})
                    await session.__aenter__()
                result = await execute(ScenarioExecutionContext(session=session, scenario=assignment.scenario, candidate=assignment.candidate or {}, resumed=resume is not None))
                await session.flush()
                if result.get("status") == "completed":
                    external = [row for row in assignment.scenario.get("verifiers", []) if row.get("evidence_source") != "permission_receipt"]
                    verify = getattr(environment, "verify", None)
                    verifier_results = await verify(external) if verify else []
        except BaseException as error:
            failure = error

        cleanup: Mapping[str, Any] = {"status": "succeeded"}
        if prepared:
            try:
                async with asyncio.timeout(min(10.0, duration)):
                    cleanup = await environment.cleanup()
            except BaseException as error:
                cleanup = {"status": "failed", "detail": str(error)}

        budget = _budget_failure(result, assignment.scenario) if result else None
        if cleanup.get("status") == "failed":
            status = "invalid"
        elif isinstance(failure, asyncio.CancelledError):
            status = "cancelled"
        elif failure:
            status = "failed"
        elif budget:
            status = "invalid" if budget[1] else "failed"
        else:
            status = result.get("status")
        if status not in {"completed", "failed", "invalid", "cancelled", "awaiting_approval"}:
            failure = ValueError("The scenario executor returned an unsupported status.")
            status = "failed"
        receipt: dict[str, Any] = {
            "receipt_id": str(uuid4()), "session_id": session.require_session_id() if session else (resume.session_id if resume else ""),
            "status": status, "metrics": {**((result or {}).get("metrics") or {}), "duration_ms": round((time.monotonic() - started) * 1000),
                "unsent_steps": session.unsent_steps if session else 0},
            "cleanup": dict(cleanup),
        }
        if result and result.get("status") == "awaiting_approval":
            receipt.update(approval_id=result.get("approval_id"), checkpoint_reference=result.get("checkpoint_reference"))
        if status == "completed":
            receipt["verifier_results"] = list(verifier_results)
        if failure or budget or cleanup.get("status") == "failed":
            receipt["failure"] = {**(_failure(failure) if failure else {}), **({"budget": budget[0]} if budget else {}),
                **({"cleanup": cleanup.get("detail", "Cleanup failed.")} if cleanup.get("status") == "failed" else {})}
        if not receipt["session_id"]:
            if failure:
                raise failure
            raise RuntimeError("The scenario session was not created.")
        try:
            recorded = await self.client.record_scenario_trial_receipt(assignment.trial_id, assignment.execution_token, receipt)
        except BaseException as error:
            raise ScenarioTrialDeliveryError(receipt, error) from error
        return {"trial_id": assignment.trial_id, "session_id": receipt["session_id"], "status": recorded.get("status", status),
            "receipt_id": receipt["receipt_id"], "recorded": bool(recorded.get("recorded"))}


async def run_scenario_trials(
    assignments: Sequence[ScenarioTrialAssignment],
    concurrency: int,
    run: Callable[[ScenarioTrialAssignment], Awaitable[Mapping[str, Any]]],
) -> list[Mapping[str, Any] | BaseException]:
    """Run with a fixed worker count and retain a result or exception for every assignment."""
    if not isinstance(concurrency, int) or not 1 <= concurrency <= 32:
        raise ValueError("concurrency must be an integer from 1 to 32")
    semaphore = asyncio.Semaphore(concurrency)
    async def one(assignment: ScenarioTrialAssignment) -> Mapping[str, Any] | BaseException:
        async with semaphore:
            try:
                return await run(assignment)
            except BaseException as error:
                return error
    return await asyncio.gather(*(one(assignment) for assignment in assignments))
