import type { DomainAdapter, OrchestratorConfig, RunContext, Transcript } from "../types";

import { OrchestratorConfigError } from "./errors";

export interface CreateRunContextInput {
  runId: RunContext["runId"];
  adapter: DomainAdapter;
  config: OrchestratorConfig;
  transcript: Transcript;
}

const ALLOWED_STATUS_TRANSITIONS: Record<RunContext["status"], RunContext["status"][]> = {
  idle: ["running"],
  running: ["synthesizing", "done", "failed"],
  synthesizing: ["done", "failed"],
  done: [],
  failed: []
};

export function createRunContext(input: CreateRunContextInput): RunContext {
  return {
    runId: input.runId,
    adapter: input.adapter,
    config: input.config,
    transcript: input.transcript,
    currentRoundIndex: 0,
    currentPhaseIndex: 0,
    status: "idle"
  };
}

export function setRunStatus(context: RunContext, status: RunContext["status"]): RunContext {
  if (context.status === status) {
    return context;
  }

  const allowed = ALLOWED_STATUS_TRANSITIONS[context.status];
  if (!allowed.includes(status)) {
    throw new OrchestratorConfigError(
      `Invalid run status transition: ${context.status} -> ${status}`,
      "INVALID_STATUS_TRANSITION"
    );
  }

  return {
    ...context,
    status
  };
}

export function advancePhase(context: RunContext): RunContext {
  return {
    ...context,
    currentPhaseIndex: context.currentPhaseIndex + 1
  };
}

export function advanceRound(context: RunContext): RunContext {
  return {
    ...context,
    currentRoundIndex: context.currentRoundIndex + 1,
    currentPhaseIndex: 0
  };
}

export function updateTranscript(context: RunContext, transcript: Transcript): RunContext {
  return {
    ...context,
    transcript
  };
}
