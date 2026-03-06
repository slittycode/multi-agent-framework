import {
  describeProviderSupport,
  getDefaultModelForProvider,
  listLiveCapableProviderIds
} from "../providers/provider-support";
import type { AvailableConnector } from "./types";

export function discoverEnvConnectors(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): AvailableConnector[] {
  const connectors: AvailableConnector[] = [];

  for (const providerId of listLiveCapableProviderIds()) {
    const support = describeProviderSupport(providerId);
    const defaultModel = getDefaultModelForProvider(providerId);
    if (!defaultModel) {
      continue;
    }

    switch (providerId) {
      case "gemini": {
        const apiKey = env.GEMINI_API_KEY?.trim();
        if (!apiKey) {
          continue;
        }
        connectors.push({
          id: "gemini-env",
          providerId,
          authMethod: "api-key",
          defaultModel,
          credentialSource: "env",
          credentialRef: "GEMINI_API_KEY",
          lastCertificationStatus: "never",
          runtimeStatus: "ready",
          ...(support.providerNote ? { providerNote: support.providerNote } : {}),
          ephemeral: true
        });
        break;
      }
      case "kimi": {
        const apiKey = env.KIMI_API_KEY?.trim();
        if (!apiKey) {
          continue;
        }
        connectors.push({
          id: "kimi-env",
          providerId,
          authMethod: "api-key",
          defaultModel,
          credentialSource: "env",
          credentialRef: "KIMI_API_KEY",
          lastCertificationStatus: "never",
          runtimeStatus: "ready",
          ...(support.providerNote ? { providerNote: support.providerNote } : {}),
          ...(env.KIMI_BASE_URL?.trim() ? { baseURL: env.KIMI_BASE_URL.trim() } : {}),
          ephemeral: true
        });
        break;
      }
      case "openai": {
        const apiKey = env.OPENAI_API_KEY?.trim();
        if (!apiKey) {
          continue;
        }
        connectors.push({
          id: "openai-env",
          providerId,
          authMethod: "api-key",
          defaultModel,
          credentialSource: "env",
          credentialRef: "OPENAI_API_KEY",
          lastCertificationStatus: "never",
          runtimeStatus: "ready",
          ...(support.providerNote ? { providerNote: support.providerNote } : {}),
          ephemeral: true
        });
        break;
      }
      default:
        break;
    }
  }

  return connectors;
}
