import { describe, expect, test } from "bun:test";

import type { Transcript } from "../../src/types";
import {
  serializeTranscriptToJson,
  serializeTranscriptToJsonl
} from "../../src/transcript/transcript-serializer";

const transcript: Transcript = {
  runId: "run-serialize-1",
  adapterId: "general-debate",
  topic: "Serialization topic",
  startedAt: "2026-03-05T00:00:00.000Z",
  endedAt: "2026-03-05T00:02:00.000Z",
  status: "completed",
  messages: [
    {
      id: "msg-1",
      runId: "run-serialize-1",
      roundId: "round-1",
      phaseId: "opening",
      turnIndex: 1,
      timestamp: "2026-03-05T00:00:10.000Z",
      from: "advocate",
      to: "all",
      kind: "agent_turn",
      content: "Opening claim."
    },
    {
      id: "msg-2",
      runId: "run-serialize-1",
      roundId: "round-1",
      phaseId: "challenge",
      turnIndex: 2,
      timestamp: "2026-03-05T00:00:40.000Z",
      from: "critic",
      to: "all",
      kind: "challenge",
      content: "Challenge point."
    }
  ],
  synthesis: {
    agentId: "synthesiser",
    messageId: "msg-3",
    summary: "Synthesis summary",
    recommendations: [{ text: "Action item", priority: "high" }]
  },
  metadata: {
    source: "unit-test"
  }
};

describe("transcript-serializer", () => {
  test("serializeTranscriptToJson returns parseable pretty JSON", () => {
    const json = serializeTranscriptToJson(transcript);
    const parsed = JSON.parse(json) as Transcript;

    expect(json).toContain("\n");
    expect(parsed.runId).toBe("run-serialize-1");
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.synthesis?.summary).toBe("Synthesis summary");
  });

  test("serializeTranscriptToJsonl outputs one message line plus one summary line", () => {
    const jsonl = serializeTranscriptToJsonl(transcript);
    const lines = jsonl.trimEnd().split("\n");

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(lines).toHaveLength(3);

    const firstLineRaw = lines[0];
    const secondLineRaw = lines[1];
    const summaryLineRaw = lines[2];

    expect(firstLineRaw).toBeDefined();
    expect(secondLineRaw).toBeDefined();
    expect(summaryLineRaw).toBeDefined();

    const firstLine = JSON.parse(firstLineRaw as string) as Record<string, unknown>;
    const secondLine = JSON.parse(secondLineRaw as string) as Record<string, unknown>;
    const summaryLine = JSON.parse(summaryLineRaw as string) as Record<string, unknown>;

    expect(firstLine.recordType).toBe("message");
    expect(secondLine.recordType).toBe("message");
    expect(summaryLine.recordType).toBe("transcript_summary");
    expect(summaryLine.runId).toBe("run-serialize-1");
    expect(summaryLine.messageCount).toBe(2);
    expect(summaryLine.status).toBe("completed");
  });
});
