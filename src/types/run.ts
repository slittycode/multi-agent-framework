import type { AgentId } from "./agent";
import type { DomainAdapter } from "./domain-adapter";
import type { Message } from "./message";
import type { OrchestratorConfig } from "./orchestrator-config";
import type { Transcript } from "./transcript";

export type RunId = string;

export interface InterTurnHookState {
  runId: RunId;
  transcript: Transcript;
  currentPhaseId?: string;
  currentRoundId?: string;
  turnIndex: number;
  boundary: "phase_start" | "turn_complete";
  nextAgentId?: AgentId;
  completedAgentId?: AgentId;
}

export interface InterTurnPauseResumeOutcome {
  interrupt?: boolean;
  resumedFromPause?: boolean;
}

export interface InterTurnHookResult {
  injectedMessages?: Message[];
  pause?: {
    resumeSignal: Promise<InterTurnPauseResumeOutcome | void>;
  };
  interrupt?: boolean | { resumedFromPause?: boolean };
  nextTurnSystemPromptOverrides?: Partial<Record<AgentId, string>>;
}

export type InterTurnHook = (
  state: InterTurnHookState
) => Promise<InterTurnHookResult | void> | InterTurnHookResult | void;

export interface RunLifecycleEventMessage {
  runId: RunId;
  currentPhaseId?: string;
  currentRoundId?: string;
  turnIndex: number;
  resumedFromPause?: boolean;
}

export interface RunLifecycleEvent {
  type: "pause" | "resume" | "interrupt";
  message: RunLifecycleEventMessage;
}

export interface RunContext {
  runId: RunId;
  adapter: DomainAdapter;
  config: OrchestratorConfig;
  transcript: Transcript;
  currentRoundIndex: number;
  currentPhaseIndex: number;
  status: "idle" | "running" | "synthesizing" | "done" | "failed";
  interrupted: boolean;
}
