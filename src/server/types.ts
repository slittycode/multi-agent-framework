import type { RunAgentOverrideMap } from "../run/prepare-run";

export interface ApiRunStartRequest {
  adapterId: string;
  topic: string;
  connectorId?: string;
  model?: string;
  agentOverrides?: RunAgentOverrideMap;
}

export interface ApiRunListEntry {
  runId: string;
  adapterId: string;
  topic: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  actionabilityScore?: number;
}

export interface ApiRunCompleteEventMessage {
  runId: string;
  status: "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  persistedPath?: string;
}

export interface ApiRunInjectionRequest {
  content: string;
  fromLabel?: string;
  targetPhaseId?: string;
}

export interface ApiRunSteerRequest {
  agentId: string;
  directive: string;
  turnsRemaining?: number;
}

export interface ApiRunLifecycleEventMessage {
  runId: string;
  currentPhaseId?: string;
  currentRoundId?: string;
  turnIndex: number;
  resumedFromPause?: boolean;
}

export type ApiRunStreamEvent =
  | { type: "turn" | "synthesis" | "error" | "injection"; message: import("../types").Message }
  | { type: "pause" | "resume" | "interrupt"; message: ApiRunLifecycleEventMessage }
  | { type: "complete"; message: ApiRunCompleteEventMessage };

export interface ApiConnectorListEntry {
  id: string;
  active: boolean;
  providerId: string;
  authMethod: string;
  credentialSource: string;
  ephemeral: boolean;
  defaultModel: string;
  runtimeStatus: string;
  runtimeStatusReason?: string;
  certificationStatus: string;
  certificationProfile?: string;
  trackedIssueUrl?: string;
  providerNote?: string;
}
