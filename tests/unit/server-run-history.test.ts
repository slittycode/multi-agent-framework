import { describe, expect, test } from "bun:test";

import type { Transcript } from "../../src/types";
import {
  buildRunListEntry,
  filterRunListEntries,
  mergeRunListEntries,
  parsePersistedTranscriptPayload
} from "../../src/server/run-history";
import {
  serializeTranscriptToJson,
  serializeTranscriptToJsonl
} from "../../src/transcript/transcript-serializer";

const transcript: Transcript = {
  runId: "run-history-1",
  adapterId: "general-debate",
  topic: "How should teams make decisions?",
  startedAt: "2026-03-07T10:00:00.000Z",
  endedAt: "2026-03-07T10:05:00.000Z",
  status: "completed",
  messages: [
    {
      id: "msg-1",
      runId: "run-history-1",
      roundId: "round-1",
      phaseId: "opening",
      turnIndex: 1,
      timestamp: "2026-03-07T10:00:10.000Z",
      from: "advocate",
      to: "all",
      kind: "agent_turn",
      content: "Document the trade-offs before escalating the decision.",
      usage: {
        inputTokens: 20,
        outputTokens: 40,
        latencyMs: 1200
      }
    },
    {
      id: "msg-2",
      runId: "run-history-1",
      roundId: "round-1",
      phaseId: "synthesis",
      turnIndex: 2,
      timestamp: "2026-03-07T10:04:00.000Z",
      from: "synthesiser",
      to: "all",
      kind: "synthesis",
      content: "Keep a clear owner and publish the decision log."
    }
  ],
  synthesis: {
    agentId: "synthesiser",
    messageId: "msg-2",
    summary: "The group converged on explicit ownership and decision logging.",
    verdict: "Proceed with a documented pilot.",
    recommendations: [{ text: "Publish a short decision log", priority: "high" }]
  },
  metadata: {
    qualityGate: {
      score: 64.5
    }
  }
};

describe("server/run-history", () => {
  test("parses persisted JSON transcript payloads into transcript objects", () => {
    const parsed = parsePersistedTranscriptPayload(
      "run-history-1.transcript.json",
      serializeTranscriptToJson(transcript)
    );

    expect(parsed.runId).toBe("run-history-1");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.synthesis?.summary).toContain("explicit ownership");
  });

  test("parses persisted JSONL transcript payloads into transcript objects", () => {
    const parsed = parsePersistedTranscriptPayload(
      "run-history-1.transcript.jsonl",
      serializeTranscriptToJsonl(transcript)
    );

    expect(parsed.runId).toBe("run-history-1");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.status).toBe("completed");
    expect(parsed.synthesis?.verdict).toBe("Proceed with a documented pilot.");
  });

  test("merges active and persisted list entries, preferring active rows and sorting active first", () => {
    const persistedEntries = [
      buildRunListEntry({
        ...transcript,
        runId: "persisted-newer",
        startedAt: "2026-03-07T09:00:00.000Z"
      }),
      buildRunListEntry({
        ...transcript,
        runId: "duplicate-run",
        startedAt: "2026-03-07T08:00:00.000Z"
      }),
      buildRunListEntry({
        ...transcript,
        runId: "persisted-older",
        startedAt: "2026-03-07T07:00:00.000Z"
      })
    ];

    const merged = mergeRunListEntries({
      persistedEntries,
      activeEntries: [
        {
          runId: "active-run",
          adapterId: "general-debate",
          topic: "Active topic",
          status: "running",
          startedAt: "2026-03-07T11:00:00.000Z",
          messageCount: 1
        },
        {
          runId: "duplicate-run",
          adapterId: "creative-writing",
          topic: "Duplicate active topic",
          status: "running",
          startedAt: "2026-03-07T10:30:00.000Z",
          messageCount: 2
        }
      ]
    });

    expect(merged.map((entry) => entry.runId)).toEqual([
      "active-run",
      "duplicate-run",
      "persisted-newer",
      "persisted-older"
    ]);
    expect(merged[1]).toMatchObject({
      runId: "duplicate-run",
      status: "running",
      adapterId: "creative-writing"
    });
  });

  test("filters run list entries for real completed runs", () => {
    const entries = [
      {
        runId: "real-completed",
        adapterId: "general-debate",
        topic: "Should teams default to async planning?",
        status: "completed",
        startedAt: "2026-03-07T11:00:00.000Z",
        endedAt: "2026-03-07T11:05:00.000Z",
        messageCount: 4,
        actionabilityScore: 68
      },
      {
        runId: "placeholder-topic",
        adapterId: "general-debate",
        topic: "CLI topic",
        status: "completed",
        startedAt: "2026-03-07T10:00:00.000Z",
        endedAt: "2026-03-07T10:05:00.000Z",
        messageCount: 3
      },
      {
        runId: "fixture-adapter",
        adapterId: "fixture-demo",
        topic: "A real-looking topic",
        status: "completed",
        startedAt: "2026-03-07T09:00:00.000Z",
        endedAt: "2026-03-07T09:05:00.000Z",
        messageCount: 3
      },
      {
        runId: "empty-run",
        adapterId: "general-debate",
        topic: "Placeholder topic",
        status: "completed",
        startedAt: "2026-03-07T08:00:00.000Z",
        endedAt: "2026-03-07T08:05:00.000Z",
        messageCount: 0
      },
      {
        runId: "real-running",
        adapterId: "general-debate",
        topic: "Should product reviews be async?",
        status: "running",
        startedAt: "2026-03-07T12:00:00.000Z",
        messageCount: 2
      }
    ] as const;

    const filtered = filterRunListEntries(entries, {
      filter: "real",
      status: "completed"
    });

    expect(filtered).toEqual([
      {
        runId: "real-completed",
        adapterId: "general-debate",
        topic: "Should teams default to async planning?",
        status: "completed",
        startedAt: "2026-03-07T11:00:00.000Z",
        endedAt: "2026-03-07T11:05:00.000Z",
        messageCount: 4,
        actionabilityScore: 68
      }
    ]);
  });
});
