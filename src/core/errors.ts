import { AdapterLoadError } from "../adapters/adapter-loader";
import {
  DuplicateProviderError,
  MissingAgentProviderError,
  ProviderRegistryError,
  UnknownProviderError
} from "../providers/provider-registry";
import {
  TranscriptAlreadyFinalizedError,
  TranscriptNotRunningError,
  TranscriptRunMismatchError,
  TranscriptStoreError
} from "../transcript/transcript-store";

export type OrchestratorErrorSource = "adapter" | "provider" | "transcript" | "runtime";

export class OrchestratorError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OrchestratorError";
    this.cause = cause;
  }
}

export class OrchestratorIntegrationError extends OrchestratorError {
  readonly source: OrchestratorErrorSource;
  readonly code: string;

  constructor(source: OrchestratorErrorSource, code: string, message: string, cause?: unknown) {
    super(message, cause);
    this.name = "OrchestratorIntegrationError";
    this.source = source;
    this.code = code;
  }
}

export class OrchestratorConfigError extends OrchestratorError {
  readonly code: string;

  constructor(message: string, code = "INVALID_ORCHESTRATOR_CONFIG", cause?: unknown) {
    super(message, cause);
    this.name = "OrchestratorConfigError";
    this.code = code;
  }
}

export function normalizeOrchestratorError(error: unknown): OrchestratorError {
  if (error instanceof OrchestratorError) {
    return error;
  }

  if (error instanceof AdapterLoadError) {
    return new OrchestratorIntegrationError(
      "adapter",
      `ADAPTER_${error.code}`,
      error.message,
      error
    );
  }

  if (error instanceof ProviderRegistryError) {
    if (error instanceof UnknownProviderError) {
      return new OrchestratorIntegrationError(
        "provider",
        "PROVIDER_UNKNOWN_PROVIDER",
        error.message,
        error
      );
    }

    if (error instanceof MissingAgentProviderError) {
      return new OrchestratorIntegrationError(
        "provider",
        "PROVIDER_MISSING_AGENT_PROVIDER",
        error.message,
        error
      );
    }

    if (error instanceof DuplicateProviderError) {
      return new OrchestratorIntegrationError(
        "provider",
        "PROVIDER_DUPLICATE_PROVIDER",
        error.message,
        error
      );
    }

    return new OrchestratorIntegrationError(
      "provider",
      "PROVIDER_REGISTRY_ERROR",
      error.message,
      error
    );
  }

  if (error instanceof TranscriptStoreError) {
    if (error instanceof TranscriptRunMismatchError) {
      return new OrchestratorIntegrationError(
        "transcript",
        "TRANSCRIPT_RUN_MISMATCH",
        error.message,
        error
      );
    }

    if (error instanceof TranscriptNotRunningError) {
      return new OrchestratorIntegrationError(
        "transcript",
        "TRANSCRIPT_NOT_RUNNING",
        error.message,
        error
      );
    }

    if (error instanceof TranscriptAlreadyFinalizedError) {
      return new OrchestratorIntegrationError(
        "transcript",
        "TRANSCRIPT_ALREADY_FINALIZED",
        error.message,
        error
      );
    }

    return new OrchestratorIntegrationError(
      "transcript",
      "TRANSCRIPT_STORE_ERROR",
      error.message,
      error
    );
  }

  if (error instanceof Error) {
    return new OrchestratorIntegrationError("runtime", "RUNTIME_UNEXPECTED_ERROR", error.message, error);
  }

  return new OrchestratorIntegrationError(
    "runtime",
    "RUNTIME_UNKNOWN_THROWABLE",
    "Unknown non-error throwable encountered.",
    error
  );
}
