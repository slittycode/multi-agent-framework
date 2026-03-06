import type { AgentId } from "./agent";
import type { JudgeConfig } from "./judge";

export interface ContextPolicyConfig {
  mode: "full" | "round_plus_recent";
  recentMessageCount?: number;
  includePhaseSummaries?: boolean;
}

export interface PhaseJudgeConfig {
  enabled: boolean;
  cadence: "after_each_phase";
  agentId: AgentId;
  promptTemplate?: string;
}

export interface QualityGateConfig {
  enabled: boolean;
  threshold: number;
  recordInTranscriptMetadata?: boolean;
}

export interface CitationConfig {
  mode: "transcript_only" | "optional_web";
  failPolicy: "graceful_fallback" | "fail_fast";
  maxWebSourcesPerTurn?: number;
}

export interface OrchestratorConfig {
  executionMode: "sequential";
  failFast?: boolean;
  judge?: JudgeConfig;
  contextPolicy?: ContextPolicyConfig;
  phaseJudge?: PhaseJudgeConfig;
  qualityGate?: QualityGateConfig;
  citations?: CitationConfig;
  retry?: {
    attempts: number;
    backoffMs: number;
  };
  synthesis: {
    agentId: AgentId;
    trigger: "after_all_rounds";
  };
  transcript: {
    persistToFile: boolean;
    outputDir: string;
    format: "json" | "jsonl";
  };
  cli: {
    showTimestamps?: boolean;
    showUsage?: boolean;
    colorize?: boolean;
  };
}
