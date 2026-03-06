import type { AgentId } from "./agent";
import type { ProviderId } from "./provider";
import type { RoundId } from "./round";
import type { RunId } from "./run";

export type MessageId = string;

export type MessageKind =
  | "user_input"
  | "agent_turn"
  | "challenge"
  | "rebuttal"
  | "synthesis"
  | "system"
  | "error";

export interface Message {
  id: MessageId;
  runId: RunId;
  roundId?: RoundId;
  phaseId?: string;
  turnIndex: number;
  timestamp: string;
  from: AgentId | "user" | "orchestrator" | "system";
  to?: AgentId | "all" | "synthesis";
  kind: MessageKind;
  content: string;
  respondingToMessageId?: MessageId;
  provider?: ProviderId;
  model?: string;
  providerInvocationId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  };
  metadata?: Record<string, unknown>;
}
