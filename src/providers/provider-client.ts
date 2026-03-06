import type { Agent } from "../types/agent";
import type { Message, MessageKind } from "../types/message";
import type { ProviderId } from "../types/provider";
import type { RoundId } from "../types/round";
import type { RunId } from "../types/run";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

export interface ProviderGenerateRequest {
  runId: RunId;
  agent: Agent;
  systemPrompt?: string;
  prompt: string;
  transcript: Message[];
  roundId?: RoundId;
  phaseId?: string;
  messageKind?: MessageKind;
  turnIndex?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderGenerateResult {
  content: string;
  provider: ProviderId;
  model: string;
  invocationId?: string;
  usage?: ProviderUsage;
  raw?: unknown;
}

export interface ProviderClient {
  readonly id: ProviderId;
  generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult>;
}
