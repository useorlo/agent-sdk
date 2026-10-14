# Exercise an actual compiled graph: allowed tools run once; denied tools never execute.
from __future__ import annotations

import unittest
from typing import TypedDict
from _support import SessionTestCase
from orlo_langgraph import OrloGovernanceBlocked, govern_tool, GovernedToolRegistry, ToolDefinition

try:
    from langgraph.graph import StateGraph, START, END
except ImportError:
    StateGraph = None


class State(TypedDict):
    answer: str


@unittest.skipIf(StateGraph is None, "langgraph is not installed")
class CompiledGraphTests(SessionTestCase):
    async def run_graph(self, decision: str, registered: bool = False):
        original = self.session.orlo_client.transport
        calls = []

        def transport(method, url, headers, payload):
            result = original(method, url, headers, payload)
            if url.endswith('/steps/govern') and payload['step_type'] == 'tool_request':
                result['decision'] = decision
            return result

        self.session.orlo_client.transport = transport

        async def lookup():
            calls.append('executed')
            return 'found'

        wrapped = GovernedToolRegistry(self.session, {'local_lookup': ToolDefinition(lookup, 'read')}, auto_request_approval=False).resolve('local_lookup') if registered else govern_tool(session=self.session, tool_name='local_lookup', action_class='read', auto_request_approval=False)(lookup)

        async def node(state: State):
            return {'answer': await wrapped()}

        graph = StateGraph(State)
        graph.add_node('lookup', node)
        graph.add_edge(START, 'lookup')
        graph.add_edge('lookup', END)
        compiled = graph.compile()
        try:
            if decision == 'allow':
                result = await compiled.ainvoke({'answer': ''}, config={'callbacks': [self.handler]})
                self.assertEqual(result['answer'], 'found')
                self.assertEqual(calls, ['executed'])
            else:
                with self.assertRaises(OrloGovernanceBlocked):
                    await compiled.ainvoke({'answer': ''}, config={'callbacks': [self.handler]})
                self.assertEqual(calls, [])
            steps = self.transport.governed_steps()
            self.assertEqual(sum(step['step_type'] == 'tool_request' for step in steps), 1)
            self.assertEqual(sum(step['step_type'] == 'tool_result' for step in steps), int(decision == 'allow'))
        finally:
            await self.session.close()

    async def test_allowed_tool_in_compiled_graph(self):
        await self.run_graph('allow')

    async def test_rejected_tool_in_compiled_graph(self):
        await self.run_graph('reject')

    async def test_approval_required_tool_in_compiled_graph(self):
        await self.run_graph('require_approval')

    async def test_registered_tool_in_compiled_graph(self):
        await self.run_graph('allow', registered=True)

    async def test_registered_tool_is_blocked_in_compiled_graph(self):
        await self.run_graph('reject', registered=True)
