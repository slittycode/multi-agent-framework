import { describe, expect, test } from "bun:test";

import type { ProviderGenerateRequest } from "../../src/providers/provider-client";
import { MockProvider, buildMockResponseKey } from "../../src/providers/mock-provider";
import type { Agent } from "../../src/types/agent";
import type { Message } from "../../src/types/message";

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

function buildTranscriptMessage(
  turnIndex: number,
  content: string,
  from = `agent-${turnIndex}`
): Message {
  return {
    id: `message-${turnIndex}`,
    runId: "run-1",
    roundId: "round-opening",
    phaseId: "opening",
    turnIndex,
    timestamp: new Date(2026, 2, turnIndex).toISOString(),
    from,
    to: "all",
    kind: "agent_turn",
    content
  };
}

describe("MockProvider", () => {
  test("returns deterministic fallback content for identical request input", async () => {
    const provider = new MockProvider();
    const request = buildRequest({
      transcript: [
        buildTranscriptMessage(
          1,
          "The low end masks the kick transient, and the arrangement loses impact in the chorus.",
          "listener"
        )
      ]
    });

    const first = await provider.generate(request);
    const second = await provider.generate(request);

    expect(first.provider).toBe("mock");
    expect(first.model).toBe("mock-model-v1");
    expect(first.content).toBe(second.content);
    expect(first.content).toContain("Claim:");
    expect(first.content).toContain("Counterpoint:");
    expect(first.content).toContain("Evidence:");
    expect(first.content).toContain("[T1]");
    expect(first.usage?.inputTokens).toBeGreaterThan(0);
    expect(first.usage?.outputTokens).toBeGreaterThan(0);
  });

  test("returns strict JSON fallback for judge requests", async () => {
    const provider = new MockProvider();

    const result = await provider.generate(
      buildRequest({
        agent: { ...baseAgent, id: "judge", role: "judge" },
        phaseId: "judge",
        messageKind: undefined,
        transcript: [buildTranscriptMessage(1, "Opening argument with concrete claims.", "speaker")]
      })
    );

    const parsed = JSON.parse(result.content) as {
      finished: boolean;
      rationale?: string;
      score?: number;
      steeringDirectives?: string[];
    };

    expect(parsed.finished).toBe(false);
    expect(parsed.rationale).toEqual(expect.any(String));
    expect(parsed.score).toEqual(expect.any(Number));
    expect(parsed.steeringDirectives).toHaveLength(2);
  });

  test("returns strict JSON fallback for synthesis requests", async () => {
    const provider = new MockProvider();

    const result = await provider.generate(
      buildRequest({
        agent: { ...baseAgent, id: "synth", role: "synthesiser" },
        phaseId: "synthesis",
        messageKind: "synthesis",
        transcript: [
          buildTranscriptMessage(
            1,
            "Teams need response-time norms, a decision log, and a pilot before scaling async work.",
            "advocate"
          ),
          buildTranscriptMessage(
            2,
            "Without ownership and escalation paths, async processes hide blockers and create ambiguity.",
            "critic"
          )
        ]
      })
    );

    const parsed = JSON.parse(result.content) as {
      summary: string;
      verdict?: string;
      recommendations?: Array<{ text: string; priority?: string }>;
    };

    expect(parsed.summary.split(/[.!?]/u).filter((segment) => segment.trim().length > 0).length).toBeGreaterThanOrEqual(2);
    expect(parsed.verdict).toEqual(expect.any(String));
    expect(parsed.recommendations).toHaveLength(3);
    expect(parsed.recommendations?.every((item) => item.priority)).toBe(true);
    expect(parsed.recommendations?.some((item) => item.text.includes("[T1]"))).toBe(true);
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
