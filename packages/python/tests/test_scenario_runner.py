"""The Python runner uses the same test context, cleanup, receipt, and bounded concurrency contract."""
from __future__ import annotations

import asyncio
import unittest

from orlo_langgraph import OrloLangGraphClient, OrloScenarioRunner, ScenarioTrialAssignment, evaluate_authoritative_state_verifier, run_scenario_trials


class Transport:
    def __init__(self):
        self.requests = []

    def __call__(self, method, url, headers, payload):
        self.requests.append((method, url, headers, payload))
        if url.endswith("/v1/agent-sessions"):
            return {"session": {"id": "session-1", "task_id": "task-1", "status": "active", "activity_kind": "scenario_test"}}
        if url.endswith("/receipt"):
            return {"trial_id": "trial-1", "status": payload["status"], "receipt_id": payload["receipt_id"], "recorded": True}
        return {}


class Environment:
    def __init__(self, cleanup="succeeded"):
        self.prepared = None
        self.cleanup_status = cleanup

    async def prepare(self, initial_state):
        self.prepared = initial_state

    async def cleanup(self):
        return {"status": self.cleanup_status, **({"detail": "fixture dirty"} if self.cleanup_status == "failed" else {})}


class ScenarioRunnerTests(unittest.IsolatedAsyncioTestCase):
    def assignment(self, trial_id="trial-1"):
        return ScenarioTrialAssignment(trial_id, "task-1", "secret", {"version": 1, "initial_state": {"order": "open"},
            "interactions": [{"after_turn": 0, "actor": "user", "content": "Help"}],
            "budgets": {"max_turns": 4, "max_tool_calls": 2, "max_duration_ms": 1000, "max_cost_usd": 1}})

    async def test_delivers_test_context_and_authenticated_receipt(self):
        transport = Transport()
        runner = OrloScenarioRunner(OrloLangGraphClient("https://orlo.test", "org-1", transport=transport))
        environment = Environment()
        result = await runner.run(self.assignment(), environment, lambda context: asyncio.sleep(0, result={"status": "completed", "metrics": {"turns": 2, "tool_calls": 0, "cost_usd": 0}}))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(environment.prepared, {"order": "open"})
        create = transport.requests[0]
        self.assertEqual(create[3]["test_context"], {"kind": "scenario_trial", "trial_id": "trial-1", "execution_token": "secret"})
        receipt = transport.requests[1]
        self.assertEqual(receipt[2]["X-Orlo-Scenario-Token"], "secret")

    async def test_cleanup_failure_is_invalid(self):
        transport = Transport()
        runner = OrloScenarioRunner(OrloLangGraphClient("https://orlo.test", "org-1", transport=transport))
        result = await runner.run(self.assignment(), Environment("failed"), lambda context: asyncio.sleep(0, result={"status": "completed"}))
        self.assertEqual(result["status"], "invalid")
        self.assertEqual(transport.requests[-1][3]["failure"]["cleanup"], "fixture dirty")

    async def test_batch_concurrency_is_bounded(self):
        active = 0
        maximum = 0
        async def run(item):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            await asyncio.sleep(.01)
            active -= 1
            return {"trial_id": item.trial_id}
        results = await run_scenario_trials([self.assignment(str(index)) for index in range(6)], 2, run)
        self.assertEqual(maximum, 2)
        self.assertEqual(len(results), 6)

    async def test_authoritative_state_is_checked_outside_agent_output(self):
        declaration = {"key": "refund_state", "version": "1", "implementation_hash": "a" * 64, "dimension": "outcome",
            "evidence_source": "authoritative_state", "mandatory": True, "specification": {"path": "/order/status", "equals": "refunded"}}
        passed = evaluate_authoritative_state_verifier(declaration, {"order": {"status": "refunded"}}, "fixture:order-1")
        failed = evaluate_authoritative_state_verifier(declaration, {"order": {"status": "open"}}, "fixture:order-1")
        self.assertEqual(passed["status"], "passed")
        self.assertEqual(failed["status"], "failed")
        present_array = evaluate_authoritative_state_verifier({**declaration, "specification": {"path": "/items/0", "absent": True}}, {"items": ["present"]}, "fixture:list")
        distinct_json_types = evaluate_authoritative_state_verifier({**declaration, "specification": {"path": "/value", "equals": 1}}, {"value": True}, "fixture:types")
        self.assertEqual(present_array["status"], "failed")
        self.assertEqual(distinct_json_types["status"], "failed")


if __name__ == "__main__":
    unittest.main()
