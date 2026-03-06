import { describe, expect, test } from "bun:test";

import { MockProvider, buildMockResponseKey } from "../../src/providers/mock-provider";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { Agent } from "../../src/types/agent";
import type { Message } from "../../src/types/message";

const technicalAgent: Agent = {
  id: "technical-critic",
  name: "Technical Critic",
  role: "technical-critic",
  persona: "Precision-focused and practical",
  systemPrompt: "Focus on mix, arrangement, and production details.",
  llm: {
    provider: "mock",
    model: "mock-model-v1"
  }
};

const emotionalAgent: Agent = {
  id: "listener",
  name: "Listener",
  role: "emotional-listener",
  persona: "Emotion-focused and audience-oriented",
  systemPrompt: "Focus on emotional impact and listener experience.",
  llm: {
    provider: "mock",
    model: "mock-model-v1"
  }
};

describe("Provider integration: ProviderRegistry + MockProvider", () => {
  test("routes agent requests and honors canned responses without external APIs", async () => {
    const openingKey = buildMockResponseKey({
      agentId: "technical-critic",
      phaseId: "opening"
    });

    const provider = new MockProvider({
      cannedResponses: {
        [openingKey]: "Technical opening: clean low-end before widening the stereo image."
      }
    });

    const registry = new ProviderRegistry([provider]);

    const transcript: Message[] = [];

    const firstTurn = await registry.generateForAgent(technicalAgent, {
      runId: "run-integration-1",
      prompt: "Provide opening feedback.",
      transcript,
      roundId: "round-opening",
      phaseId: "opening",
      messageKind: "agent_turn",
      turnIndex: 1
    });

    expect(firstTurn.content).toBe(
      "Technical opening: clean low-end before widening the stereo image."
    );

    transcript.push({
      id: "msg-1",
      runId: "run-integration-1",
      roundId: "round-opening",
      phaseId: "opening",
      turnIndex: 1,
      timestamp: "2026-03-05T00:00:00.000Z",
      from: technicalAgent.id,
      to: "all",
      kind: "agent_turn",
      content: firstTurn.content,
      provider: firstTurn.provider,
      model: firstTurn.model
    });

    const secondTurn = await registry.generateForAgent(emotionalAgent, {
      runId: "run-integration-1",
      prompt: "Challenge the technical position from a listener perspective.",
      transcript,
      roundId: "round-opening",
      phaseId: "challenge",
      messageKind: "challenge",
      turnIndex: 2
    });

    expect(secondTurn.content).toContain("[mock:listener]");
    expect(secondTurn.provider).toBe("mock");
    expect(secondTurn.model).toBe("mock-model-v1");
  });
});
