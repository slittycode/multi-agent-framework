import { describe, expect, test } from "bun:test";

import type { ProviderGenerateRequest } from "../../src/providers/provider-client";
import { MockProvider, buildMockResponseKey } from "../../src/providers/mock-provider";
import type { Agent } from "../../src/types/agent";

const baseAgent: Agent = {
  id: "technical-critic",
  name: "Technical Critic",
  role: "critic",
  persona: "Analytical and detail-oriented",
  systemPrompt: "Evaluate technical quality.",
  llm: {
    provider: "mock",
    model: "mock-model-v1"
  }
};

function buildRequest(overrides: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    runId: "run-1",
    agent: baseAgent,
    prompt: "Assess the arrangement and tonal balance.",
    transcript: [],
    roundId: "round-opening",
    phaseId: "opening",
    messageKind: "agent_turn",
    turnIndex: 1,
    ...overrides
  };
}

describe("MockProvider", () => {
  test("returns deterministic fallback content for identical request input", async () => {
    const provider = new MockProvider();
    const request = buildRequest();

    const first = await provider.generate(request);
    const second = await provider.generate(request);

    expect(first.provider).toBe("mock");
    expect(first.model).toBe("mock-model-v1");
    expect(first.content).toBe(second.content);
    expect(first.content).toContain("[mock:technical-critic]");
    expect(first.usage?.inputTokens).toBeGreaterThan(0);
    expect(first.usage?.outputTokens).toBeGreaterThan(0);
  });

  test("uses the most specific canned response key when available", async () => {
    const key = buildMockResponseKey({
      agentId: "technical-critic",
      roundId: "round-opening",
      phaseId: "opening",
      messageKind: "agent_turn",
      turnIndex: 1
    });

    const provider = new MockProvider({
      cannedResponses: {
        [key]: "Canned: tighten sidechain compression and trim low-mid mud."
      }
    });

    const result = await provider.generate(buildRequest());

    expect(result.content).toBe("Canned: tighten sidechain compression and trim low-mid mud.");
    expect(result.raw).toEqual({ source: "canned", matchedKey: key });
  });

  test("falls back from detailed keys to agent-only canned response", async () => {
    const key = buildMockResponseKey({ agentId: "technical-critic" });

    const provider = new MockProvider({
      cannedResponses: {
        [key]: "Agent-level canned response."
      }
    });

    const result = await provider.generate(
      buildRequest({
        roundId: "round-rebuttal",
        phaseId: "rebuttal",
        messageKind: "rebuttal",
        turnIndex: 9
      })
    );

    expect(result.content).toBe("Agent-level canned response.");
    expect(result.raw).toEqual({ source: "canned", matchedKey: key });
  });

  test("supports global wildcard canned responses", async () => {
    const key = buildMockResponseKey({});

    const provider = new MockProvider({
      cannedResponses: {
        [key]: "Global canned response."
      }
    });

    const result = await provider.generate(buildRequest({ agent: { ...baseAgent, id: "listener" } }));

    expect(result.content).toBe("Global canned response.");
    expect(result.raw).toEqual({ source: "canned", matchedKey: key });
  });
});
