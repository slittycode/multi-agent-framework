# Multi-Agent Framework Repo Progress And UX Assessment

Snapshot date: 2026-03-07

## Executive Status

This repository is materially implemented as a Bun/TypeScript CLI for running structured multi-agent discussions, managing provider connectors, persisting transcripts, and benchmarking actionability. The shipped user surface is the terminal, not a browser application.

The framework is in a credible engineering state for continued development:

- `implemented`: CLI command surface for `auth`, `connector`, `list-adapters`, `run`, and `benchmark`
- `implemented`: transcript persistence, adapter loading, provider routing, and actionability scoring
- `implemented with caveats`: live-provider support and certification, because some providers depend on local-only credentials or remain uncertified
- `implemented with caveats`: orchestration enhancements such as phase judge, fanout phases, and optional web citation mode
- `not yet implemented`: browser UI, dashboard, or any frontend application layer

The highest-priority issue is not missing framework wiring. It is product confidence: the mock benchmark path currently produces failing actionability scores, so the system’s core output quality is not yet strong enough to justify building a larger end-user interface on top of it.

## What Is Built

### Implemented

| Area | Status | Evidence |
| --- | --- | --- |
| CLI entrypoint and command routing | implemented | [`src/cli/main.ts`](../src/cli/main.ts) exposes `auth`, `connector`, `list-adapters`, `benchmark`, and `run`. |
| Connector-first execution model | implemented | [`README.md`](../README.md) documents stored, env-backed, active, and blocked connectors. |
| Transcript creation and mutation | implemented | [`src/transcript/transcript-store.ts`](../src/transcript/transcript-store.ts) initializes, appends, and finalizes transcripts. |
| Transcript persistence | implemented | [`src/transcript/file-persistor.ts`](../src/transcript/file-persistor.ts) writes JSON and JSONL artifacts to disk. |
| Provider routing and live clients | implemented with caveats | [`README.md`](../README.md) and [`src/providers/provider-bootstrap.ts`](../src/providers/provider-bootstrap.ts) show Gemini, OpenAI, and Kimi live paths plus mock fallback. |
| Terminal UX renderer | implemented | [`src/cli/output/terminal-renderer.ts`](../src/cli/output/terminal-renderer.ts) renders run header, streamed messages, synthesis, and summary. |
| Nightly/live verification workflow | implemented with caveats | [`.github/workflows/verify-live.yml`](../.github/workflows/verify-live.yml) runs tests plus Gemini live smoke when the secret is present. |

### Implemented With Caveats

| Area | Caveat |
| --- | --- |
| Top-level orchestration | Only `sequential` execution is allowed at the top level; non-sequential execution raises `UNSUPPORTED_EXECUTION_MODE`. |
| Optional web citations | `optional_web` falls back through `NoopRetriever` or a warning-only `WebRetriever` when no fetcher is wired. |
| OpenAI ChatGPT OAuth | Works only in a local interactive environment with `codex app-server` and browser login. |
| Kimi | Client and connector flows are implemented, but the repo still treats Kimi as uncertified until validated with a Moonshot platform key. |
| Benchmarks | Benchmark reporting works, but the baseline mock run currently fails the actionability threshold and exits non-zero. |

### Not Yet Implemented

| Area | Status | Evidence |
| --- | --- | --- |
| Browser UI / web dashboard | not yet implemented | Repo scan found no `.tsx`, `.jsx`, `.html`, or `.css` app surface in the project root or first-level subdirectories. |
| Frontend UX for end users | not yet implemented | The user interaction model is entirely command-line based today. |

## What Is Verified

The repo currently has strong automated test coverage and a working build path.

- `bun run verify:offline` passed in this environment.
- The offline gate ran `tsc --noEmit`, `bun test`, and `bun build src/cli/main.ts --outdir dist --target bun`.
- `bun test` completed with `189 pass`, `4 skip`, `0 fail`.
- `bun run start -- list-adapters` returned the three built-in adapters: `ableton-feedback`, `creative-writing`, and `general-debate`.
- `bun run start -- auth status` and `bun run start -- connector list` showed a ready `gemini-env` connector in this environment.
- `bun run start -- run --adapter-id general-debate --topic "How should a small team decide between CLI and web UI?" --execution-mode mock --no-persist` completed successfully and rendered a full terminal run summary.
- `bun run start -- benchmark --execution-mode mock --output-dir /tmp/maf-benchmark-plan` produced a report and exited non-zero because every benchmark entry missed the actionability threshold.

## Current User Journey And UX

Today’s product UX is a developer/operator CLI. A typical user flow looks like this:

1. Discover available workflows with `list-adapters`.
2. Inspect live capability with `auth status` and `connector list`.
3. Optionally authenticate a stored connector with `auth login`.
4. Run a discussion with `run --adapter-id ... --topic ...`.
5. Read the streamed turn-by-turn output, synthesis, and actionability summary in the terminal.
6. Run `benchmark` to assess broader baseline or live behavior across the shipped matrix.

### What Works Well In The Current UX

- The command surface is compact and legible. The entrypoint exposes a small number of clear verbs.
- The run output is readable. Header, message stream, synthesis, and summary are separated cleanly.
- Connector state is explicit. The CLI shows selected connector, active connector, credential source, and runtime status.
- The framework surfaces failure states rather than hiding them. Invalid flags, missing topics, blocked connectors, and failed quality gates are all covered by integration tests.
- Benchmark output is operationally useful. It prints progress, a summary table, and a persisted report path.

