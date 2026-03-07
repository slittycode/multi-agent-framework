import { appendMessage, finalizeTranscript, initializeTranscript } from "../transcript/transcript-store";
import type {
  DomainAdapter,
  InterTurnHook,
  InterTurnHookResult,
  Message,
  Transcript
} from "../types";
import type { PreparedRunExecution } from "../run/prepare-run";
import { buildRunListEntry } from "./run-history";
import type {
  ApiRunCompleteEventMessage,
  ApiRunLifecycleEventMessage,
  ApiRunListEntry,
  ApiRunStartRequest,
  ApiRunStreamEvent
} from "./types";

type ServerRunStatus = "started" | "running" | "completed" | "failed";

interface PendingInjection {
  injectionId: string;
  content: string;
  fromLabel: string;
  targetPhaseId?: string;
}

interface PauseResumeOutcome {
  interrupt?: boolean;
  resumedFromPause?: boolean;
}

interface PauseState {
  paused: boolean;
  resumeSignal?: Promise<PauseResumeOutcome | void>;
  resolveResume?: (value?: PauseResumeOutcome | void) => void;
}

interface AgentOverrideState {
  systemPromptSuffix: string;
  turnsRemaining: number;
}

interface RunSubscriber {
  onEvent: (event: ApiRunStreamEvent) => void;
}

function createPauseState(): PauseState {
  return {
    paused: false
  };
}

export interface ServerRunState {
  runId: string;
  adapterId: string;
  topic: string;
  connectorId?: string;
  model?: string;
  status: ServerRunStatus;
  adapter: DomainAdapter;
  transcript: Transcript;
  persistedPath?: string;
  error?: string;
  pendingInjections: PendingInjection[];
  pauseState: PauseState;
  agentOverrides: Map<string, AgentOverrideState>;
  interruptRequested: boolean;
  pendingInterrupt?: { resumedFromPause?: boolean };
  events: ApiRunStreamEvent[];
  subscribers: Set<RunSubscriber>;
}

function buildSyntheticErrorMessage(runId: string, transcript: Transcript, error: unknown): Message {
  const previousMessage = transcript.messages.at(-1);
  const message = error instanceof Error ? error.message : "Run failed.";

  return {
    id: crypto.randomUUID(),
    runId,
    roundId: previousMessage?.roundId,
    phaseId: "runtime-error",
    turnIndex: transcript.messages.length + 1,
    timestamp: new Date().toISOString(),
    from: "orchestrator",
    to: "all",
    kind: "error",
    content: `Run failed: ${message}`,
    respondingToMessageId: previousMessage?.id,
    metadata: {
      source: "server"
    }
  };
}

function deriveMessageEventType(message: Message): "turn" | "synthesis" | "error" | "injection" {
  if (message.kind === "synthesis") {
    return "synthesis";
  }
  if (message.kind === "error") {
    return "error";
  }
  if (message.kind === "injection") {
    return "injection";
  }
  return "turn";
}

function buildLifecycleMessage(input: {
  runId: string;
  currentPhaseId?: string;
  currentRoundId?: string;
  turnIndex: number;
  resumedFromPause?: boolean;
}): ApiRunLifecycleEventMessage {
  return {
    runId: input.runId,
    currentPhaseId: input.currentPhaseId,
    currentRoundId: input.currentRoundId,
    turnIndex: input.turnIndex,
    ...(input.resumedFromPause !== undefined
      ? { resumedFromPause: input.resumedFromPause }
      : {})
  };
}

function buildInjectionMessage(input: {
  runId: string;
  roundId?: string;
  phaseId?: string;
  turnIndex: number;
  content: string;
  fromLabel: string;
  injectionId: string;
}): Message {
  return {
    id: crypto.randomUUID(),
    runId: input.runId,
    roundId: input.roundId,
    phaseId: input.phaseId,
    turnIndex: input.turnIndex,
    timestamp: new Date().toISOString(),
    from: input.fromLabel,
    to: "all",
    kind: "injection",
    content: input.content,
    metadata: {
      injectionId: input.injectionId
    }
  };
}

