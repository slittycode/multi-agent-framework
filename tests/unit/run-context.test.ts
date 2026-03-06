import { describe, expect, test } from "bun:test";

import {
  advancePhase,
  advanceRound,
  createRunContext,
  setRunStatus,
  updateTranscript
} from "../../src/core/run-context";
import { OrchestratorConfigError } from "../../src/core/errors";
import type { DomainAdapter, OrchestratorConfig, Transcript } from "../../src/types";

const adapter: DomainAdapter = {
  id: "adapter-1",
  name: "Adapter One",
  version: "1.0.0",
  synthesisAgentId: "synth",
  agents: [
    {
      id: "synth",
      name: "Synth",
      role: "synth",
      persona: "summary",
      systemPrompt: "summarise"
    }
  ],
  rounds: [
    {
      id: "round-1",
      name: "Round 1",
      phases: [
        {
          id: "opening",
          name: "Opening",
          instructions: "Open",
          turnOrder: ["synth"]
        }
      ]
    }
  ]
};

const config: OrchestratorConfig = {
  executionMode: "sequential",
  failFast: false,
  retry: {
    attempts: 1,
    backoffMs: 0
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
    showTimestamps: true,
    showUsage: true,
    colorize: true
  }
};

const transcript: Transcript = {
  runId: "run-1",
  adapterId: "adapter-1",
  topic: "Test topic",
  startedAt: "2026-03-05T00:00:00.000Z",
  status: "running",
  messages: []
};

describe("core/run-context", () => {
  test("creates initial idle context", () => {
    const context = createRunContext({
      runId: "run-1",
      adapter,
      config,
      transcript
    });

    expect(context.status).toBe("idle");
    expect(context.currentRoundIndex).toBe(0);
    expect(context.currentPhaseIndex).toBe(0);
  });

  test("supports valid status transitions", () => {
    const context = createRunContext({
      runId: "run-1",
      adapter,
      config,
      transcript
    });

    const running = setRunStatus(context, "running");
    const done = setRunStatus(running, "done");

    expect(running.status).toBe("running");
    expect(done.status).toBe("done");
  });

  test("rejects invalid status transitions", () => {
    const context = createRunContext({
      runId: "run-1",
      adapter,
      config,
      transcript
    });

    expect(() => setRunStatus(context, "done")).toThrow(OrchestratorConfigError);
  });

  test("advances phase and round indexes", () => {
    const context = createRunContext({
      runId: "run-1",
      adapter,
      config,
      transcript
    });

    const withPhase = advancePhase(context);
    const withRound = advanceRound(withPhase);

    expect(withPhase.currentPhaseIndex).toBe(1);
    expect(withRound.currentRoundIndex).toBe(1);
    expect(withRound.currentPhaseIndex).toBe(0);
  });

  test("updates transcript immutably", () => {
    const context = createRunContext({
      runId: "run-1",
      adapter,
      config,
      transcript
    });

    const nextTranscript: Transcript = {
      ...transcript,
      messages: [
        {
          id: "msg-1",
          runId: "run-1",
          turnIndex: 1,
          timestamp: "2026-03-05T00:00:01.000Z",
          from: "synth",
          kind: "agent_turn",
          content: "hello"
        }
      ]
    };

    const updated = updateTranscript(context, nextTranscript);

    expect(updated.transcript.messages).toHaveLength(1);
    expect(context.transcript.messages).toHaveLength(0);
  });
});
