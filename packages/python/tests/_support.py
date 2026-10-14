# Shared fixtures for the adapter tests. RecordingTransport stands in for Orlo's HTTP API: it
# records every request, returns a session on create, and allows every governed step.
# SessionTestCase starts an OrloLangGraphSession on it and builds the callback handler.
# test_callbacks.py and test_langchain_integration.py import these.

from __future__ import annotations

import unittest

from orlo_langgraph.callbacks import OrloLangGraphCallbackHandler
from orlo_langgraph.client import OrloLangGraphClient
from orlo_langgraph.session import OrloLangGraphSession


class RecordingTransport:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict | None]] = []

    def __call__(self, method: str, url: str, headers: dict, payload: dict | None):
        self.requests.append((method, url, payload))
        if url.endswith("/v1/agent-sessions"):
            return {"session": {"id": "session-1"}}
        if url.endswith("/steps/govern"):
            return {"decision": "allow", "reason": None, "containment": None, "trace_id": None}
        return {}

    def governed_steps(self) -> list[dict]:
        return [payload for _, url, payload in self.requests if url.endswith("/steps/govern")]

    def imported_events(self) -> list[dict]:
        return [event for _, url, payload in self.requests if url.endswith("/traces/import") for event in payload["events"]]


class SessionTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.transport = RecordingTransport()
        client = OrloLangGraphClient(base_url="https://orlo.test", org_id="org-1", transport=self.transport)
        self.session = OrloLangGraphSession(orlo_client=client, task_id="task-1")
        await self.session.__aenter__()
        self.handler = OrloLangGraphCallbackHandler(session=self.session)
