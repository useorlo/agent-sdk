"""Production sessions pass an adopted configuration through without changing existing defaults."""
from __future__ import annotations

import unittest

from _support import RecordingTransport
from orlo_langgraph.client import OrloLangGraphClient
from orlo_langgraph.session import OrloLangGraphSession


class QualifiedConfigurationTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_sends_exact_qualified_configuration(self) -> None:
        transport = RecordingTransport()
        client = OrloLangGraphClient(base_url="https://orlo.test", org_id="org-1", transport=transport)
        binding = {"qualification_id": "qualification-1", "manifest": {"version": 1, "key": "candidate"}}
        session = OrloLangGraphSession(orlo_client=client, task_id="task-1", qualified_configuration=binding)
        await session.__aenter__()
        create = next(payload for method, url, payload in transport.requests if method == "POST" and url.endswith("/v1/agent-sessions"))
        self.assertEqual(create["qualified_configuration"], binding)
        await session.close()

    async def test_session_omits_binding_by_default(self) -> None:
        transport = RecordingTransport()
        client = OrloLangGraphClient(base_url="https://orlo.test", org_id="org-1", transport=transport)
        session = OrloLangGraphSession(orlo_client=client, task_id="task-1")
        await session.__aenter__()
        create = next(payload for method, url, payload in transport.requests if method == "POST" and url.endswith("/v1/agent-sessions"))
        self.assertNotIn("qualified_configuration", create)
        await session.close()
