import { describe, expect, test } from "bun:test";

import { runRound } from "../../src/core/round-runner";
import { createRunContext, setRunStatus } from "../../src/core/run-context";
import { MockProvider, buildMockResponseKey } from "../../src/providers/mock-provider";
import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "../../src/providers/provider-client";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { RetrieverClient } from "../../src/retrieval/retriever-client";
import { initializeTranscript } from "../../src/transcript/transcript-store";
import type { DomainAdapter, OrchestratorConfig } from "../../src/types";
import type { Round } from "../../src/types/round";

const baseAdapter: DomainAdapter = {
  id: "adapter-1",
  name: "Adapter One",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [
    {
      id: "a",
      name: "Agent A",
      role: "advocate",
      persona: "clear",
      systemPrompt: "argue",
      llm: {
        provider: "mock",
        model: "mock-model-v1"
      }
    },
    {
      id: "b",
      name: "Agent B",
      role: "critic",
      persona: "skeptical",
      systemPrompt: "challenge",
      llm: {
        provider: "mock",
        model: "mock-model-v1"
      }
    },
    {
      id: "synth",
      name: "Synth",
      role: "synth",
      persona: "balanced",
      systemPrompt: "summarise",
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
          turnOrder: ["a", "b"]
        },
        {
          id: "challenge",
          name: "Challenge",
          instructions: "Challenge",
          turnOrder: ["b", "a"]
        }
      ]
    }
  ]
};

const baseConfig: OrchestratorConfig = {
  executionMode: "sequential",
  failFast: false,
  retry: { attempts: 1, backoffMs: 0 },
  synthesis: { agentId: "synth", trigger: "after_all_rounds" },
  transcript: { persistToFile: false, outputDir: "./runs", format: "json" },
  cli: { showTimestamps: true, showUsage: true, colorize: true }
};

function createContext(adapter: DomainAdapter, config: OrchestratorConfig, runId: string) {
  const transcript = initializeTranscript({
    runId,
    adapterId: adapter.id,
    topic: "Test topic"
  });

  return setRunStatus(
    createRunContext({
      runId,
      adapter,
      config,
      transcript
    }),
    "running"
  );
}

class ErrorOnAgentProvider implements ProviderClient {
  readonly id = "mock";

  constructor(private readonly failingAgentId: string) {}

  async generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    if (request.agent.id === this.failingAgentId) {
      throw new Error(`agent ${request.agent.id} failed`);
    }

    return {
      content: `${request.agent.id} ok`,
      provider: "mock",
      model: "mock-model-v1",
      invocationId: `inv-${request.agent.id}`
    };
  }
}

class SteeringAwareProvider implements ProviderClient {
  readonly id = "mock";
  readonly requests: ProviderGenerateRequest[] = [];
  private judgeCalls = 0;

  async generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    this.requests.push(request);

    if (request.phaseId === "judge") {
      this.judgeCalls += 1;
      if (this.judgeCalls === 1) {
        return {
          content: JSON.stringify({
            finished: false,
            score: 82,
            steeringDirectives: ["Challenge feasibility assumptions with concrete trade-offs."]
          }),
          provider: "mock",
          model: "mock-model-v1"
        };
      }

      return {
        content: JSON.stringify({
          finished: false,
          score: 84
        }),
        provider: "mock",
        model: "mock-model-v1"
      };
    }

    return {
      content: `${request.agent.id} ${request.phaseId}`,
      provider: "mock",
      model: "mock-model-v1"
    };
  }
}

class StaticRetriever implements RetrieverClient {
  async retrieve(_input: Parameters<RetrieverClient["retrieve"]>[0]) {
    return {
      sources: [
        {
          title: "Remote work study",
          url: "https://example.com/study",
          snippet: "Outcome data over 12 months."
        }
      ]
    };
  }
}

