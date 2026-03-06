import { CodexAppServerClient, CodexAppServerTurnError } from "./codex-app-server";
import {
  ProviderAuthFailedError,
  ProviderError,
  ProviderRateLimitedError,
  ProviderRequestFailedError,
  ProviderResponseMalformedError,
  ProviderTimeoutError
} from "../errors";
import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "../provider-client";

export interface OpenAIChatGptOAuthProviderClientOptions {
  env?: Record<string, string | undefined>;
  appServerClient?: CodexAppServerClient;
}

function normalizeSystemInstruction(request: ProviderGenerateRequest): string | undefined {
  const explicit = request.systemPrompt?.trim();
  if (explicit) {
    return explicit;
  }

  const providerOptionsSystemPrompt = request.agent.llm?.providerOptions?.systemPrompt;
  if (typeof providerOptionsSystemPrompt === "string" && providerOptionsSystemPrompt.trim()) {
    return providerOptionsSystemPrompt.trim();
  }

  return undefined;
}

export class OpenAIChatGptOAuthProviderClient implements ProviderClient {
  readonly id = "openai" as const;

  private readonly env: Record<string, string | undefined>;
  private client?: CodexAppServerClient;

  constructor(options: OpenAIChatGptOAuthProviderClientOptions = {}) {
    this.env = options.env ?? (process.env as Record<string, string | undefined>);
    this.client = options.appServerClient;
  }

  private getClient(): CodexAppServerClient {
    if (this.client) {
      return this.client;
    }

    this.client = new CodexAppServerClient({
      env: this.env
    });
    return this.client;
  }

  private mapRuntimeError(error: unknown, timeoutMs?: number): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }

    if (error instanceof CodexAppServerTurnError) {
      const turnMessage = error.message.toLowerCase();
      const codexErrorInfo = error.codexErrorInfo?.toLowerCase();

      if (
        turnMessage.includes("unauthorized") ||
        turnMessage.includes("auth_required") ||
        codexErrorInfo === "unauthorized"
      ) {
        return new ProviderAuthFailedError(this.id, undefined, error);
      }

      if (
        turnMessage.includes("rate limit") ||
        turnMessage.includes("usage limit") ||
        codexErrorInfo === "usagelimitexceeded"
      ) {
        return new ProviderRateLimitedError(this.id, undefined, error);
      }

      return new ProviderRequestFailedError(this.id, error.message, error);
    }

    const message = error instanceof Error ? error.message : "Unknown Codex app-server failure.";
    const lowered = message.toLowerCase();

    if (lowered.includes("timed out")) {
      return new ProviderTimeoutError(this.id, timeoutMs, error);
    }

    if (
      lowered.includes("auth_required") ||
      lowered.includes("rejected authentication") ||
      lowered.includes("login failed") ||
      lowered.includes("requiresopenaiauth")
    ) {
      return new ProviderAuthFailedError(this.id, undefined, error);
    }

    return new ProviderRequestFailedError(this.id, message, error);
  }

  async generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    const model = request.agent.llm?.model?.trim();
    if (!model) {
      throw new ProviderRequestFailedError(this.id, "Missing required agent.llm.model.");
    }

    const timeoutMs =
      typeof request.agent.llm?.timeoutMs === "number" && request.agent.llm.timeoutMs > 0
        ? request.agent.llm.timeoutMs
        : undefined;
    const systemInstruction = normalizeSystemInstruction(request);
    const startedAt = performance.now();

    try {
      const response = await this.getClient().runTextTurn({
        model,
        prompt: request.prompt,
        developerInstructions: systemInstruction,
        timeoutMs
      });

      if (!response.content.trim()) {
        throw new ProviderResponseMalformedError(
          this.id,
          "Codex app-server turn completed without textual content.",
          response.raw
        );
      }

      return {
        content: response.content,
        provider: this.id,
        model: response.model,
        invocationId: response.turnId,
        usage: {
          latencyMs: Math.round(performance.now() - startedAt)
        },
        raw: response.raw
      };
    } catch (error) {
      throw this.mapRuntimeError(error, timeoutMs);
    }
  }
}
