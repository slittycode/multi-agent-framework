import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadDomainAdapter } from "../../src/adapters/adapter-loader";
import { MockProvider } from "../../src/providers/mock-provider";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import { persistTranscript } from "../../src/transcript/file-persistor";
import { appendMessage, initializeTranscript } from "../../src/transcript/transcript-store";
import type { Agent, Message } from "../../src/types";

describe("transcript wiring integration", () => {
  test("adapter + provider + transcript + persistence works end-to-end", async () => {
    const adapter = await loadDomainAdapter("general-debate");
    const advocate = adapter.agents.find((agent) => agent.id === "advocate");

    expect(advocate).toBeDefined();

    const transcript = initializeTranscript({
      runId: "run-wire-1",
      adapterId: adapter.id,
      topic: "Should teams default to async collaboration?"
    });

    const provider = new MockProvider({
      id: "gemini",
      cannedResponses: {
        "advocate::*::opening::*::*": "Async-first improves focus and documentation quality."
      }
    });

    const registry = new ProviderRegistry([provider]);

    const result = await registry.generateForAgent(advocate as Agent, {
      runId: transcript.runId,
      prompt: "Opening argument",
      transcript: transcript.messages,
      roundId: "main-round",
      phaseId: "opening",
      messageKind: "agent_turn",
      turnIndex: 1
    });

    const message: Message = {
      id: "msg-wire-1",
      runId: transcript.runId,
      roundId: "main-round",
      phaseId: "opening",
      turnIndex: 1,
      timestamp: "2026-03-05T00:00:00.000Z",
      from: "advocate",
      to: "all",
      kind: "agent_turn",
      content: result.content,
      provider: result.provider,
      model: result.model,
      usage: result.usage
    };

    const updatedTranscript = appendMessage(transcript, message);

    const tempRoot = await mkdtemp(join(tmpdir(), "maf-step5-wiring-"));
    try {
      const jsonPersistResult = await persistTranscript({
        transcript: updatedTranscript,
        outputDir: tempRoot,
        format: "json"
      });

      await persistTranscript({
        transcript: updatedTranscript,
        outputDir: tempRoot,
        format: "jsonl"
      });

      const fileContents = await readFile(jsonPersistResult.path, "utf8");
      const parsed = JSON.parse(fileContents) as { runId: string; messages: Message[] };

      expect(parsed.runId).toBe("run-wire-1");
      expect(parsed.messages.length).toBeGreaterThanOrEqual(1);
      expect(parsed.messages[0]?.content).toContain("Async-first");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
