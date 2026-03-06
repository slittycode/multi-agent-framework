import OpenAI from "openai";

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

interface KimiUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface KimiChoiceLike {
  message?: {
    content?: unknown;
  };
}

interface KimiChatCompletionLike {
  id?: string;
  model?: string;
  usage?: KimiUsageLike;
  choices?: KimiChoiceLike[];
}

interface KimiChatCompletionsClientLike {
  create(
    body: {
      model: string;
      messages: Array<{ role: "system" | "user"; content: string }>;
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
    },
    options?: { signal?: AbortSignal }
  ): Promise<KimiChatCompletionLike>;
}

interface KimiOpenAIClientLike {
  chat: {
    completions: KimiChatCompletionsClientLike;
  };
}

export interface KimiProviderClientOptions {
  apiKey?: string;
  baseURL?: string;
  client?: KimiOpenAIClientLike;
}

export const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";

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
  if (!isObjectLike(error)) {
    return undefined;
  }

  const status = error.status;
  if (typeof status === "number") {
    return status;
  }

  const response = error.response;
  if (isObjectLike(response) && typeof response.status === "number") {
    return response.status;
  }

  return undefined;
}

function extractRetryAfter(error: unknown): string | undefined {
  if (!isObjectLike(error)) {
    return undefined;
  }

  const fromHeaders = pickHeaderValue(error.headers, "retry-after");
  if (fromHeaders) {
    return fromHeaders;
  }

  const response = error.response;
  if (isObjectLike(response)) {
    return pickHeaderValue(response.headers, "retry-after");
  }

  return undefined;
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const lowered = error.message.toLowerCase();
  return error.name === "AbortError" || lowered.includes("abort") || lowered.includes("timeout");
}

function extractContentFromParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const part of value) {
    if (!isObjectLike(part)) {
      continue;
    }

    const textValue = part.text;
    if (typeof textValue === "string" && textValue.trim()) {
      textParts.push(textValue.trim());
      continue;
    }

    const contentValue = part.content;
    if (typeof contentValue === "string" && contentValue.trim()) {
      textParts.push(contentValue.trim());
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : undefined;
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

function extractResponseContent(response: KimiChatCompletionLike): string | undefined {
  const firstChoice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  const content = firstChoice?.message?.content;

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  return extractContentFromParts(content);
}

export class KimiProviderClient implements ProviderClient {
  readonly id = "kimi" as const;
  readonly baseURL: string;

  private readonly apiKey?: string;
  private client?: KimiOpenAIClientLike;

  constructor(options: KimiProviderClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL?.trim() || DEFAULT_KIMI_BASE_URL;
    this.client = options.client;
  }

  private getClient(): KimiOpenAIClientLike {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.apiKey?.trim();
    if (!apiKey) {
      throw new ProviderCredentialsMissingError(this.id, ["KIMI_API_KEY"]);
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: this.baseURL
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
    const timeoutMs =
      typeof llmConfig?.timeoutMs === "number" && llmConfig.timeoutMs > 0
        ? llmConfig.timeoutMs
        : undefined;
    const systemInstruction = normalizeSystemInstruction(request);
    const messages: Array<{ role: "system" | "user"; content: string }> = [];

    if (systemInstruction) {
      messages.push({
        role: "system",
        content: systemInstruction
      });
    }

    messages.push({
      role: "user",
      content: request.prompt
    });

    const body: {
      model: string;
      messages: Array<{ role: "system" | "user"; content: string }>;
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
    } = {
      model,
      messages
    };

    if (typeof llmConfig?.temperature === "number") {
      body.temperature = llmConfig.temperature;
    }

    if (typeof llmConfig?.topP === "number") {
      body.top_p = llmConfig.topP;
    }

    if (typeof llmConfig?.maxTokens === "number") {
      body.max_tokens = llmConfig.maxTokens;
    }

    const controller = timeoutMs ? new AbortController() : undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const requestOptions = controller ? { signal: controller.signal } : undefined;

    if (controller) {
      timeoutHandle = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
    }

    const startedAt = performance.now();
    try {
      const response = await this.getClient().chat.completions.create(body, requestOptions);
      const content = extractResponseContent(response);
      if (!content) {
        throw new ProviderResponseMalformedError(
          this.id,
          "No textual content found in Kimi response.",
          response
        );
      }

      const latencyMs = Math.round(performance.now() - startedAt);
      const inputTokens = response.usage?.prompt_tokens;
      const outputTokens = response.usage?.completion_tokens;

      return {
        content,
        provider: this.id,
        model: typeof response.model === "string" && response.model.trim() ? response.model : model,
        invocationId: typeof response.id === "string" && response.id.trim() ? response.id : undefined,
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
