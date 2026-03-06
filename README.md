# Multi-Agent Framework

CLI framework for running structured multi-agent discussions, persisting transcripts, and certifying whether the final synthesis is actionable.

## Purpose

The framework is built around one operational question: does the synthesis produce concrete, prioritized next steps grounded in the discussion, rather than generic model filler?

Validation is split into two lanes:

- `baseline`: deterministic mock-mode regression coverage
- `live_certification`: real-provider evaluation used for actionability claims

Mock success is useful for testing. It is not treated as proof that the system is actionable in production.

## Commands

Core CLI:

```bash
bun run start -- list-adapters
bun run start -- run --adapter-id general-debate --topic "Should teams default to async communication?"
bun run start -- benchmark --output-dir ./benchmarks
```

Connector and auth management:

```bash
bun run start -- auth login --provider gemini --method api-key --use
bun run start -- auth login --provider kimi --method api-key --use --base-url https://api.moonshot.cn/v1
bun run start -- auth login --provider openai --method api-key --use
bun run start -- auth login --provider openai --method chatgpt-oauth
bun run start -- auth status
bun run start -- auth certify
bun run start -- auth logout --connector openai-main
bun run start -- connector list
bun run start -- connector use --connector gemini-main
```

Development gates:

```bash
bun run verify:offline
RUN_LIVE_PROVIDER_TESTS=1 bun run verify:live
```

## Connector Model

Live execution is connector-first.

- Stored connectors live in `.multi-agent-framework/connectors.json`
- Interactive credentials are stored in the OS credential store under service name `multi-agent-framework`
- Environment-backed connectors are discovered ephemerally from exported keys and appear as `gemini-env`, `kimi-env`, and `openai-env`
- The active connector persists until changed with `connector use` or another `auth login --use`
- Blocked connectors can be recorded in the catalog for planned-but-not-runnable auth methods; they are visible in `auth status` and `connector list` but are never selected for live execution

Execution resolution order for `run` and `benchmark`:

1. explicit `--connector <id>`
2. active connector from `.multi-agent-framework/connectors.json`
3. exactly one env-backed connector
4. mock fallback when execution mode is `auto`

If multiple live env connectors are present and none is selected, the CLI fails fast and asks you to choose one.

## Execution Modes

- `mock`: always use deterministic mock providers
- `live`: require a resolved live connector
- `auto`: use the selected live connector when available, otherwise fall back to mock

`--provider-mode` is still accepted as a backward-compatible alias for `--execution-mode`.

## Provider Matrix

| Provider | Recognized | Live-capable | Supported auth | Credential sources | Default model | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `gemini` | Yes | Yes | `api-key` | `env`, `keychain` | `gemini-2.5-flash` | Uses `GEMINI_API_KEY` |
| `kimi` | Yes | Yes | `api-key` | `env`, `keychain` | `moonshot-v1-8k` | Implemented but uncertified: requires a valid Moonshot platform API key from `platform.moonshot.cn` (separate from Kimi CLI credentials) |
| `openai` | Yes | Yes | `api-key`, `chatgpt-oauth` | `env`, `keychain`, `codex-app-server` | `gpt-4.1-mini` / app-server default | Uses `OPENAI_API_KEY` via the OpenAI Responses API or the local `codex app-server` ChatGPT browser flow |
| `claude` | Yes | No | none in this pass | none in this pass | n/a | Intentionally unsupported for live execution |
| `mock` | Yes | Mock only | n/a | n/a | n/a | Baseline regression coverage only |

OpenAI supports two live paths in this version:

- `api-key`: `OPENAI_API_KEY` or a stored keychain-backed connector using the OpenAI Responses API
- `chatgpt-oauth`: a stored connector backed by the local `codex app-server` ChatGPT browser flow

> [!IMPORTANT]
> OpenAI `chatgpt-oauth` requires a local `codex app-server` installation plus a browser-capable ChatGPT login flow. It is suitable for interactive local use, not headless CI environments.

