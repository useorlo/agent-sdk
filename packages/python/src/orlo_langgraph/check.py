"""A harmless connection check using the real tool wrapper, without changing permissions."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from urllib.parse import urlencode, urlsplit
from urllib import request
from uuid import UUID

from . import OrloLangGraphClient, OrloLangGraphSession, OrloGovernanceBlocked, govern_tool


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _CheckClient(OrloLangGraphClient):
    @staticmethod
    def _perform(req, timeout):
        # A setup URL must never redirect the bearer key to another address.
        with request.build_opener(_NoRedirect).open(req, timeout=timeout) as response:
            return None if response.status == 204 else json.loads(response.read().decode("utf-8"))


async def run_check(expected: str) -> None:
    def required(name: str) -> str:
        value = os.environ.get(name, "").strip()
        if not value:
            raise ValueError(f"Set {name} before running the check.")
        return value

    base, org, task, key, console = [required(name) for name in (
        "ORLO_API_URL", "ORLO_ORG_ID", "ORLO_TASK_ID", "ORLO_API_KEY", "ORLO_CONSOLE_URL")]
    for address in (base, console):
        url = urlsplit(address)
        if url.username or url.password or url.query or url.fragment or not url.hostname or not (
            url.scheme == "https" or url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")
        ):
            raise ValueError("Use HTTPS addresses, or HTTP on localhost, without credentials or query parameters.")
    UUID(org)
    UUID(task)
    client = _CheckClient(base_url=base, org_id=org, headers={"Authorization": f"Bearer {key}"})
    async with OrloLangGraphSession(orlo_client=client, task_id=task, goal="Check the Orlo wrapper",
            framework="orlo-connection-check", metadata={"expected_outcome": expected},
            fail_mode={"default": "closed", "read": "closed"}) as session:
        origin = f"{urlsplit(console).scheme}://{urlsplit(console).netloc}"
        print(f"Run: {origin}/runs?{urlencode({'agent': task, 'run': session.session_id})}")
        print(f"Verify this check: {origin}/setup?{urlencode({'task': task, 'step': 'agent', 'check_run': session.session_id})}")
        executed = False
        decision = "allow"

        @govern_tool(session=session, tool_name="orlo_setup_check", action_class="read", auto_request_approval=False)
        async def check():
            nonlocal executed
            executed = True
            return {"ok": True}

        try:
            await check(orlo_step_id="orlo-setup-check")
        except OrloGovernanceBlocked as error:
            if executed:
                raise
            decision = error.decision
            await session.govern_step({"step_id": "orlo-setup-receipt", "step_type": "decision",
                "input": {"request_step_id": "orlo-setup-check", "applied_decision": decision, "tool_executed": False}})
        await session.close("completed" if executed else "cancelled")
        if session.unsent_steps:
            raise RuntimeError("Some wrapper reports could not be delivered. Inspect the run and retry.")
        print(f"Local tool {'ran and returned {ok:true}' if executed else 'did not run; decision: ' + decision}.")
        if decision == "require_approval":
            print("This sample did not request approval. Review the tool permission; use Allow or Block for these two checks.")
        if (expected == "allowed") != executed:
            raise RuntimeError(f"Expected {expected}, received {decision}. Review this agent's permission for orlo_setup_check, then rerun. The command did not change permissions.")
        print("Open the verification link to confirm Orlo received the matching wrapper report. This checks one tool only.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expect", choices=("blocked", "allowed"), required=True)
    args = parser.parse_args()
    try:
        asyncio.run(run_check(args.expect))
    except Exception as error:
        print(f"Check incomplete: {error}", file=sys.stderr)
        print("Check the gateway address, key, organization, task, and run limits. Inspect the run if one was created.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
