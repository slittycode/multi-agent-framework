import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadDomainAdapter } from "../../src/adapters/adapter-loader";
import { runDiscussion } from "../../src/core/orchestrator";
import { OrchestratorConfigError, OrchestratorIntegrationError } from "../../src/core/errors";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import { MockProvider, buildMockResponseKey } from "../../src/providers/mock-provider";
import type { DomainAdapter } from "../../src/types";

describe("integration/orchestrator-run", () => {
  test("runs built-in adapter and persists transcript", async () => {
    const adapter = await loadDomainAdapter("general-debate");
    const outputDir = await mkdtemp(join(tmpdir(), "maf-step6-orchestrator-"));

    try {
      const result = await runDiscussion({
        adapter,
        topic: "Should async communication be default?",
        runId: "run-step6-1",
        providerRegistry: new ProviderRegistry([new MockProvider({ id: "gemini" })]),
        config: {
          transcript: {
            persistToFile: true,
            outputDir,
            format: "json"
          }
        }
      });

      expect(result.context.status).toBe("done");
      expect(result.context.transcript.status).toBe("completed");
      expect(result.context.transcript.messages.length).toBeGreaterThan(0);
      expect(result.context.transcript.messages.at(-1)?.kind).toBe("synthesis");
      expect(result.context.transcript.synthesis).toBeDefined();
      const firstMessageMetadata = result.context.transcript.messages[0]?.metadata as
        | { retrievalWarning?: string }
        | undefined;
      expect(firstMessageMetadata?.retrievalWarning).toContain("transcript-only citations");
      const judgeRounds = (result.context.transcript.metadata as { judgeRounds?: unknown[] } | undefined)
        ?.judgeRounds;
      expect(judgeRounds).toBeUndefined();
      const judgePhases = (result.context.transcript.metadata as { judgePhases?: unknown[] } | undefined)
        ?.judgePhases;
      expect(judgePhases).toBeDefined();
      expect(judgePhases).toHaveLength(3);
      const qualityGate = (
        result.context.transcript.metadata as
          | {
              qualityGate?: {
                threshold?: number;
                score?: number;
                passed?: boolean;
              };
            }
          | undefined
      )?.qualityGate;
      expect(qualityGate).toBeDefined();
      expect(qualityGate?.threshold).toBe(75);
      expect(typeof qualityGate?.score).toBe("number");
      expect(typeof qualityGate?.passed).toBe("boolean");
      expect(qualityGate).toMatchObject({
        evaluationTier: "baseline",
        rubricVersion: expect.any(String),
        subscores: {
          structuralCompleteness: expect.any(Number),
          recommendationSpecificity: expect.any(Number),
          grounding: expect.any(Number),
          nonRedundancy: expect.any(Number),
          prioritizedNextStepUsefulness: expect.any(Number)
        },
        penalties: expect.any(Array),
        failureReasons: expect.any(Array)
      });
      expect(result.persistedPath).toBeDefined();

      const contents = await readFile(result.persistedPath as string, "utf8");
      const parsed = JSON.parse(contents) as {
        runId: string;
        messages: unknown[];
        metadata?: { judgeRounds?: unknown[]; judgePhases?: unknown[]; qualityGate?: unknown };
      };
      expect(parsed.runId).toBe("run-step6-1");
      expect(parsed.messages.length).toBeGreaterThan(0);
      expect(parsed.metadata?.judgeRounds).toBeUndefined();
      expect(parsed.metadata?.judgePhases).toBeDefined();
      expect(parsed.metadata?.qualityGate).toBeDefined();
      expect(parsed.metadata?.qualityGate).toMatchObject({
        evaluationTier: "baseline",
        rubricVersion: expect.any(String)
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("stops after round when judge marks finished and stores lazy-initialized judgeRounds", async () => {
    const adapter = await loadDomainAdapter("general-debate");
    const secondRound = {
      ...adapter.rounds[0],
      id: "main-round-2",
      name: "Main Debate Round 2",
      phases: adapter.rounds[0]?.phases.map((phase) => ({
        ...phase,
        id: `${phase.id}-2`,
        name: `${phase.name} 2`
      })) ?? []
    };
    const twoRoundAdapter: DomainAdapter = {
      ...adapter,
      rounds: [...adapter.rounds, secondRound]
    };

    const judgeKey = buildMockResponseKey({
      agentId: adapter.synthesisAgentId,
      phaseId: "judge"
    });
    const provider = new MockProvider({
      id: "gemini",
      cannedResponses: {
        [judgeKey]: JSON.stringify({
          finished: true,
          correctAnswer: "stop early",
          rationale: "round is conclusive"
        })
      }
    });

    const result = await runDiscussion({
      adapter: twoRoundAdapter,
      topic: "Should async communication be default?",
      runId: "run-step8-judge-stop",
      providerRegistry: new ProviderRegistry([provider]),
      config: {
        judge: {
          agentId: adapter.synthesisAgentId
        },
        transcript: {
          persistToFile: false,
          outputDir: "./runs",
          format: "json"
        }
      }
    });

    const judgeRounds = (result.context.transcript.metadata as { judgeRounds?: unknown[] } | undefined)
      ?.judgeRounds;
    expect(judgeRounds).toBeDefined();
    expect(judgeRounds).toHaveLength(1);
    const firstJudgeRecord = judgeRounds?.[0] as {
      decision?: { finished?: boolean; correctAnswer?: string };
    };
    expect(firstJudgeRecord.decision?.finished).toBe(true);
    expect(firstJudgeRecord.decision?.correctAnswer).toBe("stop early");

    const nonSynthesisMessages = result.context.transcript.messages.filter(
      (message) => message.phaseId !== "synthesis"
    );
    expect(
      nonSynthesisMessages.every((message) => !message.phaseId?.endsWith("-2"))
    ).toBe(true);
    expect(result.context.transcript.messages.some((message) => message.phaseId === "judge")).toBe(false);
    expect(result.context.transcript.messages.at(-1)?.kind).toBe("synthesis");
  });

  test("rejects parallel execution mode in MVP", async () => {
    const adapter = await loadDomainAdapter("general-debate");

    await expect(
      runDiscussion({
        adapter,
        topic: "Test topic",
        providerRegistry: new ProviderRegistry([new MockProvider()]),
        config: {
          executionMode: "parallel"
        }
      })
    ).rejects.toBeInstanceOf(OrchestratorConfigError);
  });

  test("maps provider resolution failures to orchestrator integration errors", async () => {
    const adapter = await loadDomainAdapter("general-debate");
    const brokenAdapter: DomainAdapter = {
      ...adapter,
      agents: adapter.agents.map((agent) => ({
        ...agent,
        llm: undefined
      }))
    };

    await expect(
      runDiscussion({
        adapter: brokenAdapter,
        topic: "Test topic",
        providerRegistry: new ProviderRegistry([new MockProvider()])
      })
    ).rejects.toMatchObject({
      source: "provider",
      code: "PROVIDER_MISSING_AGENT_PROVIDER"
    } satisfies Partial<OrchestratorIntegrationError>);
  });

  test("gracefully completes when synthesis fails and failFast=false", async () => {
    const adapter = await loadDomainAdapter("general-debate");
    const synthesisFailureAdapter: DomainAdapter = {
      ...adapter,
      agents: adapter.agents.map((agent) => {
        if (agent.id === adapter.synthesisAgentId) {
          return {
            ...agent,
            llm: undefined
          };
        }

        return {
          ...agent,
          llm: {
            provider: "mock",
            model: "mock-model-v1"
          }
        };
      }),
      rounds: adapter.rounds.map((round) => ({
        ...round,
        phases: round.phases.map((phase) => ({
          ...phase,
          turnOrder: phase.turnOrder.filter((agentId) => agentId !== adapter.synthesisAgentId)
        }))
      }))
    };

    const result = await runDiscussion({
      adapter: synthesisFailureAdapter,
      topic: "Test topic",
      runId: "run-step7-graceful",
      providerRegistry: new ProviderRegistry([new MockProvider()]),
      config: {
        failFast: false,
        transcript: {
          persistToFile: false,
          outputDir: "./runs",
          format: "json"
        }
      }
    });

    expect(result.context.status).toBe("done");
    expect(result.context.transcript.status).toBe("completed");
    expect(result.context.transcript.synthesis).toBeUndefined();
    expect(result.context.transcript.messages.at(-1)?.kind).toBe("error");
    expect(result.context.transcript.messages.at(-1)?.phaseId).toBe("synthesis");
  });

  test("fails run when synthesis fails and failFast=true", async () => {
    const adapter = await loadDomainAdapter("general-debate");
    const synthesisFailureAdapter: DomainAdapter = {
      ...adapter,
      agents: adapter.agents.map((agent) => {
        if (agent.id === adapter.synthesisAgentId) {
          return {
            ...agent,
            llm: undefined
          };
        }

        return {
          ...agent,
          llm: {
            provider: "mock",
            model: "mock-model-v1"
          }
        };
      }),
      rounds: adapter.rounds.map((round) => ({
        ...round,
        phases: round.phases.map((phase) => ({
          ...phase,
          turnOrder: phase.turnOrder.filter((agentId) => agentId !== adapter.synthesisAgentId)
        }))
      }))
    };

    await expect(
      runDiscussion({
        adapter: synthesisFailureAdapter,
        topic: "Test topic",
        runId: "run-step7-failfast",
        providerRegistry: new ProviderRegistry([new MockProvider()]),
        config: {
          failFast: true,
          transcript: {
            persistToFile: false,
            outputDir: "./runs",
            format: "json"
          }
        }
      })
    ).rejects.toMatchObject({
      source: "provider",
      code: "PROVIDER_MISSING_AGENT_PROVIDER"
    } satisfies Partial<OrchestratorIntegrationError>);
  });

  test("fails run when quality gate is enabled and threshold is not met with failFast=true", async () => {
    const adapter = await loadDomainAdapter("general-debate");

    await expect(
      runDiscussion({
        adapter,
        topic: "Test topic",
        runId: "run-quality-gate-failfast",
        providerRegistry: new ProviderRegistry([new MockProvider({ id: "gemini" })]),
        config: {
          failFast: true,
          qualityGate: {
            enabled: true,
            threshold: 95
          },
          transcript: {
            persistToFile: false,
            outputDir: "./runs",
            format: "json"
          }
        }
      })
    ).rejects.toMatchObject({
      code: "QUALITY_GATE_FAILED"
    } satisfies Partial<OrchestratorConfigError>);
  });
});
