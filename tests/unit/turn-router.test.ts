import { describe, expect, test } from "bun:test";

import {
  buildProviderRequest,
  buildTurnPrompt,
  filterVisibleTranscriptForAgent,
  inferMessageKind,
  normalizeContextPolicy,
  selectContextMessages
} from "../../src/core/turn-router";
import type { DomainAdapter, Round } from "../../src/types";
import type { Agent } from "../../src/types/agent";

const agent: Agent = {
  id: "critic",
  name: "Critic",
  role: "critic",
  persona: "Skeptical",
  systemPrompt: "Challenge assumptions.",
  objective: "Stress test argument",
  llm: {
    provider: "mock",
    model: "mock-model-v1"
  }
};

const round: Round = {
  id: "round-1",
  name: "Main Round",
  phases: [
    {
      id: "opening",
      name: "Opening",
      instructions: "Open",
      turnOrder: ["critic"]
    },
    {
      id: "challenge",
      name: "Challenge",
      instructions: "Challenge",
      turnOrder: ["critic"]
    },
    {
      id: "rebuttal",
      name: "Rebuttal",
      instructions: "Rebut",
      turnOrder: ["critic"]
    }
  ]
};

const adapter: DomainAdapter = {
  id: "adapter-1",
  name: "Adapter",
  version: "1.0.0",
  synthesisAgentId: "critic",
  agents: [agent],
  rounds: [round]
};

