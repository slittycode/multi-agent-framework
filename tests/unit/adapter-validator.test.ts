import { describe, expect, test } from "bun:test";

import type { DomainAdapter } from "../../src/types";
import { validateDomainAdapter } from "../../src/adapters/adapter-validator";
import { listBuiltinAdapterIds, loadDomainAdapter } from "../../src/adapters/adapter-loader";

const speakerAgent = {
  id: "speaker",
  name: "Speaker",
  role: "speaker",
  persona: "clear",
  systemPrompt: "speak"
};

const synthAgent = {
  id: "synth",
  name: "Synth",
  role: "synthesiser",
  persona: "balanced",
  systemPrompt: "summarise"
};

const openingPhase = {
  id: "opening",
  name: "Opening",
  instructions: "open",
  turnOrder: ["speaker", "synth"]
};

const baseRound = {
  id: "round-1",
  name: "Round One",
  phases: [openingPhase]
};

const baseAdapter: DomainAdapter = {
  id: "base-adapter",
  name: "Base Adapter",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [speakerAgent, synthAgent],
  rounds: [baseRound]
};

describe("validateDomainAdapter", () => {
  test("returns valid with zero errors for a correct adapter", () => {
    const result = validateDomainAdapter(baseAdapter);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("returns missing required field errors", () => {
    const candidate = {
      id: "x",
      name: "x",
      version: "1.0.0",
      agents: [],
      rounds: []
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "MISSING_REQUIRED_FIELD")).toBe(true);
  });

  test("returns duplicate agent id errors", () => {
    const candidate: DomainAdapter = {
      ...baseAdapter,
      agents: [
        speakerAgent,
        {
          ...synthAgent,
          id: speakerAgent.id
        }
      ]
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "DUPLICATE_AGENT_ID")).toBe(true);
  });

  test("returns synthesis agent reference errors", () => {
    const candidate: DomainAdapter = {
      ...baseAdapter,
      synthesisAgentId: "unknown-agent"
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "UNKNOWN_SYNTHESIS_AGENT")).toBe(true);
  });

  test("returns empty turnOrder error", () => {
    const candidate: DomainAdapter = {
      ...baseAdapter,
      rounds: [
        {
          ...baseRound,
          phases: [
            {
              ...openingPhase,
              turnOrder: []
            }
          ]
        }
      ]
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "EMPTY_TURN_ORDER")).toBe(true);
  });

  test("returns unknown turnOrder agent errors", () => {
    const candidate: DomainAdapter = {
      ...baseAdapter,
      rounds: [
        {
          ...baseRound,
          phases: [
            {
              ...openingPhase,
              turnOrder: ["speaker", "not-an-agent"]
            }
          ]
        }
      ]
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "UNKNOWN_TURN_ORDER_AGENT")).toBe(true);
  });

  test("returns invalid executionMode errors", () => {
    const candidate = {
      ...baseAdapter,
      rounds: [
        {
          ...baseRound,
          phases: [
            {
              ...openingPhase,
              executionMode: "broadcast"
            }
          ]
        }
      ]
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "INVALID_PHASE_EXECUTION_MODE")).toBe(true);
  });

  test("returns invalid orchestrator executionMode errors", () => {
    const candidate = {
      ...baseAdapter,
      orchestrator: {
        executionMode: "broadcast"
      }
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.code === "INVALID_ORCHESTRATOR_EXECUTION_MODE")
    ).toBe(true);
  });

  test("returns invalid contextPolicy config errors", () => {
    const candidate = {
      ...baseAdapter,
      orchestrator: {
        contextPolicy: {
          mode: "bad-mode",
          recentMessageCount: 0,
          includePhaseSummaries: "yes"
        }
      }
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "INVALID_CONTEXT_POLICY")).toBe(true);
  });

  test("returns invalid qualityGate config errors", () => {
    const candidate = {
      ...baseAdapter,
      orchestrator: {
        qualityGate: {
          enabled: "yes",
          threshold: 200,
          recordInTranscriptMetadata: "no"
        }
      }
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "INVALID_QUALITY_GATE")).toBe(true);
  });

  test("returns invalid citation config errors", () => {
    const candidate = {
      ...baseAdapter,
      orchestrator: {
        citations: {
          mode: "always-web",
          failPolicy: "ignore",
          maxWebSourcesPerTurn: 0
        }
      }
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "INVALID_CITATION_CONFIG")).toBe(true);
  });

  test("returns visibilityPolicy participant errors", () => {
    const candidate = {
      ...baseAdapter,
      rounds: [
        {
          ...baseRound,
          phases: [
            {
              ...openingPhase,
              visibilityPolicy: {
                participants: ["speaker", "unknown-agent"]
              }
            }
          ]
        }
      ]
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "UNKNOWN_VISIBILITY_PARTICIPANT")).toBe(true);
  });

  test("returns unknown round judge agent errors", () => {
    const candidate: DomainAdapter = {
      ...baseAdapter,
      orchestrator: {
        judge: {
          agentId: "unknown-agent"
        }
      }
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "UNKNOWN_JUDGE_AGENT")).toBe(true);
  });

  test("returns unknown phase judge agent errors", () => {
    const candidate: DomainAdapter = {
      ...baseAdapter,
      orchestrator: {
        phaseJudge: {
          enabled: true,
          cadence: "after_each_phase",
          agentId: "unknown-agent"
        }
      }
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "UNKNOWN_PHASE_JUDGE_AGENT")).toBe(true);
  });

  test("returns invalid phase judge config errors", () => {
    const candidate = {
      ...baseAdapter,
      orchestrator: {
        phaseJudge: {
          enabled: "true",
          cadence: "on_demand",
          agentId: "synth"
        }
      }
    };

    const result = validateDomainAdapter(candidate);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.code === "INVALID_PHASE_JUDGE_CONFIG")).toBe(true);
  });

  test("built-in adapters validate with zero errors", async () => {
    const builtins = listBuiltinAdapterIds();

    for (const id of builtins) {
      const adapter = await loadDomainAdapter(id);
      const result = validateDomainAdapter(adapter);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });
});
