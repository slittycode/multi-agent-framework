import { describe, expect, test } from "bun:test";

import {
  validateDomainAdapterSchema,
  validateOrchestratorConfigSchema
} from "../../src/config/schema-validator";

describe("config/schema-validator", () => {
  test("validates a conforming orchestrator config", () => {
    const result = validateOrchestratorConfigSchema({
      executionMode: "sequential",
      synthesis: {
        agentId: "synth",
        trigger: "after_all_rounds"
      },
      transcript: {
        persistToFile: true,
        outputDir: "./runs",
        format: "json"
      },
      cli: {
        colorize: true
      }
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects invalid orchestrator config values", () => {
    const result = validateOrchestratorConfigSchema({
      executionMode: "sequential",
      qualityGate: {
        enabled: true,
        threshold: 200
      },
      synthesis: {
        agentId: "synth",
        trigger: "after_all_rounds"
      },
      transcript: {
        persistToFile: true,
        outputDir: "./runs",
        format: "json"
      },
      cli: {
        colorize: true
      }
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.instancePath === "/qualityGate/threshold")).toBe(true);
  });

  test("rejects invalid domain adapter additional properties", () => {
    const result = validateDomainAdapterSchema({
      id: "adapter",
      name: "Adapter",
      version: "1.0.0",
      synthesisAgentId: "speaker",
      agents: [
        {
          id: "speaker",
          name: "Speaker",
          role: "speaker",
          persona: "clear",
          systemPrompt: "Speak",
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
              turnOrder: ["speaker"],
              unknownField: true
            }
          ]
        }
      ]
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
  });
});