export class ServerRunManager {
  readonly #runs = new Map<string, ServerRunState>();

  createRun(preparedRun: PreparedRunExecution, request: ApiRunStartRequest): ServerRunState {
    const transcript = initializeTranscript({
      runId: preparedRun.runId,
      adapterId: preparedRun.adapter.id,
      topic: preparedRun.topic,
      metadata: preparedRun.metadata
    });

    const state: ServerRunState = {
      runId: preparedRun.runId,
      adapterId: preparedRun.adapter.id,
      topic: preparedRun.topic,
      connectorId: request.connectorId,
      model: request.model,
      status: "started",
      adapter: preparedRun.adapter,
      transcript,
      pendingInjections: [],
      pauseState: createPauseState(),
      agentOverrides: new Map(),
      interruptRequested: false,
      events: [],
      subscribers: new Set()
    };

    this.#runs.set(preparedRun.runId, state);
    return state;
  }

  getRun(runId: string): ServerRunState | undefined {
    return this.#runs.get(runId);
  }

  isActive(runId: string): boolean {
    const state = this.#runs.get(runId);
    return state?.status === "started" || state?.status === "running";
  }

  appendMessage(runId: string, message: Message): void {
    const state = this.#runs.get(runId);
    if (!state) {
      return;
    }

    state.transcript = appendMessage(state.transcript, message);
    state.status = "running";
    this.#pushEvent(state, {
      type: deriveMessageEventType(message),
      message
    });
  }

  recordLifecycleEvent(runId: string, event: ApiRunStreamEvent): void {
    const state = this.#runs.get(runId);
    if (!state) {
      return;
    }

    this.#pushEvent(state, event);
  }

  completeRun(runId: string, transcript: Transcript, persistedPath?: string): void {
    const state = this.#runs.get(runId);
    if (!state) {
      return;
    }

    state.transcript = transcript;
    state.persistedPath = persistedPath;
    state.status = transcript.status === "failed" ? "failed" : "completed";
    this.#warnForDroppedTargetedInjections(state);
    this.#pushEvent(state, {
      type: "complete",
      message: this.#buildCompleteMessage(state)
    });
    state.subscribers.clear();
  }

  failRun(runId: string, error: unknown, persistedPath?: string): void {
    const state = this.#runs.get(runId);
    if (!state) {
      return;
    }

    state.error = error instanceof Error ? error.message : "Run failed.";
    state.persistedPath = persistedPath;

    const hasErrorMessage = state.transcript.messages.some((message) => message.kind === "error");
    if (!hasErrorMessage && state.transcript.status === "running") {
      const errorMessage = buildSyntheticErrorMessage(runId, state.transcript, error);
      state.transcript = appendMessage(state.transcript, errorMessage);
      this.#pushEvent(state, {
        type: "error",
        message: errorMessage
      });
    }

    if (!state.transcript.endedAt) {
      state.transcript = finalizeTranscript(state.transcript, "failed");
    }

    state.status = "failed";
    this.#warnForDroppedTargetedInjections(state);
    this.#pushEvent(state, {
      type: "complete",
      message: this.#buildCompleteMessage(state)
    });
    state.subscribers.clear();
  }

  listActiveEntries(): ApiRunListEntry[] {
    return [...this.#runs.values()]
      .filter((state) => state.status === "started" || state.status === "running")
      .map((state) =>
        buildRunListEntry(state.transcript, {
          status: "running",
          endedAt: undefined
        })
      );
  }

  subscribe(runId: string, subscriber: RunSubscriber): () => void {
    const state = this.#runs.get(runId);
    if (!state) {
      return () => undefined;
    }

    state.subscribers.add(subscriber);

    return () => {
      state.subscribers.delete(subscriber);
    };
  }

  getEvents(runId: string): ApiRunStreamEvent[] {
    return [...(this.#runs.get(runId)?.events ?? [])];
  }

  buildCompleteMessage(runId: string): ApiRunCompleteEventMessage | undefined {
    const state = this.#runs.get(runId);
    if (!state || (state.status !== "completed" && state.status !== "failed")) {
      return undefined;
    }
    return this.#buildCompleteMessage(state);
  }

  queueInjection(
    runId: string,
    input: { content: string; fromLabel?: string; targetPhaseId?: string }
  ): string {
    const state = this.#requireRun(runId);
    this.#assertMutable(state);

    const content = input.content.trim();
    if (!content) {
      throw new Error("content is required.");
    }

    if (
      input.targetPhaseId &&
      !state.adapter.rounds.some((round) =>
        round.phases.some((phase) => phase.id === input.targetPhaseId)
      )
    ) {
      throw new Error(`Unknown targetPhaseId "${input.targetPhaseId}".`);
    }

    const injectionId = crypto.randomUUID();
    state.pendingInjections.push({
      injectionId,
      content,
      fromLabel: input.fromLabel?.trim() || "User",
      ...(input.targetPhaseId ? { targetPhaseId: input.targetPhaseId } : {})
    });

    return injectionId;
  }

  pauseRun(runId: string): void {
    const state = this.#requireRun(runId);
    if (!(state.status === "started" || state.status === "running")) {
      throw new Error("Run is not currently running.");
    }
    if (state.pauseState.paused) {
      throw new Error("Run is already paused.");
    }

    let resolveResume: ((value?: PauseResumeOutcome | void) => void) | undefined;
    const resumeSignal = new Promise<PauseResumeOutcome | void>((resolve) => {
      resolveResume = resolve;
    });

    state.pauseState = {
      paused: true,
      resumeSignal,
      resolveResume
    };
  }

  resumeRun(runId: string): void {
    const state = this.#requireRun(runId);
    if (!state.pauseState.paused || !state.pauseState.resolveResume) {
      throw new Error("Run is not paused.");
    }

    const resolveResume = state.pauseState.resolveResume;
    state.pauseState = createPauseState();
    resolveResume();
  }

  requestInterrupt(runId: string): { resumedFromPause: boolean } {
    const state = this.#requireRun(runId);
    this.#assertMutable(state);

    state.interruptRequested = true;

    if (state.pauseState.paused && state.pauseState.resolveResume) {
      const resolveResume = state.pauseState.resolveResume;
      state.pauseState = createPauseState();
      state.pendingInterrupt = {
        resumedFromPause: true
      };
      resolveResume({
        interrupt: true,
        resumedFromPause: true
      });
      return { resumedFromPause: true };
    }

    state.pendingInterrupt = {
      resumedFromPause: false
    };
    return { resumedFromPause: false };
  }

  queueSteer(
    runId: string,
    input: { agentId: string; directive: string; turnsRemaining: number }
  ): void {
    const state = this.#requireRun(runId);
    this.#assertMutable(state);

    if (!state.adapter.agents.some((agent) => agent.id === input.agentId)) {
      throw new Error(`Unknown agentId "${input.agentId}".`);
    }

    const directive = input.directive.trim();
    if (!directive) {
      throw new Error("directive is required.");
    }
    if (!(input.turnsRemaining === -1 || input.turnsRemaining > 0)) {
      throw new Error("turnsRemaining must be -1 or a positive integer.");
    }

    state.agentOverrides.set(input.agentId, {
      systemPromptSuffix: directive,
      turnsRemaining: input.turnsRemaining
    });
  }

  createInterTurnHook(runId: string): InterTurnHook {
    return async (stateInput) => {
      const state = this.#runs.get(runId);
      if (!state) {
        return undefined;
      }

      if (stateInput.boundary === "turn_complete" && stateInput.completedAgentId) {
        const existingOverride = state.agentOverrides.get(stateInput.completedAgentId);
        if (existingOverride && existingOverride.turnsRemaining > 0) {
          const nextTurnsRemaining = existingOverride.turnsRemaining - 1;
          if (nextTurnsRemaining <= 0) {
            state.agentOverrides.delete(stateInput.completedAgentId);
          } else {
            state.agentOverrides.set(stateInput.completedAgentId, {
              ...existingOverride,
              turnsRemaining: nextTurnsRemaining
            });
          }
        }
      }

      const firedInjections = state.pendingInjections.filter((injection) => {
        if (injection.targetPhaseId) {
          return (
            stateInput.boundary === "phase_start" &&
            stateInput.currentPhaseId === injection.targetPhaseId
          );
        }

        return true;
      });

      if (firedInjections.length > 0) {
        const firedIds = new Set(firedInjections.map((injection) => injection.injectionId));
        state.pendingInjections = state.pendingInjections.filter(
          (injection) => !firedIds.has(injection.injectionId)
        );
      }

      const injectedMessages = firedInjections.map((injection, index) =>
        buildInjectionMessage({
          runId: runId,
          roundId: stateInput.currentRoundId,
          phaseId: stateInput.currentPhaseId,
          turnIndex: stateInput.transcript.messages.length + index + 1,
          content: injection.content,
          fromLabel: injection.fromLabel,
          injectionId: injection.injectionId
        })
      );

      const nextTurnSystemPromptOverrides: Partial<Record<string, string>> = {};
      if (stateInput.nextAgentId) {
        const pendingOverride = state.agentOverrides.get(stateInput.nextAgentId);
        const agent = state.adapter.agents.find((candidate) => candidate.id === stateInput.nextAgentId);
        if (pendingOverride && agent) {
          nextTurnSystemPromptOverrides[stateInput.nextAgentId] =
            `${agent.systemPrompt}\n\n${pendingOverride.systemPromptSuffix}`;
        }
      }

      const hookResult: InterTurnHookResult = {};
      if (injectedMessages.length > 0) {
        hookResult.injectedMessages = injectedMessages;
      }
      if (state.pauseState.paused && state.pauseState.resumeSignal) {
        hookResult.pause = {
          resumeSignal: state.pauseState.resumeSignal
        };
      }
      if (state.pendingInterrupt) {
        hookResult.interrupt = state.pendingInterrupt;
        state.pendingInterrupt = undefined;
      }
      if (Object.keys(nextTurnSystemPromptOverrides).length > 0) {
        hookResult.nextTurnSystemPromptOverrides = nextTurnSystemPromptOverrides;
      }

      return Object.keys(hookResult).length > 0 ? hookResult : undefined;
    };
  }

  #requireRun(runId: string): ServerRunState {
    const state = this.#runs.get(runId);
    if (!state) {
      throw new Error(`Run "${runId}" was not found.`);
    }
    return state;
  }

  #assertMutable(state: ServerRunState): void {
    if (state.status === "completed" || state.status === "failed") {
      throw new Error("Run is already completed.");
    }
  }

  #buildCompleteMessage(state: ServerRunState): ApiRunCompleteEventMessage {
    return {
      runId: state.runId,
      status: state.status === "failed" ? "failed" : "completed",
      startedAt: state.transcript.startedAt,
      endedAt: state.transcript.endedAt,
      persistedPath: state.persistedPath
    };
  }

  #pushEvent(state: ServerRunState, event: ApiRunStreamEvent): void {
    state.events.push(event);
    for (const subscriber of state.subscribers) {
      subscriber.onEvent(event);
    }
  }

  #warnForDroppedTargetedInjections(state: ServerRunState): void {
    for (const injection of state.pendingInjections) {
      if (!injection.targetPhaseId) {
        continue;
      }

      console.warn(
        `Dropping targeted injection "${injection.injectionId}" for phase "${injection.targetPhaseId}" because run "${state.runId}" ended before that phase started.`
      );
    }
    state.pendingInjections = [];
  }
}
