import { describe, expect, test } from "bun:test";

import { AdapterLoadError } from "../../src/adapters/adapter-loader";
import {
  normalizeOrchestratorError,
  OrchestratorConfigError,
  OrchestratorIntegrationError
} from "../../src/core/errors";
import { MissingAgentProviderError, UnknownProviderError } from "../../src/providers/provider-registry";
import { TranscriptRunMismatchError } from "../../src/transcript/transcript-store";

describe("core/errors", () => {
  test("maps AdapterLoadError to adapter integration error", () => {
    const normalized = normalizeOrchestratorError(
      new AdapterLoadError("FILE_NOT_FOUND", "adapter file missing")
    );

    expect(normalized).toBeInstanceOf(OrchestratorIntegrationError);
    expect((normalized as OrchestratorIntegrationError).source).toBe("adapter");
    expect((normalized as OrchestratorIntegrationError).code).toBe("ADAPTER_FILE_NOT_FOUND");
  });

  test("maps provider errors to provider integration errors", () => {
    const unknownProvider = normalizeOrchestratorError(new UnknownProviderError("x"));
    const missingProvider = normalizeOrchestratorError(new MissingAgentProviderError("agent-1"));

    expect((unknownProvider as OrchestratorIntegrationError).source).toBe("provider");
    expect((unknownProvider as OrchestratorIntegrationError).code).toBe("PROVIDER_UNKNOWN_PROVIDER");

    expect((missingProvider as OrchestratorIntegrationError).source).toBe("provider");
    expect((missingProvider as OrchestratorIntegrationError).code).toBe(
      "PROVIDER_MISSING_AGENT_PROVIDER"
    );
  });

  test("maps transcript errors to transcript integration errors", () => {
    const normalized = normalizeOrchestratorError(
      new TranscriptRunMismatchError("run-a", "run-b")
    );

    expect((normalized as OrchestratorIntegrationError).source).toBe("transcript");
    expect((normalized as OrchestratorIntegrationError).code).toBe("TRANSCRIPT_RUN_MISMATCH");
  });

  test("passes through orchestrator-native errors", () => {
    const sourceError = new OrchestratorConfigError("invalid", "INVALID");
    const normalized = normalizeOrchestratorError(sourceError);

    expect(normalized).toBe(sourceError);
  });

  test("maps generic Error to runtime integration error", () => {
    const normalized = normalizeOrchestratorError(new Error("boom"));

    expect((normalized as OrchestratorIntegrationError).source).toBe("runtime");
    expect((normalized as OrchestratorIntegrationError).code).toBe("RUNTIME_UNEXPECTED_ERROR");
  });
});
