import type { DomainAdapter } from "../types";
import type { AvailableConnector } from "./types";

export function applyConnectorToAdapter(
  adapter: DomainAdapter,
  connector: Pick<AvailableConnector, "providerId" | "defaultModel">
): DomainAdapter {
  return {
    ...adapter,
    agents: adapter.agents.map((agent) => {
      if (!agent.llm) {
        return agent;
      }

      return {
        ...agent,
        llm: {
          ...agent.llm,
          provider: connector.providerId,
          model: connector.defaultModel
        }
      };
    })
  };
}
