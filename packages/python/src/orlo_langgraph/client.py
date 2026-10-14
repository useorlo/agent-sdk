# Thin async HTTP client for Orlo's agent governance API, the /v1/agent-sessions routes of the
# Orlo API. OrloLangGraphSession uses it to create and close sessions, govern steps, request
# approvals, and import traces. Each request sends the org id in X-Orlo-Org-Id and runs urllib on
# a worker thread, or calls the transport function passed in, as the tests do.

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping
from urllib import error, request
from uuid import uuid4

from .exceptions import OrloSessionError, OrloUnavailableError


JsonDict = dict[str, Any]
TransportFn = Callable[[str, str, Mapping[str, str], JsonDict | None], Any]

# Network failures a retry can fix. A custom transport signals one by raising any of these.
RETRYABLE_ERRORS: tuple[type[BaseException], ...] = (error.URLError, TimeoutError, ConnectionError, OSError)
RETRY_BASE_DELAY_SECONDS = 0.2


class _RetryableHttpError(Exception):
    def __init__(self, status: int, detail: Mapping[str, Any], retry_after: float | None) -> None:
        super().__init__(detail.get("message") or detail.get("error") or f"HTTP {status}")
        self.status = status
        self.detail = detail
        self.retry_after = retry_after


@dataclass(slots=True)
class OrloLangGraphClient:
    """Thin HTTP client for Orlo's agent governance API.

    Writes carry an Idempotency-Key that stays the same across retries, so a retry after a timeout
    replays Orlo's first answer instead of recording the step twice. After ``failure_threshold``
    consecutive failures the client stops calling Orlo for ``cooldown_seconds`` and raises
    ``OrloUnavailableError`` straight away.
    """

    base_url: str
    org_id: str
    headers: Mapping[str, str] = field(default_factory=dict)
    transport: TransportFn | None = None
    timeout_seconds: float = 3.0
    retries: int = 1
    failure_threshold: int = 5
    cooldown_seconds: float = 30.0
    _failures: int = field(default=0, init=False)
    _open_until: float = field(default=0.0, init=False)

    def _url(self, path: str) -> str:
        return f"{self.base_url.rstrip('/')}{path}"

    def _record_success(self) -> None:
        self._failures = 0
        self._open_until = 0.0

    def _record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.failure_threshold:
            self._open_until = time.monotonic() + self.cooldown_seconds

    async def _request(self, method: str, path: str, payload: JsonDict | None = None) -> Any:
        headers = {
            "Content-Type": "application/json",
            "X-Orlo-Org-Id": self.org_id,
            **self.headers,
        }
        if method not in {"GET", "HEAD"}:
            headers["Idempotency-Key"] = uuid4().hex

        attempts = max(0, self.retries) + 1
        last_error: BaseException | None = None
        for attempt in range(1, attempts + 1):
            if time.monotonic() < self._open_until:
                raise OrloUnavailableError(
                    "Orlo is unavailable after repeated failures; not calling it until the cooldown ends"
                ) from last_error
            try:
                result = await self._send(method, path, headers, payload)
            except _RetryableHttpError as exc:
                last_error = exc
                in_progress = exc.status == 409
                if not in_progress:
                    self._record_failure()
                if attempt < attempts:
                    await asyncio.sleep(exc.retry_after if exc.retry_after is not None else RETRY_BASE_DELAY_SECONDS * attempt)
                    continue
                if in_progress:
                    raise OrloSessionError(str(exc)) from exc
                raise OrloUnavailableError(f"Orlo returned {exc.status}") from exc
            except OrloSessionError:
                # Orlo answered with a non-retryable error: it's up.
                self._record_success()
                raise
            except RETRYABLE_ERRORS as exc:
                last_error = exc
                self._record_failure()
                if attempt < attempts:
                    await asyncio.sleep(RETRY_BASE_DELAY_SECONDS * attempt)
                    continue
                raise OrloUnavailableError(f"Failed to reach Orlo: {exc}") from exc
            self._record_success()
            return result

        raise OrloUnavailableError("Failed to reach Orlo") from last_error

    async def _send(self, method: str, path: str, headers: Mapping[str, str], payload: JsonDict | None) -> Any:
        if self.transport is not None:
            return await asyncio.to_thread(self.transport, method, self._url(path), headers, payload)

        body = None if payload is None else json.dumps(payload).encode("utf-8")
        req = request.Request(self._url(path), data=body, headers=dict(headers), method=method)
        try:
            return await asyncio.to_thread(self._perform, req, self.timeout_seconds)
        except error.HTTPError as exc:  # pragma: no cover - depends on remote server
            try:
                detail = json.loads(exc.read().decode("utf-8"))
            except Exception:
                detail = {"error": exc.reason}
            in_progress = exc.code == 409 and detail.get("error") == "IDEMPOTENCY_IN_PROGRESS"
            if exc.code >= 500 or in_progress:
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                try:
                    delay = min(1.0, float(retry_after)) if retry_after else None
                except ValueError:
                    delay = None
                raise _RetryableHttpError(exc.code, detail, delay) from exc
            raise OrloSessionError(detail.get("message") or detail.get("error") or str(exc)) from exc

    @staticmethod
    def _perform(req: request.Request, timeout: float) -> Any:
        with request.urlopen(req, timeout=timeout) as response:  # nosec B310 - URL is user-configured endpoint
            if response.status == 204:
                return None
            return json.loads(response.read().decode("utf-8"))

    async def create_session(self, payload: JsonDict) -> Any:
        return await self._request("POST", "/v1/agent-sessions", payload)

    async def update_session_status(self, session_id: str, status: str) -> Any:
        return await self._request("PATCH", f"/v1/agent-sessions/{session_id}", {"status": status})

    async def govern_step(self, session_id: str, payload: JsonDict) -> Any:
        return await self._request("POST", f"/v1/agent-sessions/{session_id}/steps/govern", payload)

    async def check_tool(self, session_id: str, payload: JsonDict) -> Any:
        return await self._request("POST", f"/v1/agent-sessions/{session_id}/tools/check", payload)

    async def request_approval(self, session_id: str, step_id: str, payload: JsonDict) -> Any:
        return await self._request("POST", f"/v1/agent-sessions/{session_id}/steps/{step_id}/request-approval", payload)

    async def import_trace(self, session_id: str, payload: JsonDict) -> Any:
        return await self._request("POST", f"/v1/agent-sessions/{session_id}/traces/import", payload)
