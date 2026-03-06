import { describe, expect, test } from "bun:test";

import type { Message } from "../../src/types";
import {
  appendMessage,
  finalizeTranscript,
  initializeTranscript,
  TranscriptAlreadyFinalizedError,
  TranscriptNotRunningError,
  TranscriptRunMismatchError
} from "../../src/transcript/transcript-store";

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    runId: "run-1",
    roundId: "round-1",
    phaseId: "opening",
    turnIndex: 1,
    timestamp: "2026-03-05T00:00:00.000Z",
    from: "advocate",
    to: "all",
    kind: "agent_turn",
    content: "Opening position.",
    ...overrides
  };
}

describe("transcript-store", () => {
  test("initializeTranscript sets running state with empty messages", () => {
    const transcript = initializeTranscript({
      runId: "run-1",
      adapterId: "general-debate",
      topic: "Should remote work be default?",
      metadata: { source: "test" }
    });

    expect(transcript.runId).toBe("run-1");
    expect(transcript.adapterId).toBe("general-debate");
    expect(transcript.topic).toBe("Should remote work be default?");
    expect(transcript.status).toBe("running");
    expect(transcript.messages).toEqual([]);
    expect(transcript.endedAt).toBeUndefined();
    expect(transcript.synthesis).toBeUndefined();
    expect(transcript.metadata).toEqual({ source: "test" });
    expect(new Date(transcript.startedAt).toString()).not.toBe("Invalid Date");
  });

  test("appendMessage returns new transcript with appended message", () => {
    const initial = initializeTranscript({
      runId: "run-1",
      adapterId: "general-debate",
      topic: "Test topic"
    });

    const message = buildMessage();
    const appended = appendMessage(initial, message);

    expect(initial.messages).toHaveLength(0);
    expect(appended.messages).toHaveLength(1);
    expect(appended.messages[0]).toEqual(message);
    expect(appended).not.toBe(initial);
  });

  test("finalizeTranscript marks transcript completed and sets endedAt", () => {
    const initial = initializeTranscript({
      runId: "run-1",
      adapterId: "general-debate",
      topic: "Test topic"
    });

    const synthesis = {
      agentId: "synthesiser",
      messageId: "msg-synth",
      summary: "Final summary"
    };

    const finalized = finalizeTranscript(initial, "completed", synthesis);

    expect(finalized.status).toBe("completed");
    expect(finalized.synthesis).toEqual(synthesis);
    expect(finalized.endedAt).toBeDefined();
    expect(new Date(finalized.endedAt as string).toString()).not.toBe("Invalid Date");
  });

  test("finalizeTranscript supports failed status", () => {
    const initial = initializeTranscript({
      runId: "run-1",
      adapterId: "general-debate",
      topic: "Test topic"
    });

    const failed = finalizeTranscript(initial, "failed");

    expect(failed.status).toBe("failed");
    expect(failed.endedAt).toBeDefined();
  });

  test("appendMessage rejects runId mismatch", () => {
    const transcript = initializeTranscript({
      runId: "run-1",
      adapterId: "general-debate",
      topic: "Test topic"
    });

    const mismatchedMessage = buildMessage({ runId: "run-2" });

    expect(() => appendMessage(transcript, mismatchedMessage)).toThrow(TranscriptRunMismatchError);
  });

  test("appendMessage rejects non-running transcripts", () => {
    const transcript = initializeTranscript({
      runId: "run-1",
      adapterId: "general-debate",
      topic: "Test topic"
    });

    const finalized = finalizeTranscript(transcript, "completed");

    expect(() => appendMessage(finalized, buildMessage())).toThrow(TranscriptNotRunningError);
  });

  test("finalizeTranscript rejects already finalized transcript", () => {
    const transcript = initializeTranscript({
      runId: "run-1",
      adapterId: "general-debate",
      topic: "Test topic"
    });

    const finalized = finalizeTranscript(transcript, "completed");

    expect(() => finalizeTranscript(finalized, "failed")).toThrow(TranscriptAlreadyFinalizedError);
  });
});
