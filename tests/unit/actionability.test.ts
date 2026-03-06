import { describe, expect, test } from "bun:test";

import {
  ACTIONABILITY_RUBRIC_VERSION,
  evaluateTranscriptActionability
} from "../../src/core/actionability";
import type { Message, Transcript } from "../../src/types";

function createMessage(
  turnIndex: number,
  content: string,
  from = `agent-${turnIndex}`
): Message {
  return {
    id: `message-${turnIndex}`,
    runId: "run-actionability",
    roundId: "round-1",
    phaseId: turnIndex < 3 ? "opening" : "rebuttal",
    turnIndex,
    timestamp: new Date(2026, 2, turnIndex).toISOString(),
    from,
    to: "all",
    kind: turnIndex === 4 ? "synthesis" : "agent_turn",
    content
  };
}

function createTranscript(input: {
  topic: string;
  messages: Message[];
  summary?: string;
  verdict?: string;
  recommendations?: Array<{ text: string; priority?: "high" | "medium" | "low" }>;
}): Transcript {
  return {
    runId: "run-actionability",
    adapterId: "test-adapter",
    topic: input.topic,
    startedAt: new Date(2026, 2, 1).toISOString(),
    endedAt: new Date(2026, 2, 1, 0, 5).toISOString(),
    status: "completed",
    messages: input.messages,
    synthesis:
      input.summary === undefined
        ? undefined
        : {
            agentId: "synth",
            messageId: "message-4",
            summary: input.summary,
            verdict: input.verdict,
            recommendations: input.recommendations
          }
  };
}

describe("actionability", () => {
  test("passes a grounded synthesis with prioritized next steps", () => {
    const transcript = createTranscript({
      topic: "How should teams adopt async communication?",
      messages: [
        createMessage(
          1,
          "Teams adopting async communication need response-time expectations, decision logs, and explicit escalation paths."
        ),
        createMessage(
          2,
          "Without service-level expectations and ownership, async communication can hide blockers and create ambiguity."
        ),
        createMessage(
          3,
          "The rollout should start with a pilot, instrument cycle times, and publish a handbook for response norms."
        ),
        createMessage(
          4,
          "Adopt async communication deliberately by piloting in one team, documenting response norms, and measuring blocked work."
        )
      ],
      summary:
        "The discussion concluded that teams should adopt async communication only with explicit response-time norms, a published decision log, and a pilot rollout that measures blockers and cycle time.",
      verdict:
        "Async communication is effective when the team formalizes response expectations, escalation rules, and ownership before scaling it broadly.",
      recommendations: [
        {
          text: "Publish a one-page async handbook that defines expected response windows, escalation triggers, and required channels for urgent work.",
          priority: "high"
        },
        {
          text: "Run a two-week pilot in one team and measure cycle time, unresolved blockers, and missed handoffs before broader rollout.",
          priority: "high"
        },
        {
          text: "Review pilot results weekly with team leads and update the decision log to capture which async norms reduced ambiguity.",
          priority: "medium"
        }
      ]
    });

    const evaluation = evaluateTranscriptActionability(transcript, {
      evaluationTier: "live_certification",
      threshold: 80
    });

    expect(evaluation.rubricVersion).toBe(ACTIONABILITY_RUBRIC_VERSION);
    expect(evaluation.evaluationTier).toBe("live_certification");
    expect(evaluation.passed).toBe(true);
    expect(evaluation.score).toBeGreaterThanOrEqual(80);
    expect(evaluation.failureReasons).toEqual([]);
    expect(evaluation.subscores.structuralCompleteness).toBeGreaterThan(15);
    expect(evaluation.subscores.prioritizedNextStepUsefulness).toBeGreaterThan(15);
  });

  test("penalizes generic filler, repeated turns, and missing recommendations", () => {
    const repeatedContent =
      "The next step should prioritize clarity, measurable outcomes, and iteration speed.";
    const transcript = createTranscript({
      topic: "What makes product feedback actionable?",
      messages: [
        createMessage(1, repeatedContent, "advocate"),
        createMessage(2, repeatedContent, "critic"),
        createMessage(3, "I support this position and can back it with concrete examples.", "synth")
      ],
      summary: `[mock:synthesiser] ${repeatedContent} [sig:abcd1234]`
    });

    const evaluation = evaluateTranscriptActionability(transcript, {
      evaluationTier: "baseline",
      threshold: 75
    });

    expect(evaluation.evaluationTier).toBe("baseline");
    expect(evaluation.passed).toBe(false);
    expect(evaluation.score).toBeLessThan(60);
    expect(evaluation.failureReasons).toContain("Missing at least three prioritized recommendations.");
    expect(evaluation.penalties.some((penalty) => penalty.code === "GENERIC_FILLER")).toBe(true);
    expect(evaluation.penalties.some((penalty) => penalty.code === "REPEATED_TURNS")).toBe(true);
  });
});
