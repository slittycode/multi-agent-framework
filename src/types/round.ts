import type { AgentId } from "./agent";

export type RoundId = string;

export interface RoundPhaseVisibilityPolicy {
  participants: AgentId[];
}

export interface RoundPhase {
  id: string;
  name: string;
  instructions: string;
  turnOrder: AgentId[];
  maxTurnsPerAgent?: number;
  executionMode?: "sequential" | "fanout";
  visibilityPolicy?: RoundPhaseVisibilityPolicy;
}

export interface Round {
  id: RoundId;
  name: string;
  description?: string;
  phases: RoundPhase[];
}
