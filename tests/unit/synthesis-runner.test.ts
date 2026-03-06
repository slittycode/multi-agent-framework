import { describe, expect, test } from "bun:test";

import { runSynthesis } from "../../src/core/synthesis-runner";
import { createRunContext, setRunStatus } from "../../src/core/run-context";
import { MockProvider, buildMockResponseKey } from "../../src/providers/mock-provider";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import { initializeTranscript } from "../../src/transcript/transcript-store";
import type { DomainAdapter, Message, OrchestratorConfig, Transcript } from "../../src/types";

const adapter: DomainAdapter = {
  id: "synth-adapter",
  name: "Synthesis Adapter",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [
    {
      id: "speaker",
      name: "Speaker",
      role: "speaker",
      persona: "Clear",
      systemPrompt: "Discuss topic.",
      llm: {
        provider: "mock",
        model: "mock-model-v1"
      }
    },
    {
      id: "synth",
      name: "Synthesiser",
      role: "synth",
      persona: "Balanced",
      systemPrompt: "Synthesize.",
      llm: {
        provider: "mock",
        model: "mock-model-v1"
      }
    }
  ],
  rounds: [
    {
      id: "round-1",
      name: "Round One",
      phases: [
        {
          id: "opening",
          name: "Opening",
          instructions: "Open",
          turnOrder: ["speaker"]
        }
      ]
    }
  ]
};

const config: OrchestratorConfig = {
  executionMode: "sequential",
  failFast: false,
  retry: { attempts: 1, backoffMs: 0 },
  synthesis: { agentId: "synth", trigger: "after_all_rounds" },
  transcript: { persistToFile: false, outputDir: "./runs", format: "json" },
  cli: { showTimestamps: true, showUsage: true, colorize: true }
};

function createContext() {
  const transcript = initializeTranscript({
    runId: "run-synth-1",
    adapterId: adapter.id,
    topic: "Synthesis topic"
  });

  const seedMessage: Message = {
    id: "msg-1",
    runId: "run-synth-1",
    turnIndex: 1,
    timestamp: "2026-03-05T00:00:00.000Z",
    from: "speaker",
    kind: "agent_turn",
    content: "Opening argument."
  };

  const withMessage: Transcript = {
    ...transcript,
    messages: [seedMessage]
  };

  return setRunStatus(
    createRunContext({
      runId: "run-synth-1",
      adapter,
      config,
      transcript: withMessage
    }),
    "running"
  );
}

describe("core/synthesis-runner", () => {
  test("parses strict JSON synthesis response", async () => {
    const key = buildMockResponseKey({ agentId: "synth", phaseId: "synthesis" });
    const provider = new MockProvider({
      cannedResponses: {
        [key]: JSON.stringify({
          summary: "Concise synthesis",
          verdict: "Proceed",
          recommendations: [{ text: "Do the highest impact task", priority: "high" }]
        })
      }
    });

    const result = await runSynthesis({
      context: createContext(),
      providerRegistry: new ProviderRegistry([provider])
    });

    expect(result.output?.summary).toBe("Concise synthesis");
    expect(result.output?.verdict).toBe("Proceed");
    expect(result.output?.recommendations?.[0]?.priority).toBe("high");
    expect(result.message?.kind).toBe("synthesis");
    expect(result.message?.providerInvocationId).toMatch(/^mock-inv-/);
  });

  test("parses fenced JSON synthesis response", async () => {
    const key = buildMockResponseKey({ agentId: "synth", phaseId: "synthesis" });
    const provider = new MockProvider({
      cannedResponses: {
        [key]: [
          "Here is the synthesis:",
          "```json",
          JSON.stringify({ summary: "Fenced summary", recommendations: [{ text: "Keep iterating" }] }),
          "```"
        ].join("\n")
      }
    });

    const result = await runSynthesis({
      context: createContext(),
      providerRegistry: new ProviderRegistry([provider])
    });

    expect(result.output?.summary).toBe("Fenced summary");
    expect(result.output?.recommendations?.[0]?.text).toBe("Keep iterating");
  });

  test("falls back to capped raw summary with truncation marker", async () => {
    const key = buildMockResponseKey({ agentId: "synth", phaseId: "synthesis" });
    const raw = "x".repeat(600);

    const provider = new MockProvider({
      cannedResponses: {
        [key]: raw
      }
    });

    const result = await runSynthesis({
      context: createContext(),
      providerRegistry: new ProviderRegistry([provider])
    });

    expect(result.output?.summary.endsWith("... [truncated]")).toBe(true);
    expect(result.output?.summary.length).toBe(515);
    expect(result.output?.raw?.length).toBe(600);
  });

  test("drops invalid recommendation priorities while keeping valid entries", async () => {
    const key = buildMockResponseKey({ agentId: "synth", phaseId: "synthesis" });

    const provider = new MockProvider({
      cannedResponses: {
        [key]: JSON.stringify({
          summary: "Synthesis",
          recommendations: [
            { text: "First", priority: "urgent" },
            { text: "Second", priority: "medium" }
          ]
        })
      }
    });

    const result = await runSynthesis({
      context: createContext(),
      providerRegistry: new ProviderRegistry([provider])
    });

    expect(result.output?.recommendations?.[0]?.text).toBe("First");
    expect(result.output?.recommendations?.[0]?.priority).toBeUndefined();
    expect(result.output?.recommendations?.[1]?.priority).toBe("medium");
  });
});
