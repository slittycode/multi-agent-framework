import type { DomainAdapter } from "../types";
import type { ProviderId } from "../types/provider";
import type { AvailableConnector } from "../connectors/types";
import { GeminiProviderClient } from "./clients/gemini";
import { KimiProviderClient } from "./clients/kimi";
import { OpenAIChatGptOAuthProviderClient } from "./clients/openai-chatgpt-oauth";
import { OpenAIProviderClient } from "./clients/openai";
import { MockProvider } from "./mock-provider";
import {
  describeProviderSupport,
  isProviderImplemented,
  listLiveCapableProviderIds,
  type ProviderSupportDescriptor
} from "./provider-support";
import {
  ProviderCredentialsMissingError,
  ProviderNotImplementedError,
  ProviderUnsupportedIdError,
  UnsupportedProviderModeError
} from "./errors";
import { ProviderRegistry } from "./provider-registry";

export type ProviderMode = "mock" | "live" | "auto";
export { describeProviderSupport, type ProviderSupportDescriptor } from "./provider-support";

export interface CreateProviderRegistryForRunInput {
  adapter: DomainAdapter;
  providerMode: ProviderMode;
  env?: Record<string, string | undefined>;
  connectorByProviderId?: Partial<Record<ProviderId, AvailableConnector>>;
}

interface CredentialRequirement {
  requiredEnv: string[];
}

const LIVE_PROVIDER_IDS = new Set<ProviderId>([
  ...listLiveCapableProviderIds(),
  "claude"
]);
export const LIVE_CERTIFICATION_PROVIDER_IDS = listLiveCapableProviderIds();

export function collectRequiredProviderIds(adapter: DomainAdapter): ProviderId[] {
  const required = new Set<ProviderId>();

  for (const agent of adapter.agents) {
    const providerId = agent.llm?.provider;
    if (providerId) {
      required.add(providerId);
    }
  }

  return [...required];
}

export function getCredentialRequirement(
  providerId: ProviderId,
  connector?: Pick<AvailableConnector, "credentialSource">
): CredentialRequirement | null {
  if (connector?.credentialSource === "codex-app-server") {
    return null;
  }

  const support = describeProviderSupport(providerId);
  return support.requiredEnv.length > 0 ? { requiredEnv: support.requiredEnv } : null;
}

export function getAdapterProviderCapabilities(adapter: DomainAdapter): ProviderSupportDescriptor[] {
  return collectRequiredProviderIds(adapter).map((providerId) => describeProviderSupport(providerId));
}

function assertSupportedLiveProvider(providerId: ProviderId): void {
  if (providerId === "mock" || !LIVE_PROVIDER_IDS.has(providerId)) {
    throw new ProviderUnsupportedIdError(providerId);
  }
}

function assertCredentials(
  providerId: ProviderId,
  env: Record<string, string | undefined>,
  connector?: AvailableConnector
): void {
  const requirement = getCredentialRequirement(providerId, connector);
  if (!requirement || requirement.requiredEnv.length === 0) {
    return;
  }

  const missing = requirement.requiredEnv.filter((envName) => {
    const value = env[envName];
    return typeof value !== "string" || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new ProviderCredentialsMissingError(providerId, missing);
  }
}

function createMockRegistry(adapter: DomainAdapter): ProviderRegistry {
  const registry = new ProviderRegistry();
  const requiredProviderIds = collectRequiredProviderIds(adapter);

  for (const providerId of requiredProviderIds) {
    registry.register(new MockProvider({ id: providerId }), { replace: false });
  }

  return registry;
}

export function createLiveProviderClient(
  providerId: ProviderId,
  env: Record<string, string | undefined>,
  connector?: AvailableConnector
) {
  switch (providerId) {
    case "gemini":
      return new GeminiProviderClient({ apiKey: env.GEMINI_API_KEY });
    case "kimi":
      return new KimiProviderClient({
        apiKey: env.KIMI_API_KEY,
        baseURL: env.KIMI_BASE_URL
      });
    case "openai":
      if (connector?.authMethod === "chatgpt-oauth" || connector?.credentialSource === "codex-app-server") {
        return new OpenAIChatGptOAuthProviderClient({
          env
        });
      }
      return new OpenAIProviderClient({
        apiKey: env.OPENAI_API_KEY
      });
    default:
      throw new ProviderNotImplementedError(providerId);
  }
}

function createLiveRegistry(
  adapter: DomainAdapter,
  env: Record<string, string | undefined>,
  allowMockProviders: boolean,
  connectorByProviderId?: Partial<Record<ProviderId, AvailableConnector>>
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const requiredProviderIds = collectRequiredProviderIds(adapter);

  for (const providerId of requiredProviderIds) {
    if (providerId === "mock") {
      if (allowMockProviders) {
        registry.register(new MockProvider({ id: providerId }), { replace: false });
      } else {
        throw new ProviderNotImplementedError(providerId);
      }
      continue;
    }

    assertSupportedLiveProvider(providerId);
    const connector = connectorByProviderId?.[providerId];
    assertCredentials(providerId, env, connector);

    if (!isProviderImplemented(providerId)) {
      throw new ProviderNotImplementedError(providerId);
    }

    registry.register(createLiveProviderClient(providerId, env, connector), { replace: false });
  }

  return registry;
}

export function createProviderRegistryForRun({
  adapter,
  providerMode,
  env = process.env as Record<string, string | undefined>,
  connectorByProviderId
}: CreateProviderRegistryForRunInput): ProviderRegistry {
  switch (providerMode) {
    case "mock":
      return createMockRegistry(adapter);
    case "live":
      return createLiveRegistry(adapter, env, false, connectorByProviderId);
    case "auto":
      return createLiveRegistry(adapter, env, true, connectorByProviderId);
    default:
      throw new UnsupportedProviderModeError(providerMode);
  }
}
