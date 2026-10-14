# Agent SDK 0.0.2 and Python adapter 0.1.1

All tool calls now stop by default when Orlo is unavailable, including reads. Applications that intentionally accept the outage risk can explicitly opt in by action class. This changes the previous read default.

Both SDKs now provide tool registries: register implementations and action classes once, then expose only the governed call path to the host. Unknown tools are refused. Registries cannot intercept tools outside that path.

Background reporting uses bounded retries in memory. It is not durable, and flushing does not replay reports after recovery. The SDK exposes unsent-report counts; applications must inspect them when evidence completeness matters.

Install TypeScript with `npm install @orlo/agent-sdk@0.0.2`. The Python source distribution is attached here; PyPI publication remains separate. Release assets include SHA-256 checksums and GitHub build attestations.

Verify downloaded archives before installation:

```sh
gh attestation verify orlo-agent-sdk-0.0.2.tgz --repo useorlo/agent-sdk
gh attestation verify orlo_langgraph-0.1.1.tar.gz --repo useorlo/agent-sdk
```

For npm installations, `npm audit signatures` verifies registry signatures and available provenance. Attestations establish build origin, not the security of the code.