## Environment

Copy values from `.env.example` into your shell or local env file before live runs:

- `GEMINI_API_KEY`
- `KIMI_API_KEY` from `platform.moonshot.cn`, not a Kimi CLI/session token
- `KIMI_BASE_URL`
- `OPENAI_API_KEY` when using OpenAI API-key connectors
- `RUN_LIVE_PROVIDER_TESTS`
- `RUN_BENCHMARK_TESTS`

For OpenAI ChatGPT OAuth, install the `codex` CLI and ensure the local `codex app-server` login flow can open a browser session.

Optional local/test overrides:

- `MAF_STATE_DIR`
- `MAF_CREDENTIAL_STORE_BACKEND`
- `MAF_CREDENTIAL_STORE_FILE`

Use the optional `MAF_*` overrides for tests or headless automation. Normal interactive use should rely on the repo-local connector catalog plus the OS credential store.

Kimi connectors remain implemented, but this repo currently treats them as uncertified until they are exercised with a valid Moonshot platform API key. Connector metadata surfaces this note in `auth status` and `connector list` so Kimi CLI credentials are not mistaken for the required API integration credential.

## Auth Workflow

Create and select a stored connector:

```bash
bun run start -- auth login --provider openai --method api-key --connector-id openai-main --use
```

This will:

- prompt for the API key
- write connector metadata to `.multi-agent-framework/connectors.json`
- store the secret in the OS credential store
- certify the connector immediately unless `--no-certify` is supplied

Create and select an OpenAI ChatGPT OAuth connector:

```bash
bun run start -- auth login --provider openai --method chatgpt-oauth --connector-id openai-oauth --use
```

This will:

- use the local `codex app-server` ChatGPT login flow
- open a browser login URL when needed
- use the current `codex app-server` default model unless `--model` is supplied
- store only non-secret connector metadata in `.multi-agent-framework/connectors.json`
- certify the connector immediately unless `--no-certify` is supplied

Check current status:

```bash
bun run start -- auth status
```

Recertify the current connector and persist a smoke-test artifact:

```bash
bun run start -- auth certify --output-dir ./runs/auth
```

Switch the active connector without re-entering credentials:

```bash
bun run start -- connector use --connector kimi-main
```

Environment-backed connectors remain ephemeral. You can run against `gemini-env`, `kimi-env`, or `openai-env` explicitly, but `connector use` only persists stored connectors created with `auth login`.

## Live Verification

Run the env-gated live smoke tests with:

```bash
RUN_LIVE_PROVIDER_TESTS=1 bun run verify:live
```

The script runs Gemini, OpenAI ChatGPT OAuth, and Kimi smoke tests individually and prints a pass/fail/skipped result for each provider. You can also limit the run to a subset:

```bash
RUN_LIVE_PROVIDER_TESTS=1 bun run verify:live -- gemini
```

Expected behavior:

- Gemini passes only when `GEMINI_API_KEY` is set and valid.
- OpenAI passes only in a local environment with `codex app-server` installed and an authenticated ChatGPT browser session.
- Kimi passes only with a valid Moonshot platform API key from `platform.moonshot.cn`.

The nightly GitHub Actions workflow runs `bun run verify:offline` plus Gemini live smoke only. OpenAI ChatGPT OAuth and Kimi are intentionally skipped in CI because those credentials are not suitable for a headless shared runner.

## Run Semantics

`run` prints:

- requested execution mode
- resolved execution mode
- selected connector and active connector
- evaluation tier
- provider support matrix
- streamed messages
- synthesis output
- actionability score and rubric breakdown

In live or auto mode, the selected connector rewrites every adapter agent to the chosen provider and default model unless you override the model explicitly with `--model`.

Example:

```bash
bun run start -- run --adapter-id general-debate --topic "Should teams default to async communication?" --execution-mode auto
```

## Benchmark Semantics

`benchmark` writes a JSON report plus supporting artifacts:

