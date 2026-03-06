# Multi-Agent Framework

CLI framework for running structured multi-agent discussions, persisting transcripts, and benchmarking whether synthesis output is actually actionable.

## Purpose

This project orchestrates domain adapters composed of multiple agents, rounds, and synthesis logic. It is designed to answer one practical question: does the final output produce concrete, prioritized next steps rather than generic model prose?

The framework now separates:

- `baseline` validation: deterministic mock-mode health checks and regression coverage
- `live_certification`: real-provider validation for actionability claims

Mock runs are useful for reproducible testing. They are not treated as proof that the application is actionable.

## Supported Commands

```bash
bun run start -- list-adapters
bun run start -- run --adapter-id general-debate --topic "Should teams default to async communication?"
bun run start -- benchmark --output-dir ./benchmarks
```

Useful dev commands:

```bash
bun run typecheck
bun test
bun run build
```

## Provider Matrix

| Provider | Recognized | Live-capable | Notes |
| --- | --- | --- | --- |
| `gemini` | Yes | Yes | Requires `GEMINI_API_KEY` |
| `kimi` | Yes | Yes | Requires `KIMI_API_KEY`; optional `KIMI_BASE_URL` |
| `openai` | Yes | No | Explicitly unsupported for live execution in this pass |
| `claude` | Yes | No | Explicitly unsupported for live execution in this pass |
| `mock` | Yes | Mock only | Deterministic baseline coverage |

## Environment

Copy values from `.env.example` into your environment before live runs:

- `GEMINI_API_KEY`
- `KIMI_API_KEY`
- `KIMI_BASE_URL`
- `RUN_LIVE_PROVIDER_TESTS`
- `RUN_BENCHMARK_TESTS`

The live smoke tests stay skipped unless `RUN_LIVE_PROVIDER_TESTS=1` and the relevant keys are present.

## Run Semantics

`run` prints:

- provider mode
- evaluation tier
- provider support matrix for the selected adapter
- streamed messages
- synthesis output
- actionability score and rubric breakdown

Built-in adapters enable the quality gate by default, so the persisted transcript metadata includes the actionability rubric result.

## Benchmark Semantics

`benchmark` writes a JSON report with:

- `evaluationTier`
- `providerMode`
- `providerIds`
- `rubricVersion`
- per-entry actionability subscores
- failure reasons
- transcript paths
- debug artifact paths for failing entries

Artifacts are written under the chosen output directory:

- `transcripts/`: persisted transcript JSON files per benchmark run
- `debug/`: failure-focused debug JSON artifacts
- `v02-benchmark-<timestamp>.json`: top-level report

Token budget is tracked separately from actionability:

- baseline reference: `15357`
- target budget: `11518`

Reducing tokens does not count as actionability by itself.

## Certification Defaults

Live certification requires:

- both Gemini and Kimi to run the built-in scenario matrix
- mean actionability score `>= 80`
- no individual scenario score below `70`

Baseline mock benchmarking keeps the historical `75` entry threshold for regression tracking, but it is still reported as `baseline`, not certification.

## Current Limitations

- `openai` and `claude` are recognized provider IDs but do not have live client implementations here.
- Live benchmark certification depends on external credentials and provider availability.
- Retrieval remains optional and defaults to graceful transcript-only behavior when no retriever is configured.

## Validation Matrix

- Built-in adapters: `general-debate`, `creative-writing`, `ableton-feedback`
- Synthetic framework/error fixtures: `synthesis-failure-adapter.ts`, `live-openai-adapter.ts`

## Quick Start

Mock baseline run:

```bash
bun run start -- run --adapter-id general-debate --topic "Should teams default to async communication?" --provider-mode mock
```

Mock baseline benchmark:

```bash
bun run start -- benchmark --provider-mode mock --output-dir ./benchmarks
```

Live certification benchmark:

```bash
bun run start -- benchmark --provider-mode live --output-dir ./benchmarks/live
```
