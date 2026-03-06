import type { DomainAdapter } from "./domain-adapter";
import type { OrchestratorConfig } from "./orchestrator-config";
import type { Transcript } from "./transcript";

export type RunId = string;

export interface RunContext {
  runId: RunId;
  adapter: DomainAdapter;
  config: OrchestratorConfig;
  transcript: Transcript;
  currentRoundIndex: number;
  currentPhaseIndex: number;
  status: "idle" | "running" | "synthesizing" | "done" | "failed";
}
