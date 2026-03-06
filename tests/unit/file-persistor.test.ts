import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import type { Transcript } from "../../src/types";
import { persistTranscript } from "../../src/transcript/file-persistor";

const transcript: Transcript = {
  runId: "run-persist-1",
  adapterId: "general-debate",
  topic: "Persistence topic",
  startedAt: "2026-03-05T00:00:00.000Z",
  status: "running",
  messages: [
    {
      id: "msg-1",
      runId: "run-persist-1",
      roundId: "round-1",
      phaseId: "opening",
      turnIndex: 1,
      timestamp: "2026-03-05T00:00:10.000Z",
      from: "advocate",
      to: "all",
      kind: "agent_turn",
      content: "Opening claim."
    }
  ]
};

describe("file-persistor", () => {
  test("creates output directory and writes deterministic JSON path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "maf-step5-json-"));
    try {
      const outputDir = join(tempRoot, "nested", "runs");
      const result = await persistTranscript({
        transcript,
        outputDir,
        format: "json"
      });

      expect(result.path).toBe(resolve(outputDir, "run-persist-1.transcript.json"));

      const fileContents = await readFile(result.path, "utf8");
      const parsed = JSON.parse(fileContents) as Transcript;
      expect(parsed.runId).toBe("run-persist-1");
      expect(parsed.messages).toHaveLength(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("writes JSONL and returns deterministic JSONL path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "maf-step5-jsonl-"));
    try {
      const outputDir = join(tempRoot, "runs");
      const result = await persistTranscript({
        transcript,
        outputDir,
        format: "jsonl"
      });

      expect(result.path).toBe(resolve(outputDir, "run-persist-1.transcript.jsonl"));

      const fileContents = await readFile(result.path, "utf8");
      const lines = fileContents.trimEnd().split("\n");
      expect(lines.length).toBe(2);

      const summaryLine = lines[1];
      expect(summaryLine).toBeDefined();

      const summary = JSON.parse(summaryLine as string) as Record<string, unknown>;
      expect(summary.recordType).toBe("transcript_summary");
      expect(summary.runId).toBe("run-persist-1");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
