import type { ProviderId } from "../types/provider";

export interface ProviderSupportDescriptor {
  providerId: ProviderId;
  recognized: boolean;
  liveCapable: boolean;
  requiredEnv: string[];
  declaredAuthMethods: string[];
  supportedAuthMethods: string[];
  credentialSources: string[];
  defaultModel?: string;
  providerNote?: string;
}

interface ProviderSupportDefinition {
  recognized: boolean;
  liveCapable: boolean;
  requiredEnv: string[];
  declaredAuthMethods: string[];
  supportedAuthMethods: string[];
  credentialSources: string[];
  defaultModel?: string;
  providerNote?: string;
}

const PROVIDER_SUPPORT_BY_ID: Record<string, ProviderSupportDefinition> = {
  mock: {
    recognized: true,
    liveCapable: false,
    requiredEnv: [],
    declaredAuthMethods: [],
    supportedAuthMethods: [],
    credentialSources: []
  },
  gemini: {
    recognized: true,
    liveCapable: true,
    requiredEnv: ["GEMINI_API_KEY"],
    declaredAuthMethods: ["api-key"],
    supportedAuthMethods: ["api-key"],
    credentialSources: ["env", "keychain"],
    defaultModel: "gemini-2.5-flash"
  },
  kimi: {
    recognized: true,
    liveCapable: true,
    requiredEnv: ["KIMI_API_KEY"],
    declaredAuthMethods: ["api-key"],
    supportedAuthMethods: ["api-key"],
    credentialSources: ["env", "keychain"],
    defaultModel: "moonshot-v1-8k",
    providerNote:
      "Implemented but uncertified: requires a valid Moonshot platform API key from platform.moonshot.cn (separate from Kimi CLI credentials)."
  },
  openai: {
    recognized: true,
    liveCapable: true,
    requiredEnv: ["OPENAI_API_KEY"],
    declaredAuthMethods: ["api-key", "chatgpt-oauth"],
    supportedAuthMethods: ["api-key", "chatgpt-oauth"],
    credentialSources: ["env", "keychain", "codex-app-server"],
    defaultModel: "gpt-4.1-mini"
  },
  claude: {
    // Intentionally unsupported: many users only have claude.ai subscription access,
    // while live framework execution would require a separate Anthropic API key and billing path.
    recognized: true,
    liveCapable: false,
    requiredEnv: ["ANTHROPIC_API_KEY"],
    declaredAuthMethods: ["api-key"],
    supportedAuthMethods: ["api-key"],
    credentialSources: ["env", "keychain"],
    providerNote:
      "Intentionally unsupported for live execution: claude.ai subscription access does not include Anthropic API billing, and requiring a separate API key would create a second billing path."
  }
};

export function describeProviderSupport(providerId: ProviderId): ProviderSupportDescriptor {
  const definition = PROVIDER_SUPPORT_BY_ID[providerId];

  if (!definition) {
    return {
      providerId,
      recognized: false,
      liveCapable: false,
      requiredEnv: [],
      declaredAuthMethods: [],
      supportedAuthMethods: [],
      credentialSources: []
    };
  }

  return {
    providerId,
    recognized: definition.recognized,
    liveCapable: definition.liveCapable,
    requiredEnv: [...definition.requiredEnv],
    declaredAuthMethods: [...definition.declaredAuthMethods],
    supportedAuthMethods: [...definition.supportedAuthMethods],
    credentialSources: [...definition.credentialSources],
    ...(definition.defaultModel ? { defaultModel: definition.defaultModel } : {}),
    ...(definition.providerNote ? { providerNote: definition.providerNote } : {})
  };
}

export function isProviderImplemented(providerId: ProviderId): boolean {
  return describeProviderSupport(providerId).liveCapable;
}

export function getDefaultModelForProvider(providerId: ProviderId): string | undefined {
  return describeProviderSupport(providerId).defaultModel;
}

export function listLiveCapableProviderIds(): ProviderId[] {
  return Object.entries(PROVIDER_SUPPORT_BY_ID)
    .filter(([, definition]) => definition.liveCapable)
    .map(([providerId]) => providerId);
}