describe("core/turn-router", () => {
  test("infers message kind by phase id", () => {
    expect(inferMessageKind("challenge")).toBe("challenge");
    expect(inferMessageKind("rebuttal")).toBe("rebuttal");
    expect(inferMessageKind("opening")).toBe("agent_turn");
  });

  test("buildTurnPrompt includes agent, phase and transcript context", () => {
    const prompt = buildTurnPrompt({
      adapter,
      topic: "Test topic",
      round,
      phase: round.phases[0] as Round["phases"][number],
      agent,
      transcript: {
        runId: "run-1",
        adapterId: "adapter-1",
        topic: "Test topic",
        startedAt: "2026-03-05T00:00:00.000Z",
        status: "running",
        messages: [
          {
            id: "msg-1",
            runId: "run-1",
            turnIndex: 1,
            timestamp: "2026-03-05T00:00:01.000Z",
            from: "critic",
            kind: "agent_turn",
            content: "First line"
          }
        ]
      }
    });

    expect(prompt).toContain("Adapter: Adapter");
    expect(prompt).toContain("Phase: Opening");
    expect(prompt).toContain("Agent Name: Critic");
    expect(prompt).toContain("First line");
    expect(prompt).toContain("Required response structure:");
    expect(prompt).toContain("Citations: include transcript refs like [T2], [T5].");
  });

  test("buildProviderRequest returns full provider request metadata", () => {
    const request = buildProviderRequest({
      runId: "run-1",
      adapter,
      topic: "Test topic",
      round,
      phase: round.phases[1] as Round["phases"][number],
      agent,
      transcript: {
        runId: "run-1",
        adapterId: "adapter-1",
        topic: "Test topic",
        startedAt: "2026-03-05T00:00:00.000Z",
        status: "running",
        messages: []
      },
      turnIndex: 3
    });

    expect(request.runId).toBe("run-1");
    expect(request.roundId).toBe("round-1");
    expect(request.phaseId).toBe("challenge");
    expect(request.messageKind).toBe("challenge");
    expect(request.turnIndex).toBe(3);
    expect(request.metadata?.agentId).toBe("critic");
  });

  test("filterVisibleTranscriptForAgent applies symmetric participant scoping", () => {
    const scopedAdapter: DomainAdapter = {
      ...adapter,
      agents: [
        ...adapter.agents,
        {
          ...agent,
          id: "observer",
          name: "Observer"
        }
      ],
      rounds: [
        {
          ...round,
          phases: round.phases.map((phase) =>
            phase.id === "challenge"
              ? {
                  ...phase,
                  turnOrder: ["critic", "observer"],
                  visibilityPolicy: {
                    participants: ["critic"]
                  }
                }
              : phase
          )
        }
      ]
    };

    const transcript = {
      runId: "run-1",
      adapterId: "adapter-1",
      topic: "Test topic",
      startedAt: "2026-03-05T00:00:00.000Z",
      status: "running" as const,
      messages: [
        {
          id: "msg-1",
          runId: "run-1",
          roundId: "round-1",
          phaseId: "opening",
          turnIndex: 1,
          timestamp: "2026-03-05T00:00:01.000Z",
          from: "critic" as const,
          kind: "agent_turn" as const,
          content: "Open"
        },
        {
          id: "msg-2",
          runId: "run-1",
          roundId: "round-1",
          phaseId: "challenge",
          turnIndex: 2,
          timestamp: "2026-03-05T00:00:02.000Z",
          from: "critic" as const,
          kind: "challenge" as const,
          content: "Scoped"
        },
        {
          id: "msg-3",
          runId: "run-1",
          roundId: "round-1",
          phaseId: "challenge",
          turnIndex: 3,
          timestamp: "2026-03-05T00:00:03.000Z",
          from: "orchestrator" as const,
          kind: "system" as const,
          content: "System note"
        }
      ]
    };

    const criticView = filterVisibleTranscriptForAgent(scopedAdapter, transcript, "critic");
    const observerView = filterVisibleTranscriptForAgent(scopedAdapter, transcript, "observer");

    expect(criticView.map((message) => message.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(observerView.map((message) => message.id)).toEqual(["msg-1", "msg-3"]);
  });

  test("buildProviderRequest supports explicit transcriptMessages override", () => {
    const request = buildProviderRequest({
      runId: "run-1",
      adapter,
      topic: "Test topic",
      round,
      phase: round.phases[1] as Round["phases"][number],
      agent,
      transcript: {
        runId: "run-1",
        adapterId: "adapter-1",
        topic: "Test topic",
        startedAt: "2026-03-05T00:00:00.000Z",
        status: "running",
        messages: [
          {
            id: "msg-1",
            runId: "run-1",
            turnIndex: 1,
            timestamp: "2026-03-05T00:00:01.000Z",
            from: "critic",
            kind: "agent_turn",
            content: "Hidden"
          }
        ]
      },
      transcriptMessages: [
        {
          id: "msg-2",
          runId: "run-1",
          turnIndex: 2,
          timestamp: "2026-03-05T00:00:02.000Z",
          from: "critic",
          kind: "agent_turn",
          content: "Visible"
        }
      ],
      turnIndex: 3
    });

    expect(request.transcript).toHaveLength(1);
    expect(request.transcript[0]?.content).toBe("Visible");
    expect(request.prompt).toContain("Visible");
    expect(request.prompt).not.toContain("Hidden");
  });

  test("selectContextMessages keeps current round + recent cross-round messages", () => {
    const messages = [
      {
        id: "m1",
        runId: "run-1",
        roundId: "round-old",
        phaseId: "opening",
        turnIndex: 1,
        timestamp: "2026-03-05T00:00:01.000Z",
        from: "critic",
        kind: "agent_turn" as const,
        content: "Old 1"
      },
      {
        id: "m2",
        runId: "run-1",
        roundId: "round-old",
        phaseId: "rebuttal",
        turnIndex: 2,
        timestamp: "2026-03-05T00:00:02.000Z",
        from: "critic",
        kind: "rebuttal" as const,
        content: "Old 2"
      },
      {
        id: "m3",
        runId: "run-1",
        roundId: "round-1",
        phaseId: "opening",
        turnIndex: 3,
        timestamp: "2026-03-05T00:00:03.000Z",
        from: "critic",
        kind: "agent_turn" as const,
        content: "Current 1"
      },
      {
        id: "m4",
        runId: "run-1",
        roundId: "round-1",
        phaseId: "challenge",
        turnIndex: 4,
        timestamp: "2026-03-05T00:00:04.000Z",
        from: "critic",
        kind: "challenge" as const,
        content: "Current 2"
      }
    ];

    const selected = selectContextMessages({
      round,
      messages,
      policy: {
        mode: "round_plus_recent",
        recentMessageCount: 1
      }
    });

    expect(selected.map((message) => message.id)).toEqual(["m2", "m3", "m4"]);
  });

  test("normalizeContextPolicy defaults to round_plus_recent", () => {
    const normalized = normalizeContextPolicy();
    expect(normalized.mode).toBe("round_plus_recent");
    expect(normalized.recentMessageCount).toBe(4);
    expect(normalized.includePhaseSummaries).toBe(true);
  });
});
