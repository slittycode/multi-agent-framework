import { ApiError, GoogleGenAI } from "@google/genai";

import {
  ProviderAuthFailedError,
  ProviderCredentialsMissingError,
  ProviderError,
  ProviderRateLimitedError,
  ProviderRequestFailedError,
  ProviderResponseMalformedError,
  ProviderTimeoutError
} from "../errors";
import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "../provider-client";

interface GeminiGenerateContentUsageMetadataLike {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

interface GeminiGenerateContentResponseLike {
  text?: string;
  modelVersion?: string;
  responseId?: string;
  usageMetadata?: GeminiGenerateContentUsageMetadataLike;
  candidates?: unknown[];
}

interface GeminiGenerateContentConfigLike {
  systemInstruction?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

interface GeminiModelsClientLike {
  generateContent(input: {
    model: string;
    contents: string;
    config?: GeminiGenerateContentConfigLike;
  }): Promise<GeminiGenerateContentResponseLike>;
}

interface GeminiClientLike {
  models: GeminiModelsClientLike;
}

export interface GeminiProviderClientOptions {
  apiKey?: string;
  client?: GeminiClientLike;
  defaultApiVersion?: string;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickHeaderValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (!isObjectLike(headers)) {
    return undefined;
  }

  const direct = headers[name];
  if (typeof direct === "string" && direct.trim()) {
    return direct;
  }

  const lowerCase = headers[name.toLowerCase()];
  if (typeof lowerCase === "string" && lowerCase.trim()) {
    return lowerCase;
  }

  return undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (error instanceof ApiError) {
    return error.status;
  }

  if (!isObjectLike(error)) {
    return undefined;
  }

  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function extractRetryAfter(error: unknown): string | undefined {
  if (!isObjectLike(error)) {
    return undefined;
  }

  return pickHeaderValue(error.headers, "retry-after");
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return error.name === "AbortError" || message.includes("abort");
}

function extractFallbackText(response: GeminiGenerateContentResponseLike): string | undefined {
  if (!Array.isArray(response.candidates)) {
    return undefined;
  }

  for (const candidate of response.candidates) {
    if (!isObjectLike(candidate)) {
      continue;
    }

    const content = candidate.content;
    if (!isObjectLike(content)) {
      continue;
    }

    const parts = content.parts;
    if (!Array.isArray(parts)) {
      continue;
    }

    const textParts: string[] = [];
    for (const part of parts) {
      if (!isObjectLike(part)) {
        continue;
      }

      const text = part.text;
      if (typeof text === "string" && text.trim()) {
        textParts.push(text.trim());
      }
    }

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return undefined;
}

function extractResponseText(response: GeminiGenerateContentResponseLike): string | undefined {
  if (typeof response.text === "string" && response.text.trim()) {
    return response.text.trim();
  }

  return extractFallbackText(response);
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

export class GeminiProviderClient implements ProviderClient {
  readonly id = "gemini" as const;

  private readonly apiKey?: string;
  private readonly defaultApiVersion?: string;
  private client?: GeminiClientLike;

  constructor(options: GeminiProviderClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.defaultApiVersion = options.defaultApiVersion;
    this.client = options.client;
  }

  private getClient(): GeminiClientLike {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.apiKey?.trim();
    if (!apiKey) {
      throw new ProviderCredentialsMissingError(this.id, ["GEMINI_API_KEY"]);
    }

    this.client = new GoogleGenAI({
      apiKey,
      ...(this.defaultApiVersion ? { apiVersion: this.defaultApiVersion } : {})
    });
    return this.client;
  }

  private mapRuntimeError(
    error: unknown,
    context: { timeoutMs?: number; aborted: boolean }
  ): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }

    if (context.aborted || isAbortLike(error)) {
      return new ProviderTimeoutError(this.id, context.timeoutMs, error);
    }

    const status = extractStatusCode(error);
    if (status === 401 || status === 403) {
      return new ProviderAuthFailedError(this.id, status, error);
    }

    if (status === 429) {
      return new ProviderRateLimitedError(this.id, extractRetryAfter(error), error);
    }

    const details = error instanceof Error ? error.message : "Unknown transport failure.";
    return new ProviderRequestFailedError(this.id, details, error);
  }

  async generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    const model = request.agent.llm?.model?.trim();
    if (!model) {
      throw new ProviderRequestFailedError(this.id, "Missing required agent.llm.model.");
    }

    const llmConfig = request.agent.llm;
    const systemInstruction = normalizeSystemInstruction(request);
    const timeoutMs =
      typeof llmConfig?.timeoutMs === "number" && llmConfig.timeoutMs > 0
        ? llmConfig.timeoutMs
        : undefined;

    const config: GeminiGenerateContentConfigLike = {};
    let hasConfig = false;

    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
      hasConfig = true;
    }

    if (typeof llmConfig?.temperature === "number") {
      config.temperature = llmConfig.temperature;
      hasConfig = true;
    }

    if (typeof llmConfig?.topP === "number") {
      config.topP = llmConfig.topP;
      hasConfig = true;
    }

    if (typeof llmConfig?.maxTokens === "number") {
      config.maxOutputTokens = llmConfig.maxTokens;
      hasConfig = true;
    }

    const controller = timeoutMs ? new AbortController() : undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (controller) {
      config.abortSignal = controller.signal;
      hasConfig = true;
      timeoutHandle = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
    }

    const startedAt = performance.now();
    try {
      const response = await this.getClient().models.generateContent({
        model,
        contents: request.prompt,
        ...(hasConfig ? { config } : {})
      });

      const content = extractResponseText(response);
      if (!content) {
        throw new ProviderResponseMalformedError(
          this.id,
          "No text content found in Gemini response.",
          response
        );
      }

      const latencyMs = Math.round(performance.now() - startedAt);
      const inputTokens = response.usageMetadata?.promptTokenCount;
      const outputTokens = response.usageMetadata?.candidatesTokenCount;

      return {
        content,
        provider: this.id,
        model:
          typeof response.modelVersion === "string" && response.modelVersion.trim()
            ? response.modelVersion
            : model,
        invocationId:
          typeof response.responseId === "string" && response.responseId.trim()
            ? response.responseId
            : undefined,
        usage: {
          inputTokens: typeof inputTokens === "number" ? inputTokens : undefined,
          outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
          latencyMs
        },
        raw: response
      };
    } catch (error) {
      throw this.mapRuntimeError(error, {
        timeoutMs,
        aborted: controller?.signal.aborted ?? false
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