describe("core/round-runner", () => {
  test("runs phases/turns in deterministic order and appends messages", async () => {
    const provider = new MockProvider({
      cannedResponses: {
        [buildMockResponseKey({ agentId: "a", phaseId: "opening" })]: "A opening",
        [buildMockResponseKey({ agentId: "b", phaseId: "opening" })]: "B opening",
        [buildMockResponseKey({ agentId: "b", phaseId: "challenge" })]: "B challenge",
        [buildMockResponseKey({ agentId: "a", phaseId: "challenge" })]: "A challenge"
      }
    });

    const context = createContext(baseAdapter, baseConfig, "run-round-1");
    const round = baseAdapter.rounds[0];
    expect(round).toBeDefined();

    const output = await runRound(context, round as Round, {
      adapter: baseAdapter,
      topic: "Test topic",
      providerRegistry: new ProviderRegistry([provider])
    });

    expect(output.transcript.messages.map((message) => message.content)).toEqual([
      "A opening",
      "B opening",
      "B challenge",
      "A challenge"
    ]);
    expect(output.transcript.messages[1]?.respondingToMessageId).toBe(
      output.transcript.messages[0]?.id
    );
    expect(output.transcript.messages.every((message) => message.providerInvocationId?.startsWith("mock-inv-"))).toBe(true);
    const judgePhases = (output.transcript.metadata as { judgePhases?: unknown[] } | undefined)
      ?.judgePhases;
    expect(judgePhases).toBeUndefined();
    expect(output.currentPhaseIndex).toBe(1);
  });

  test("runs fanout phase concurrently and merges results by turnOrder", async () => {
    const fanoutAdapter: DomainAdapter = {
      ...baseAdapter,
      rounds: [
        {
          id: "round-fanout",
          name: "Fanout Round",
          phases: [
            {
              id: "fanout",
              name: "Fanout",
              instructions: "Fan out",
              turnOrder: ["b", "a"],
              executionMode: "fanout"
            }
          ]
        }
      ]
    };

    const provider = new MockProvider({
      cannedResponses: {
        [buildMockResponseKey({ agentId: "a", phaseId: "fanout" })]: "A fanout",
        [buildMockResponseKey({ agentId: "b", phaseId: "fanout" })]: "B fanout"
      }
    });

    const context = createContext(fanoutAdapter, baseConfig, "run-round-fanout");
    const round = fanoutAdapter.rounds[0];

    const output = await runRound(context, round as Round, {
      adapter: fanoutAdapter,
      topic: "Test topic",
      providerRegistry: new ProviderRegistry([provider])
    });

    expect(output.transcript.messages).toHaveLength(2);
    expect(output.transcript.messages.map((message) => message.from)).toEqual(["b", "a"]);
    expect(output.transcript.messages.map((message) => message.turnIndex)).toEqual([1, 2]);
    expect(output.transcript.messages.map((message) => message.content)).toEqual([
      "B fanout",
      "A fanout"
    ]);
  });

  test("fanout with failFast=false appends success and deterministic error messages", async () => {
    const fanoutAdapter: DomainAdapter = {
      ...baseAdapter,
      rounds: [
        {
          id: "round-fanout-fail",
          name: "Fanout Fail Round",
          phases: [
            {
              id: "fanout",
              name: "Fanout",
              instructions: "Fan out",
              turnOrder: ["a", "b"],
              executionMode: "fanout"
            }
          ]
        }
      ]
    };

    const context = createContext(
      fanoutAdapter,
      {
        ...baseConfig,
        failFast: false
      },
      "run-round-fanout-fail"
    );

    const output = await runRound(context, fanoutAdapter.rounds[0] as Round, {
      adapter: fanoutAdapter,
      topic: "Test topic",
      providerRegistry: new ProviderRegistry([new ErrorOnAgentProvider("b")])
    });

    expect(output.transcript.messages).toHaveLength(2);
    expect(output.transcript.messages[0]?.from).toBe("a");
    expect(output.transcript.messages[0]?.turnIndex).toBe(1);
    expect(output.transcript.messages[1]?.from).toBe("orchestrator");
    expect(output.transcript.messages[1]?.to).toBe("b");
    expect(output.transcript.messages[1]?.turnIndex).toBe(2);
    expect(output.transcript.messages[1]?.kind).toBe("error");
    expect(output.transcript.messages[1]?.content).toContain("agent b failed");
  });

  test("fanout with failFast=true rejects without appending fanout outputs", async () => {
    const fanoutAdapter: DomainAdapter = {
      ...baseAdapter,
      rounds: [
        {
          id: "round-fanout-fail-fast",
          name: "Fanout FailFast Round",
          phases: [
            {
              id: "fanout",
              name: "Fanout",
              instructions: "Fan out",
              turnOrder: ["a", "b"],
              executionMode: "fanout"
            }
          ]
        }
      ]
    };

    const context = createContext(
      fanoutAdapter,
      {
        ...baseConfig,
        failFast: true
      },
      "run-round-fanout-fail-fast"
    );

    await expect(
      runRound(context, fanoutAdapter.rounds[0] as Round, {
        adapter: fanoutAdapter,
        topic: "Test topic",
        providerRegistry: new ProviderRegistry([new ErrorOnAgentProvider("b")])
      })
    ).rejects.toThrow("agent b failed");

    expect(context.transcript.messages).toHaveLength(0);
  });

  test("runs phase judge after each phase and injects steering directives into next phase prompts", async () => {
    const provider = new SteeringAwareProvider();
    const context = createContext(
      baseAdapter,
      {
        ...baseConfig,
        phaseJudge: {
          enabled: true,
          cadence: "after_each_phase",
          agentId: "synth"
        }
      },
      "run-round-phase-judge"
    );

    const output = await runRound(context, baseAdapter.rounds[0] as Round, {
      adapter: baseAdapter,
      topic: "Test topic",
      providerRegistry: new ProviderRegistry([provider])
    });

    const challengeTurnRequest = provider.requests.find(
      (request) => request.phaseId === "challenge" && request.agent.id === "b"
    );
    expect(challengeTurnRequest?.prompt).toContain("Steering Directives:");
    expect(challengeTurnRequest?.prompt).toContain(
      "Challenge feasibility assumptions with concrete trade-offs."
    );

    const judgeRequests = provider.requests.filter((request) => request.phaseId === "judge");
    expect(judgeRequests).toHaveLength(2);

    const judgePhases = (output.transcript.metadata as { judgePhases?: unknown[] } | undefined)
      ?.judgePhases;
    expect(judgePhases).toBeDefined();
    expect(judgePhases).toHaveLength(2);
  });

  test("captures transcript and web citations in message metadata when present", async () => {
    const provider = new MockProvider({
      cannedResponses: {
        [buildMockResponseKey({ agentId: "a", phaseId: "opening" })]:
          "Claim with evidence [T1] and source [W1].",
        [buildMockResponseKey({ agentId: "b", phaseId: "opening" })]: "Response [T1]."
      }
    });

    const citationConfig: OrchestratorConfig = {
      ...baseConfig,
      citations: {
        mode: "optional_web",
        failPolicy: "graceful_fallback",
        maxWebSourcesPerTurn: 2
      }
    };
    const context = createContext(baseAdapter, citationConfig, "run-round-citations");

    const output = await runRound(context, baseAdapter.rounds[0] as Round, {
      adapter: baseAdapter,
      topic: "Test topic",
      providerRegistry: new ProviderRegistry([provider]),
      retriever: new StaticRetriever()
    });

    const firstMessageMetadata = output.transcript.messages[0]?.metadata as
      | {
          citations?: {
            transcriptRefs?: Array<{ turnIndex: number }>;
            webRefs?: Array<{ url: string }>;
          };
        }
      | undefined;

    expect(firstMessageMetadata?.citations?.transcriptRefs?.[0]?.turnIndex).toBe(1);
    expect(firstMessageMetadata?.citations?.webRefs?.[0]?.url).toBe("https://example.com/study");
  });

  test("adds retrieval warning metadata when optional web citations are enabled without retriever", async () => {
    const provider = new MockProvider({
      cannedResponses: {
        [buildMockResponseKey({ agentId: "a", phaseId: "opening" })]: "Opening [T1].",
        [buildMockResponseKey({ agentId: "b", phaseId: "opening" })]: "Reply [T1]."
      }
    });

    const citationConfig: OrchestratorConfig = {
      ...baseConfig,
      citations: {
        mode: "optional_web",
        failPolicy: "graceful_fallback"
      }
    };
    const context = createContext(baseAdapter, citationConfig, "run-round-retrieval-warning");

    const output = await runRound(context, baseAdapter.rounds[0] as Round, {
      adapter: baseAdapter,
      topic: "Test topic",
      providerRegistry: new ProviderRegistry([provider])
    });

    const firstMessageMetadata = output.transcript.messages[0]?.metadata as
      | { retrievalWarning?: string }
      | undefined;
    expect(firstMessageMetadata?.retrievalWarning).toContain("no retriever is configured");
  });
});
