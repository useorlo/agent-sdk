# Orlo Agent SDKs

Connect tools in your application to Orlo. A wrapper asks Orlo for a decision before a tool executes, then reports its result. Your application owns execution and orchestration.

- [TypeScript SDK](packages/typescript/README.md): ordinary async functions, typed API client, shared skills, and a connection-check command.
- [Python SDK](packages/python/README.md): ordinary Python tools plus LangChain and LangGraph integration.

Install the TypeScript SDK from [npm](https://www.npmjs.com/package/@orlo/agent-sdk):

```sh
npm install @orlo/agent-sdk@0.0.1
```

Start with **Connect your agent** in your Orlo console. Set the environment values, run the harmless connection check, and open its exact result. No model-provider key is required for the check. The console also offers matching versioned downloads. Python is not yet published on PyPI; use its console download or build from source.

## Development

Node.js 20+ and Python 3.10+ are supported. Run the TypeScript build and tests:

```sh
npm ci
npm run build
npm test
npm run typecheck
```

Run Python and framework tests:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e './packages/python[langgraph]' 'langchain-core==1.6.10' 'langgraph==1.2.15'
python -B -m unittest discover -s packages/python/tests -v
```

## Boundaries

The TypeScript function wrapper and Python LangChain/LangGraph integration are public SDK code. Orlo’s API, workers, database, and internal model-provider adapters are maintained separately.

SDK wrappers stop denied calls only when the application uses them around the actual implementation. Callbacks provide trace evidence; they do not prevent unwrapped tool execution. All tool actions stop by default when Orlo is unavailable. An application can explicitly allow an action class to continue, accepting the permission and reporting gap. Choose and document the outage behavior for your application.

Shared skill retrieval grants no tool permission. Approval retries must use the original step ID and arguments. Finish each run so its background reports are delivered, and check the unsent-report count when delivery matters.

## Releases and compatibility

SDK changes are maintained here. TypeScript and Python have separate versions and release schedules. The private Orlo platform currently builds matching workspace copies for its console downloads; migration to pinned package releases follows registry publication. New optional API fields must remain backward compatible; breaking protocol changes require a versioned migration and matching server contract tests. Do not regenerate this checkout from the private monorepo after contributors start working here.

TypeScript version `0.0.1` is published with provenance. The [registry verification](https://github.com/useorlo/agent-sdk/actions/runs/38599129445) installed it without a token and checked both commands. Compatibility CI builds and tests; publication uses the separate manual workflow described in [RELEASING.md](RELEASING.md).

Apache-2.0. See [LICENSE](LICENSE).
