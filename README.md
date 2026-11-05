# Orlo Agent SDKs

Connect tools in your application to Orlo. A wrapper asks Orlo for a decision before a tool executes, then reports its result. Your application owns execution and orchestration.

- [TypeScript SDK](packages/typescript/README.md): ordinary async functions, typed API client, shared skills, and a connection-check command.
- [Python SDK](packages/python/README.md): ordinary Python tools plus LangChain and LangGraph integration.

Install the TypeScript SDK from [npm](https://www.npmjs.com/package/@orlo/agent-sdk):

```sh
npm install --save-exact @orlo/agent-sdk@0.0.2
```

The latest resource and complete-workflow support is in the attested 0.0.3 archives on the [release page](https://github.com/useorlo/agent-sdk/releases/tag/v0.0.3). npm publication of 0.0.3 is pending registry authorization. For those features, use the matching console download or verify and install the release archive.

Start with **Connect your agent** in your Orlo console. Set the environment values, run the harmless connection check, and open its exact result. No model-provider key is required for the check. The console also offers matching versioned downloads. Python 0.1.2 is available as an attested archive in the [public release](https://github.com/useorlo/agent-sdk/releases/tag/v0.0.3). It is not yet on PyPI. The console supplies the matching archive and a hash-checked installation command.

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

Shared skill retrieval grants no tool permission. Approval retries must use the original step ID and arguments. Finish each run to flush pending reports, and inspect the unsent-report count. Retries are bounded and held in memory; there is no persistent replay queue, and delivery is not guaranteed.

## Releases and compatibility

SDK changes are maintained here. TypeScript and Python have separate versions and release schedules. Console builds pin verified public release archives and copy their bytes unchanged. They do not rebuild those downloads from private source. New optional API fields must remain backward compatible; breaking protocol changes require a versioned migration and matching server contract tests. Do not regenerate this checkout from the private monorepo after contributors start working here.

Published releases carry npm provenance. The release workflow verifies anonymous installation and both CLI commands, tests the Python archive, and publishes build attestations for both archives. See [release notes](RELEASE-NOTES.md) for the changed outage default and tool registries. Compatibility CI builds and tests; publication uses the separate manual workflow described in [RELEASING.md](RELEASING.md).

Apache-2.0. See [LICENSE](LICENSE).

## Approval recovery

SDK 0.0.3 and Python 0.1.2 include bounded approval waits and reattachment to existing runs. See [Resume work after an approval](docs/approvals.md) for TypeScript and Python examples, cancellation, and durable recovery. No waiter executes a tool; retry the exact governed action after approval.

## Resource permissions and complete workflows

TypeScript can pass a verified person token, register a resource handler, and apply the exact field, record and destination limits returned by Orlo. The handler must implement the limits and explicitly report which took effect. Unknown contracts, unsupported limits and outages stop resource operations. Python wrappers stop on resource contracts and do not implement these limits. Both SDKs support complete-workflow trial receipts; the application still supplies the runner, fixture and independent verifiers.
