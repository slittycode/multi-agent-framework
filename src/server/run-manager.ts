import { appendMessage, finalizeTranscript, initializeTranscript } from "../transcript/transcript-store";
import type { Message, Transcript } from "../types";
import type { PreparedRunExecution } from "../run/prepare-run";
import { buildRunListEntry } from "./run-history";
import type { ApiRunCompleteEventMessage, ApiRunListEntry, ApiRunStartRequest } from "./types";

type ServerRunStatus = "started" | "running" | "completed" | "failed";

interface RunSubscriber {
  onMessage: (message: Message) => void;
  onComplete: (message: ApiRunCompleteEventMessage) => void;
}

export interface ServerRunState {
  runId: string;
  adapterId: string;
  topic: string;
  connectorId?: string;
  model?: string;
  status: ServerRunStatus;
  transcript: Transcript;
  persistedPath?: string;
  error?: string;
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
      transcript,
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

    for (const subscriber of state.subscribers) {
      subscriber.onMessage(message);
    }
  }

  completeRun(runId: string, transcript: Transcript, persistedPath?: string): void {
    const state = this.#runs.get(runId);
    if (!state) {
      return;
    }

    state.transcript = transcript;
    state.persistedPath = persistedPath;
    state.status = transcript.status === "failed" ? "failed" : "completed";
    this.#notifyComplete(state);
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
      for (const subscriber of state.subscribers) {
        subscriber.onMessage(errorMessage);
      }
    }

    if (!state.transcript.endedAt) {
      state.transcript = finalizeTranscript(state.transcript, "failed");
    }

    state.status = "failed";
    this.#notifyComplete(state);
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

  buildCompleteMessage(runId: string): ApiRunCompleteEventMessage | undefined {
    const state = this.#runs.get(runId);
    if (!state || (state.status !== "completed" && state.status !== "failed")) {
      return undefined;
    }

    return {
      runId: state.runId,
      status: state.status,
      startedAt: state.transcript.startedAt,
      endedAt: state.transcript.endedAt,
      persistedPath: state.persistedPath
    };
  }

  #notifyComplete(state: ServerRunState): void {
    const completeMessage = this.buildCompleteMessage(state.runId);
    if (!completeMessage) {
      return;
    }

    for (const subscriber of state.subscribers) {
      subscriber.onComplete(completeMessage);
    }
    state.subscribers.clear();
  }
}
