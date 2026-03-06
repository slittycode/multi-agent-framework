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

interface OpenAIUsageLike {
  input_tokens?: number;
  output_tokens?: number;
}

interface OpenAIResponseLike {
  id?: string;
  model?: string;
  output_text?: string;
  usage?: OpenAIUsageLike;
  output?: unknown[];
}

interface OpenAIResponsesClientLike {
  create(
    body: {
      model?: string;
      instructions?: string | null;
      input?: string;
      temperature?: number | null;
      top_p?: number | null;
      max_output_tokens?: number | null;
    },
    options?: { signal?: AbortSignal }
  ): Promise<OpenAIResponseLike>;
}

interface OpenAIOpenAIClientLike {
  responses: OpenAIResponsesClientLike;
}

export interface OpenAIProviderClientOptions {
  apiKey?: string;
  client?: OpenAIOpenAIClientLike;
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

function extractOutputTextFromItems(items: unknown[]): string | undefined {
  const texts: string[] = [];

  for (const item of items) {
    if (!isObjectLike(item)) {
      continue;
    }

    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!isObjectLike(part) || part.type !== "output_text") {
        continue;
      }

      const text = part.text;
      if (typeof text === "string" && text.trim()) {
        texts.push(text.trim());
      }
    }
  }

  return texts.length > 0 ? texts.join("\n") : undefined;
}

function extractResponseText(response: OpenAIResponseLike): string | undefined {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  return Array.isArray(response.output) ? extractOutputTextFromItems(response.output) : undefined;
}

export class OpenAIProviderClient implements ProviderClient {
  readonly id = "openai" as const;

  private readonly apiKey?: string;
  private client?: OpenAIOpenAIClientLike;

  constructor(options: OpenAIProviderClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.client = options.client;
  }

  private getClient(): OpenAIOpenAIClientLike {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.apiKey?.trim();
    if (!apiKey) {
      throw new ProviderCredentialsMissingError(this.id, ["OPENAI_API_KEY"]);
    }

    this.client = new OpenAI({ apiKey });
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

    const body: {
      model?: string;
      instructions?: string | null;
      input?: string;
      temperature?: number | null;
      top_p?: number | null;
      max_output_tokens?: number | null;
    } = {
      model,
      input: request.prompt
    };

    if (systemInstruction) {
      body.instructions = systemInstruction;
    }

    if (typeof llmConfig?.temperature === "number") {
      body.temperature = llmConfig.temperature;
    }

    if (typeof llmConfig?.topP === "number") {
      body.top_p = llmConfig.topP;
    }

    if (typeof llmConfig?.maxTokens === "number") {
      body.max_output_tokens = llmConfig.maxTokens;
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
      const response = await this.getClient().responses.create(body, requestOptions);
      const content = extractResponseText(response);
      if (!content) {
        throw new ProviderResponseMalformedError(
          this.id,
          "No textual content found in OpenAI response.",
          response
        );
      }

      const latencyMs = Math.round(performance.now() - startedAt);

      return {
        content,
        provider: this.id,
        model: typeof response.model === "string" && response.model.trim() ? response.model : model,
        invocationId: typeof response.id === "string" && response.id.trim() ? response.id : undefined,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
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
