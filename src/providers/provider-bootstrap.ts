import type { DomainAdapter } from "../types";
import type { ProviderId } from "../types/provider";
import { GeminiProviderClient } from "./clients/gemini";
import { KimiProviderClient } from "./clients/kimi";
import { MockProvider } from "./mock-provider";
import {
  ProviderCredentialsMissingError,
  ProviderNotImplementedError,
  ProviderUnsupportedIdError,
  UnsupportedProviderModeError
} from "./errors";
import { ProviderRegistry } from "./provider-registry";

export type ProviderMode = "mock" | "live" | "auto";

export interface CreateProviderRegistryForRunInput {
  adapter: DomainAdapter;
  providerMode: ProviderMode;
  env?: Record<string, string | undefined>;
}

interface CredentialRequirement {
  requiredEnv: string[];
}

const LIVE_PROVIDER_IDS = new Set<ProviderId>(["gemini", "kimi", "openai", "claude"]);
const IMPLEMENTED_LIVE_PROVIDER_IDS = new Set<ProviderId>(["gemini", "kimi"]);

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

export function getCredentialRequirement(providerId: ProviderId): CredentialRequirement | null {
  switch (providerId) {
    case "mock":
      return null;
    case "gemini":
      return { requiredEnv: ["GEMINI_API_KEY"] };
    case "kimi":
      return { requiredEnv: ["KIMI_API_KEY"] };
    case "openai":
      return { requiredEnv: ["OPENAI_API_KEY"] };
    case "claude":
      return { requiredEnv: ["ANTHROPIC_API_KEY"] };
    default:
      return null;
  }
}

export function isProviderImplemented(providerId: ProviderId): boolean {
  return IMPLEMENTED_LIVE_PROVIDER_IDS.has(providerId);
}

function assertSupportedLiveProvider(providerId: ProviderId): void {
  if (!LIVE_PROVIDER_IDS.has(providerId)) {
    throw new ProviderUnsupportedIdError(providerId);
  }
}

function assertCredentials(providerId: ProviderId, env: Record<string, string | undefined>): void {
  const requirement = getCredentialRequirement(providerId);
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

function createLiveProviderClient(
  providerId: ProviderId,
  env: Record<string, string | undefined>
) {
  switch (providerId) {
    case "gemini":
      return new GeminiProviderClient({ apiKey: env.GEMINI_API_KEY });
    case "kimi":
      return new KimiProviderClient({
        apiKey: env.KIMI_API_KEY,
        baseURL: env.KIMI_BASE_URL
      });
    default:
      throw new ProviderNotImplementedError(providerId);
  }
}

function createLiveRegistry(
  adapter: DomainAdapter,
  env: Record<string, string | undefined>,
  allowMockProviders: boolean
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
    assertCredentials(providerId, env);

    if (!isProviderImplemented(providerId)) {
      throw new ProviderNotImplementedError(providerId);
    }

    registry.register(createLiveProviderClient(providerId, env), { replace: false });
  }

  return registry;
}

export function createProviderRegistryForRun({
  adapter,
  providerMode,
  env = process.env as Record<string, string | undefined>
}: CreateProviderRegistryForRunInput): ProviderRegistry {
  switch (providerMode) {
    case "mock":
      return createMockRegistry(adapter);
    case "live":
      return createLiveRegistry(adapter, env, false);
    case "auto":
      return createLiveRegistry(adapter, env, true);
    default:
      throw new UnsupportedProviderModeError(providerMode);
  }
}
