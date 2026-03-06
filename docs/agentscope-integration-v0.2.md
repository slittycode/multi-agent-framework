# AgentScope-Inspired Integration (v0.2)

This document describes the stabilized integration of AgentScope-inspired orchestration concepts into the multi-agent framework.

## What was integrated

### 1. Round Judge (early-stop)

- Optional `orchestrator.judge` runs after each round.
- Judge returns structured decision metadata.
- If `decision.finished === true`, the orchestrator stops remaining rounds and proceeds to terminal synthesis.
- Judge records are stored in `transcript.metadata.judgeRounds`.

### 2. Phase Judge (steering)

- Optional `orchestrator.phaseJudge` runs after each phase.
- Phase judge can emit `steeringDirectives` used to guide prompts in the next phase.
- Phase judge records are stored in `transcript.metadata.judgePhases`.

### 3. Fanout execution mode

- `RoundPhase.executionMode` supports:
  - `sequential` (default)
  - `fanout`
- Fanout uses a shared transcript snapshot and concurrent provider calls.
- Merge is deterministic by `turnOrder`.

### 4. Visibility policy

- `RoundPhase.visibilityPolicy.participants` scopes phase message visibility.
- MVP policy is symmetric (same participant set for send and receive).
- System/user/orchestrator messages remain visible.
- Future enhancement: split into directional `receiveFrom`/`publishTo` rules.

### 5. Invocation tracing

- `ProviderGenerateResult.invocationId` is propagated to:
  - round messages (`message.providerInvocationId`)
  - synthesis messages (`message.providerInvocationId`)
  - judge records (`providerInvocationId`)

## Extended v0.2 orchestration controls

- `contextPolicy` (`full` or `round_plus_recent`)
- `citations` (`transcript_only` or `optional_web`)
- `qualityGate` (score threshold with optional fail-fast)

These remain optional and default-safe.

## Metadata behavior (lazy initialization)

- `transcript.metadata.judgeRounds` is created only when a round judge record is first written.
- `transcript.metadata.judgePhases` is created only when a phase judge record is first written.
- If a judge mode is never used, its metadata array is absent in persisted transcripts.

## CLI defaults and compatibility

CLI defaults remain conservative:

- execution model remains sequential
- citations default to `transcript_only`
- judges are disabled unless explicitly configured

## Migration note

`buildTurnPrompt` and `buildProviderRequest` now support older call sites without explicit context/citation arguments.

- `contextPolicy` is optional and defaults to `round_plus_recent` with 4 recent cross-round messages.
- `citationsMode` is optional and defaults to `transcript_only`.

No mandatory caller changes are required for existing integrations.
