import type { AgentId } from "./agent";
import type { Message, MessageId } from "./message";
import type { RunId } from "./run";

export interface SynthesisOutput {
  agentId: AgentId;
  messageId: MessageId;
  summary: string;
  verdict?: string;
  recommendations?: {
    text: string;
    priority?: "high" | "medium" | "low";
  }[];
  raw?: string;
}

export interface Transcript {
  runId: RunId;
  adapterId: string;
  topic: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed";
  messages: Message[];
  synthesis?: SynthesisOutput;
  metadata?: Record<string, unknown>;
}
