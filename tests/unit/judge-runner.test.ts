import { describe, expect, test } from "bun:test";

import { runJudgeCheck } from "../../src/core/judge-runner";
import { createRunContext, setRunStatus } from "../../src/core/run-context";
import { MockProvider, buildMockResponseKey } from "../../src/providers/mock-provider";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import { initializeTranscript } from "../../src/transcript/transcript-store";
import type { DomainAdapter, Message, OrchestratorConfig, Transcript } from "../../src/types";

const adapter: DomainAdapter = {
  id: "judge-adapter",
  name: "Judge Adapter",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [
    {
      id: "speaker",
      name: "Speaker",
      role: "speaker",
      persona: "clear",
      systemPrompt: "Discuss topic.",
      llm: {
        provider: "mock",
        model: "mock-model-v1"
      }
    },
    {
      id: "judge",
      name: "Judge",
      role: "judge",
      persona: "decisive",
      systemPrompt: "Judge completion.",
      llm: {
        provider: "mock",
        model: "mock-model-v1"
      }
    },
    {
      id: "synth",
      name: "Synthesiser",
      role: "synth",
      persona: "balanced",
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
  judge: { agentId: "judge" },
  synthesis: { agentId: "synth", trigger: "after_all_rounds" },
  transcript: { persistToFile: false, outputDir: "./runs", format: "json" },
  cli: { showTimestamps: true, showUsage: true, colorize: true }
};

function createContext() {
  const transcript = initializeTranscript({
    runId: "run-judge-1",
    adapterId: adapter.id,
    topic: "Judge topic"
  });

  const seedMessage: Message = {
    id: "msg-1",
    runId: "run-judge-1",
    roundId: "round-1",
    phaseId: "opening",
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
      runId: "run-judge-1",
      adapter,
      config,
      transcript: withMessage
    }),
    "running"
  );
}

describe("core/judge-runner", () => {
  test("parses strict JSON judge response", async () => {
    const key = buildMockResponseKey({ agentId: "judge", phaseId: "judge" });
    const provider = new MockProvider({
      cannedResponses: {
        [key]: JSON.stringify({
          finished: true,
          correctAnswer: "42",
          rationale: "Evidence is sufficient"
        })
      }
    });

    const result = await runJudgeCheck({
      context: createContext(),
      round: adapter.rounds[0] as DomainAdapter["rounds"][number],
      providerRegistry: new ProviderRegistry([provider]),
      judge: { agentId: "judge" }
    });

    expect(result.decision.finished).toBe(true);
    expect(result.decision.correctAnswer).toBe("42");
    expect(result.decision.score).toBeUndefined();
    expect(result.record.roundId).toBe("round-1");
    expect(result.record.roundName).toBe("Round One");
    expect(result.record.providerInvocationId).toMatch(/^mock-inv-/);
  });

  test("parses score, rubric, and steering directives when present", async () => {
    const key = buildMockResponseKey({ agentId: "judge", phaseId: "judge" });
    const provider = new MockProvider({
      cannedResponses: {
        [key]: JSON.stringify({
          finished: false,
          rationale: "Need sharper rebuttals.",
          score: 78,
          rubric: {
            specificity: 80,
            rebuttalQuality: 76,
            evidenceQuality: 74,
            synthesisUtility: 82
          },
          steeringDirectives: [
            "Address strongest opposing claim first.",
            "Add concrete evidence with explicit references."
          ]
        })
      }
    });

    const result = await runJudgeCheck({
      context: createContext(),
      round: adapter.rounds[0] as DomainAdapter["rounds"][number],
      providerRegistry: new ProviderRegistry([provider]),
      judge: { agentId: "judge" }
    });

    expect(result.decision.score).toBe(78);
    expect(result.decision.rubric?.specificity).toBe(80);
    expect(result.decision.rubric?.rebuttalQuality).toBe(76);
    expect(result.decision.steeringDirectives).toEqual([
      "Address strongest opposing claim first.",
      "Add concrete evidence with explicit references."
    ]);
  });

  test("parses fenced JSON judge response", async () => {
    const key = buildMockResponseKey({ agentId: "judge", phaseId: "judge" });
    const provider = new MockProvider({
      cannedResponses: {
        [key]: [
          "Judge decision:",
          "```json",
          JSON.stringify({
            finished: false,
            rationale: "Needs more debate"
          }),
          "```"
        ].join("\n")
      }
    });

    const result = await runJudgeCheck({
      context: createContext(),
      round: adapter.rounds[0] as DomainAdapter["rounds"][number],
      providerRegistry: new ProviderRegistry([provider]),
      judge: { agentId: "judge" }
    });

    expect(result.decision.finished).toBe(false);
    expect(result.decision.rationale).toBe("Needs more debate");
  });

  test("falls back to parse failure decision", async () => {
    const key = buildMockResponseKey({ agentId: "judge", phaseId: "judge" });
    const provider = new MockProvider({
      cannedResponses: {
        [key]: "not json"
      }
    });

    const result = await runJudgeCheck({
      context: createContext(),
      round: adapter.rounds[0] as DomainAdapter["rounds"][number],
      providerRegistry: new ProviderRegistry([provider]),
      judge: { agentId: "judge" }
    });

    expect(result.decision).toEqual({
      finished: false,
      rationale: "parse failure"
    });
  });
});
