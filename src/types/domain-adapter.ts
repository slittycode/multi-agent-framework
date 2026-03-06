import type { Agent, AgentId } from "./agent";
import type { OrchestratorConfig } from "./orchestrator-config";
import type { Round } from "./round";

export interface DomainAdapter {
  id: string;
  name: string;
  version: string;
  description?: string;
  agents: Agent[];
  rounds: Round[];
  synthesisAgentId: AgentId;
  orchestrator?: Partial<OrchestratorConfig>;
  inputSchema?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  prompts?: {
    runIntro?: string;
    synthesisInstructions?: string;
  };
}
