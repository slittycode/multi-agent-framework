import type { Message, RunId, SynthesisOutput, Transcript } from "../types";

export interface InitializeTranscriptInput {
  runId: RunId;
  adapterId: string;
  topic: string;
  metadata?: Record<string, unknown>;
}

export class TranscriptStoreError extends Error {}

export class TranscriptRunMismatchError extends TranscriptStoreError {
  constructor(transcriptRunId: RunId, messageRunId: RunId) {
    super(
      `Cannot append message with runId "${messageRunId}" to transcript "${transcriptRunId}".`
    );
    this.name = "TranscriptRunMismatchError";
  }
}

export class TranscriptNotRunningError extends TranscriptStoreError {
  constructor(status: Transcript["status"]) {
    super(`Cannot append message when transcript status is "${status}".`);
    this.name = "TranscriptNotRunningError";
  }
}

export class TranscriptAlreadyFinalizedError extends TranscriptStoreError {
  constructor(runId: RunId) {
    super(`Transcript "${runId}" has already been finalized.`);
    this.name = "TranscriptAlreadyFinalizedError";
  }
}

export function initializeTranscript(input: InitializeTranscriptInput): Transcript {
  return {
    runId: input.runId,
    adapterId: input.adapterId,
    topic: input.topic,
    startedAt: new Date().toISOString(),
    status: "running",
    messages: [],
    metadata: input.metadata ? { ...input.metadata } : undefined
  };
}

export function appendMessage(transcript: Transcript, message: Message): Transcript {
  if (message.runId !== transcript.runId) {
    throw new TranscriptRunMismatchError(transcript.runId, message.runId);
  }

  if (transcript.status !== "running") {
    throw new TranscriptNotRunningError(transcript.status);
  }

  if (transcript.endedAt) {
    throw new TranscriptAlreadyFinalizedError(transcript.runId);
  }

  return {
    ...transcript,
    messages: [...transcript.messages, message]
  };
}

export function finalizeTranscript(
  transcript: Transcript,
  status: "completed" | "failed",
  synthesis?: SynthesisOutput
): Transcript {
  if (transcript.endedAt) {
    throw new TranscriptAlreadyFinalizedError(transcript.runId);
  }

  return {
    ...transcript,
    status,
    endedAt: new Date().toISOString(),
    synthesis: synthesis ?? transcript.synthesis
  };
}
