import type { AgentId } from "./agent";
import type { ProviderId } from "./provider";
import type { RoundId } from "./round";

export interface JudgeDecision {
  finished: boolean;
  correctAnswer?: string;
  rationale?: string;
  score?: number;
  rubric?: {
    specificity?: number;
    rebuttalQuality?: number;
    evidenceQuality?: number;
    synthesisUtility?: number;
  };
  steeringDirectives?: string[];
}

export interface JudgeConfig {
  agentId: AgentId;
  promptTemplate?: string;
}

export interface JudgeRoundRecord {
  roundId: RoundId;
  roundName: string;
  phaseId?: string;
  phaseName?: string;
  timestamp: string;
  decision: JudgeDecision;
  provider?: ProviderId;
  model?: string;
  providerInvocationId?: string;
}

export interface JudgePhaseRecord {
  roundId: RoundId;
  roundName: string;
  phaseId: string;
  phaseName: string;
  timestamp: string;
  decision: JudgeDecision;
  provider?: ProviderId;
  model?: string;
  providerInvocationId?: string;
}