- `v02-benchmark-<timestamp>.json`: top-level report
- `transcripts/`: transcript JSON per scenario
- `debug/`: debug artifacts for failed or non-actionable scenarios

Report fields include:

- `evaluationTier`
- `providerMode`
- `executionMode`
- `resolvedExecutionMode`
- `providerIds`
- `connectorId`
- `activeConnectorId`
- `credentialSource`
- `certificationScope`
- `skippedConnectorIds`
- `skippedConnectorReasons`
- `rubricVersion`
- per-entry actionability subscores
- `failureReasons`
- `transcriptPath`
- `debugArtifactPath`

By default:

- `benchmark` in `mock` or mock-resolved `auto` mode stays in `baseline`
- `benchmark` in live mode certifies only the resolved connector
- `benchmark --all-connectors` runs the same matrix across every configured live connector and records skipped blocked/non-runnable connectors in the report

Token budget is reported separately from actionability:

- baseline reference: `15357`
- target budget: `11518`

Reducing tokens does not count as actionability by itself.

## Actionability Rubric

The quality gate scores:

- structural completeness
- recommendation specificity
- grounding to prior messages or citations
- non-redundancy
- prioritized next-step usefulness

The evaluator applies hard penalties for:

- generic filler
- repeated turns
- synthesis fallback
- missing recommendations

Default thresholds:

- baseline entry threshold: `60`
- live certification mean threshold: `80`
- live certification minimum per scenario: `70`

## Built-In Validation Matrix

Built-in adapters:

- `general-debate`
- `creative-writing`
- `ableton-feedback`

Fixture adapters used for framework and failure-path validation:

- `tests/fixtures/adapters/synthesis-failure-adapter.ts`
- `tests/fixtures/adapters/live-openai-adapter.ts`
- `tests/fixtures/adapters/live-gemini-adapter.ts`

## Quick Start

Baseline mock run:

```bash
bun run start -- run --adapter-id general-debate --topic "Should teams default to async communication?" --execution-mode mock
```

Connector-backed live run:

```bash
bun run start -- auth login --provider openai --method api-key --use
bun run start -- run --adapter-id general-debate --topic "Should teams default to async communication?"
```

Connector-backed live run with ChatGPT OAuth:

```bash
bun run start -- auth login --provider openai --method chatgpt-oauth --use
bun run start -- run --adapter-id general-debate --topic "Should teams default to async communication?"
```

Baseline benchmark:

```bash
bun run start -- benchmark --execution-mode mock --output-dir ./benchmarks/baseline
```

Single-connector live certification:

```bash
bun run start -- benchmark --execution-mode live --output-dir ./benchmarks/live
```

Cross-connector certification:

```bash
bun run start -- benchmark --execution-mode live --all-connectors --output-dir ./benchmarks/all-connectors
```

## Limitations

- OpenAI ChatGPT OAuth depends on a working local `codex app-server` installation and an interactive browser-capable login environment.
- `claude` remains a recognized provider id but is intentionally unsupported for live execution because many users only have `claude.ai` subscription access, while API-key execution would require a separate Anthropic billing relationship.
- Kimi is implemented but still marked uncertified until it is exercised with a valid Moonshot platform API key from `platform.moonshot.cn`.
- Top-level orchestrator execution remains `sequential` only. Use phase-level `fanout` for the supported concurrency model.
- `visibilityPolicy.participants` is a symmetric allowlist for both send and receive visibility in this pass.
- Live certification still depends on external provider health, quotas, and credentials.

### Confidence Boundary

The framework is validated against:

- the built-in adapter/topic matrix
- deterministic mock regression runs
- provider-specific live smoke tests when credentials are available

That is enough to measure regression health and connector behavior, but it is not evidence of soundness across arbitrary topics, domains, or specialized workflows. The honest claim boundary is: this system is tested on the shipped matrix and smoke prompts, with explicit failure diagnostics when a run degrades, not universally proven for every topic a user might choose.