### Current UX Friction

- The UX is operator-friendly, not end-user-friendly. It assumes terminal fluency and knowledge of command flags.
- `auth login` for API keys relies on terminal prompts rather than a richer guided flow.
- Benchmark output is dense but still terminal-only, which makes comparison across runs harder than it needs to be.
- The system exposes actionability failure clearly, but it does not yet help the user recover from weak synthesis quality.
- There is no visual explorer for transcripts, connector state, benchmark history, or provider comparison.

## Findings, Gaps, And Risks

### Product And Technical Risks

1. The biggest near-term risk is output quality, not framework plumbing. The mock benchmark path currently fails its own quality threshold, which weakens confidence in the framework’s default outputs.
2. The current user experience is entirely terminal-driven. That is appropriate for developers and operators, but it limits broader evaluation of end-user UX.
3. Live certification coverage is partial. Gemini can run in CI when configured, but OpenAI ChatGPT OAuth is local-only and Kimi remains uncertified.
4. Optional web citation support is structurally present, but not operationally useful until a real fetcher is wired into the retriever layer.
5. Top-level orchestration remains intentionally constrained to sequential execution, which narrows the concurrency story for future scale-out usage.

### Documentation And Status Gaps

1. [`docs/checkpoints/2026-03-05-step-4.5-wiring-checkpoint.md`](../docs/checkpoints/2026-03-05-step-4.5-wiring-checkpoint.md) is stale. It still describes transcript store, serializer, and file persistor modules as stubbed or contract-only, while the current code implements those behaviors and the test suite verifies them.
2. [`README.md`](../README.md) says the nightly GitHub Actions workflow runs the offline suite plus Gemini live smoke. The actual workflow step named "Run offline suite" currently runs `bun test`, not the full `bun run verify:offline` command. That is a minor but real docs/CI mismatch.

## Advisable Next Steps

1. Refresh stale documentation and repo status notes first.
   - Update the step-checkpoint narrative so it no longer describes implemented transcript and persistence code as stubbed.
   - Align README wording with the actual CI workflow, or expand the workflow to run the full offline gate.

2. Improve actionability and baseline credibility next.
   - Use the failing mock benchmark report as the starting point for synthesis/prompt/rubric tuning.
   - Treat a passing, reproducible baseline benchmark as the threshold for stronger product claims.

3. Widen live-certification coverage after baseline quality improves.
   - Keep Gemini CI smoke in place.
   - Add a deliberate local certification workflow for OpenAI ChatGPT OAuth.
   - Exercise and certify Kimi with the correct Moonshot platform credential path.

4. Prototype a minimal dashboard only after the core outcomes are trustworthy.
   - Keep the CLI as the operator/developer surface.
   - If a broader interface is desired, build a thin web dashboard or run explorer around the existing core/orchestrator modules rather than rewriting the system as a frontend-first app.
   - Scope the first dashboard to inspection, not orchestration authoring: transcript browsing, benchmark history, connector status, and run summaries.

## Recommended UI Direction

The repo does not need a full frontend pivot yet. The advisable interface strategy is:

- preserve the CLI as the canonical control plane for engineering and ops
- use the CLI and persisted run artifacts as the source of truth
- add a lightweight web dashboard only when the benchmark and actionability story are reliable enough to merit wider UX investment

This keeps current progress usable while avoiding premature UI work over a still-maturing quality layer.

## Confidence Boundary

This assessment supports the following claim:

The repository contains a functioning CLI framework with verified offline tests, implemented transcript and connector plumbing, and a working benchmark/reporting loop. It is ready for further iteration as an engineering system.

This assessment does not support the following claim:

The framework is already validated as a high-confidence end-user product across arbitrary topics, providers, or UI modes.

The current evidence is bounded to:

- shipped built-in adapters and fixture coverage
- offline automated verification in this environment
- environment-specific connector visibility
- mock-run UX inspection
- partial live-smoke and CI coverage as documented in the repo

## Appendix: CLI Evidence Excerpts

### `bun run start -- list-adapters`

```text
Built-in adapters:
- ableton-feedback
- creative-writing
- general-debate
```

### `bun run start -- auth status`

```text
Connector: gemini-env
Provider: gemini
Auth method: api-key
Runtime status: ready
Credential source: env
```

### `bun run start -- connector list`

```text
Connectors:
- gemini-env: provider=gemini, auth=api-key, source=env [env], model=gemini-2.5-flash, status=ready
```

### `bun run start -- run --adapter-id general-debate --topic "How should a small team decide between CLI and web UI?" --execution-mode mock --no-persist`

```text
=== Multi-Agent Discussion Run ===
Execution Mode: mock
Resolved Execution Mode: mock
Evaluation Tier: baseline
...
=== Run Summary ===
Status: completed
Messages: 7
Actionability Score: 7.50/75 (failed)
Transcript persistence: disabled
```

### `bun run start -- benchmark --execution-mode mock --output-dir /tmp/maf-benchmark-plan`

```text
Evaluation Tier: baseline
Benchmark Summary
...
Report written: /tmp/maf-benchmark-plan/v02-benchmark-1772836660502.json
error: script "start" exited with code 1
```
