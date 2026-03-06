import { describe, expect, test } from "bun:test";

import {
  createProviderRegistryForRun,
  describeProviderSupport,
  getAdapterProviderCapabilities,
  type ProviderMode
} from "../../src/providers/provider-bootstrap";
import {
  ProviderCredentialsMissingError,
  ProviderUnsupportedIdError
} from "../../src/providers/errors";
import type { DomainAdapter, ProviderId } from "../../src/types";

function createAdapter(providerIds: ProviderId[]): DomainAdapter {
  return {
    id: `adapter-${providerIds.join("-")}`,
    name: "Provider Bootstrap Test Adapter",
    version: "1.0.0",
    synthesisAgentId: "synth",
    agents: providerIds.map((providerId, index) => ({
      id: index === providerIds.length - 1 ? "synth" : `speaker-${index + 1}`,
      name: index === providerIds.length - 1 ? "Synth" : `Speaker ${index + 1}`,
      role: index === providerIds.length - 1 ? "synth" : "speaker",
      persona: "Direct",
      systemPrompt: "Respond clearly.",
      llm: {
        provider: providerId,
        model: `${providerId}-model-v1`
      }
    })),
    rounds: [
      {
        id: "round-1",
        name: "Round One",
        phases: [
          {
            id: "opening",
            name: "Opening",
            instructions: "Open",
            turnOrder: providerIds.map((_, index) =>
              index === providerIds.length - 1 ? "synth" : `speaker-${index + 1}`
            )
          }
        ]
      }
    ]
  };
}

function expectProviderBootstrapError(
  mode: ProviderMode,
  providerId: ProviderId,
  env: Record<string, string | undefined>
): Error {
  try {
    createProviderRegistryForRun({
      adapter: createAdapter([providerId]),
      providerMode: mode,
      env
    });
  } catch (error) {
    return error as Error;
  }

  throw new Error("Expected provider bootstrap to throw.");
}

describe("provider-bootstrap", () => {
  test("mock mode registers one MockProvider per unique adapter provider id", () => {
    const adapter = createAdapter(["gemini", "gemini", "kimi"]);

    const registry = createProviderRegistryForRun({
      adapter,
      providerMode: "mock",
      env: {}
    });

    expect(registry.list().sort()).toEqual(["gemini", "kimi"]);
    expect(registry.get("gemini").id).toBe("gemini");
    expect(registry.get("kimi").id).toBe("kimi");
  });

  test("describeProviderSupport reports recognized but unsupported live providers", () => {
    expect(describeProviderSupport("gemini")).toMatchObject({
      providerId: "gemini",
      recognized: true,
      liveCapable: true,
      requiredEnv: ["GEMINI_API_KEY"]
    });

    expect(describeProviderSupport("openai")).toMatchObject({
      providerId: "openai",
      recognized: true,
      liveCapable: false,
      requiredEnv: ["OPENAI_API_KEY"]
    });

    expect(describeProviderSupport("unknown-provider")).toMatchObject({
      providerId: "unknown-provider",
      recognized: false,
      liveCapable: false,
      requiredEnv: []
    });
  });

  test("getAdapterProviderCapabilities deduplicates adapter providers", () => {
    const capabilities = getAdapterProviderCapabilities(createAdapter(["gemini", "openai", "gemini"]));

    expect(capabilities).toHaveLength(2);
    expect(capabilities.map((capability) => capability.providerId).sort()).toEqual([
      "gemini",
      "openai"
    ]);
    expect(capabilities.find((capability) => capability.providerId === "openai")).toMatchObject({
      liveCapable: false
    });
  });

  test("live mode fails with missing credentials for known provider", () => {
    const error = expectProviderBootstrapError("live", "gemini", {});
    expect(error).toBeInstanceOf(ProviderCredentialsMissingError);
    expect(error.message).toContain("PROVIDER_CREDENTIALS_MISSING");
    expect(error.message).toContain("GEMINI_API_KEY");
  });

  test("live mode registers gemini when credentials are present", () => {
    const registry = createProviderRegistryForRun({
      adapter: createAdapter(["gemini"]),
      providerMode: "live",
      env: { GEMINI_API_KEY: "test-key" }
    });

    expect(registry.list()).toEqual(["gemini"]);
    expect(registry.get("gemini").id).toBe("gemini");
  });

  test("live mode registers kimi when credentials are present", () => {
    const registry = createProviderRegistryForRun({
      adapter: createAdapter(["kimi"]),
      providerMode: "live",
      env: { KIMI_API_KEY: "test-key" }
    });

    expect(registry.list()).toEqual(["kimi"]);
    expect(registry.get("kimi").id).toBe("kimi");
  });

  test("auto mode keeps explicit mock providers registered", () => {
    const registry = createProviderRegistryForRun({
      adapter: createAdapter(["mock"]),
      providerMode: "auto",
      env: {}
    });

    expect(registry.list()).toEqual(["mock"]);
    expect(registry.get("mock").id).toBe("mock");
  });

  test("auto mode fails with missing credentials for known live provider", () => {
    const error = expectProviderBootstrapError("auto", "gemini", {});
    expect(error).toBeInstanceOf(ProviderCredentialsMissingError);
    expect(error.message).toContain("PROVIDER_CREDENTIALS_MISSING");
  });

  test("auto mode registers gemini when credentials are present", () => {
    const registry = createProviderRegistryForRun({
      adapter: createAdapter(["gemini"]),
      providerMode: "auto",
      env: { GEMINI_API_KEY: "test-key" }
    });

    expect(registry.list()).toEqual(["gemini"]);
    expect(registry.get("gemini").id).toBe("gemini");
  });

  test("auto mode registers kimi when credentials are present", () => {
    const registry = createProviderRegistryForRun({
      adapter: createAdapter(["kimi"]),
      providerMode: "auto",
      env: { KIMI_API_KEY: "test-key" }
    });

    expect(registry.list()).toEqual(["kimi"]);
    expect(registry.get("kimi").id).toBe("kimi");
  });

  test("live mode fails when provider is not implemented after credentials are supplied", () => {
    const error = expectProviderBootstrapError("live", "openai", { OPENAI_API_KEY: "test-key" });
    expect(error.message).toContain("PROVIDER_NOT_IMPLEMENTED");
  });

  test("auto mode fails when provider is not implemented after credentials are supplied", () => {
    const error = expectProviderBootstrapError("auto", "openai", { OPENAI_API_KEY: "test-key" });
    expect(error.message).toContain("PROVIDER_NOT_IMPLEMENTED");
  });

  test("live mode rejects unsupported provider ids", () => {
    const error = expectProviderBootstrapError("live", "unknown-provider", {});
    expect(error).toBeInstanceOf(ProviderUnsupportedIdError);
    expect(error.message).toContain("PROVIDER_UNSUPPORTED_ID");
  });
});
