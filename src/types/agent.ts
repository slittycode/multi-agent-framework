import type { ProviderId } from "./provider";

export type AgentId = string;

export interface AgentLLMConfig {
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeoutMs?: number;
  providerOptions?: Record<string, unknown>;
}

export interface Agent {
  id: AgentId;
  name: string;
  role: string;
  persona: string;
  systemPrompt: string;
  objective?: string;
  llm?: AgentLLMConfig;
  metadata?: Record<string, unknown>;
}
