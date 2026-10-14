# Registered tools keep the wrapper boundary for allowed, denied, and unavailable calls.
import unittest

from orlo_langgraph import GovernedToolRegistry, ToolDefinition, OrloGovernanceBlocked, OrloUnavailableError
from _support import SessionTestCase


class RegistryTests(SessionTestCase):
    async def test_registered_tool_runs_and_reports_both_steps(self):
        async def lookup(value: str) -> str:
            return value
        registry = GovernedToolRegistry(self.session, {"lookup": ToolDefinition(lookup, "read")})
        self.assertEqual(await registry.resolve("lookup")("42"), "42")
        await self.session.flush()
        self.assertEqual([s["step_type"] for s in self.transport.governed_steps()], ["tool_request", "tool_result"])
        self.assertEqual(registry.describe(), [{"name": "lookup", "action_class": "read", "when_unavailable": "stop"}])
        with self.assertRaises(TypeError):
            registry.tools["unwrapped"] = lookup
        with self.assertRaises(ValueError):
            registry.resolve("unknown")

    async def test_rejected_registered_tool_does_not_execute(self):
        ran = []
        async def lookup():
            ran.append(True)
        async def reject(_payload):
            return {"decision": "reject", "reason": "blocked"}
        self.session.govern_step = reject
        registry = GovernedToolRegistry(self.session, {"lookup": ToolDefinition(lookup, "read")})
        with self.assertRaises(OrloGovernanceBlocked):
            await registry.resolve("lookup")()
        self.assertEqual(ran, [])

    async def test_unavailable_registered_read_does_not_execute(self):
        ran = []
        async def lookup():
            ran.append(True)
        async def offline(_payload):
            raise OrloUnavailableError("offline")
        self.session.govern_step = offline
        registry = GovernedToolRegistry(self.session, {"lookup": ToolDefinition(lookup, "read")})
        with self.assertRaises(OrloUnavailableError):
            await registry.resolve("lookup")()
        self.assertEqual(ran, [])

    async def test_registration_is_validated_and_copied(self):
        async def lookup():
            return "original"
        tools = {"lookup": ToolDefinition(lookup, "read")}
        registry = GovernedToolRegistry(self.session, tools)
        tools.clear()
        self.assertEqual(await registry.resolve("lookup")(), "original")
        with self.assertRaises(ValueError):
            GovernedToolRegistry(self.session, {"bad": ToolDefinition(lookup, "typo")})
        await self.session.flush()


if __name__ == '__main__':
    unittest.main()
