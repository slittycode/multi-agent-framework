import { describe, expect, test } from "bun:test";

import type { ProviderClient } from "../../src/providers/provider-client";
import {
  DuplicateProviderError,
  MissingAgentProviderError,
  ProviderRegistry,
  UnknownProviderError
} from "../../src/providers/provider-registry";
import type { Agent } from "../../src/types/agent";

const baseAgent: Agent = {
  id: "debater-a",
  name: "Debater A",
  role: "critic",
  persona: "Direct and logical",
  systemPrompt: "Take a position and defend it.",
  llm: {
    provider: "mock",
    model: "mock-model-v1"
  }
};

function createProvider(id = "mock"): ProviderClient {
  return {
    id,
    async generate(request) {
      return {
        content: `reply:${request.agent.id}`,
        provider: id,
        model: request.agent.llm?.model ?? "unknown"
      };
    }
  };
}

describe("ProviderRegistry", () => {
  test("registers and retrieves providers", () => {
    const registry = new ProviderRegistry();
    const provider = createProvider();

    registry.register(provider);

    expect(registry.has("mock")).toBe(true);
    expect(registry.get("mock")).toBe(provider);
    expect(registry.list()).toEqual(["mock"]);
  });

  test("throws on duplicate provider registration unless replace=true", () => {
    const registry = new ProviderRegistry();
    registry.register(createProvider("mock"));

    expect(() => registry.register(createProvider("mock"))).toThrow(DuplicateProviderError);

    expect(() => registry.register(createProvider("mock"), { replace: true })).not.toThrow();
  });

  test("throws UnknownProviderError for missing provider", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.get("missing")).toThrow(UnknownProviderError);
  });

  test("resolveForAgent throws when agent has no provider", () => {
    const registry = new ProviderRegistry([createProvider("mock")]);

    const agentWithoutProvider: Agent = {
      ...baseAgent,
      id: "no-provider-agent",
      llm: undefined
    };

    expect(() => registry.resolveForAgent(agentWithoutProvider)).toThrow(MissingAgentProviderError);
  });

  test("generateForAgent delegates to the resolved provider", async () => {
    const registry = new ProviderRegistry([createProvider("mock")]);

    const result = await registry.generateForAgent(baseAgent, {
      runId: "run-1",
      prompt: "opening statement",
      transcript: [],
      phaseId: "opening",
      roundId: "round-1",
      messageKind: "agent_turn",
      turnIndex: 1
    });

    expect(result.content).toBe("reply:debater-a");
    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-model-v1");
  });
});
