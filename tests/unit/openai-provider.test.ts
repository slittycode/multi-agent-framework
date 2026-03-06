import { describe, expect, test } from "bun:test";

import { OpenAIProviderClient } from "../../src/providers/clients/openai";
import {
  ProviderAuthFailedError,
  ProviderCredentialsMissingError,
  ProviderRateLimitedError,
  ProviderRequestFailedError,
  ProviderResponseMalformedError,
  ProviderTimeoutError
} from "../../src/providers/errors";
import type { ProviderGenerateRequest } from "../../src/providers/provider-client";
import type { Agent } from "../../src/types";

const baseLlmConfig = {
  provider: "openai",
  model: "gpt-4.1-mini",
  temperature: 0.35,
  topP: 0.8,
  maxTokens: 180
} satisfies NonNullable<Agent["llm"]>;

const baseAgent: Agent = {
  id: "agent-openai-1",
  name: "OpenAI Agent",
  role: "critic",
  persona: "Direct and analytical",
  systemPrompt: "Keep answers concrete.",
  llm: baseLlmConfig
};

function buildRequest(overrides: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    runId: "run-openai-1",
    agent: baseAgent,
    systemPrompt: "Explicit system prompt",
    prompt: "Evaluate this argument.",
    transcript: [],
    ...overrides
  };
}

describe("OpenAIProviderClient", () => {
  test("maps model, instructions, input, params, usage, invocationId, and raw payload", async () => {
    let capturedBody:
      | {
          model?: string;
          instructions?: string | null;
          input?: string;
          temperature?: number | null;
          top_p?: number | null;
          max_output_tokens?: number | null;
        }
      | undefined;
    const sdkResponse = {
      id: "resp-openai-1",
      model: "gpt-4.1-mini-2026-03-01",
      output_text: "Mapped response text",
      usage: {
        input_tokens: 13,
        output_tokens: 8,
        total_tokens: 21,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 }
      }
    };

    const provider = new OpenAIProviderClient({
      apiKey: "test-key",
      client: {
        responses: {
          create: async (body) => {
            capturedBody = body;
            return sdkResponse;
          }
        }
      }
    });

    const result = await provider.generate(buildRequest());

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.model).toBe("gpt-4.1-mini");
    expect(capturedBody?.instructions).toBe("Explicit system prompt");
    expect(capturedBody?.input).toBe("Evaluate this argument.");
    expect(capturedBody?.temperature).toBe(0.35);
    expect(capturedBody?.top_p).toBe(0.8);
    expect(capturedBody?.max_output_tokens).toBe(180);
    expect(result.content).toBe("Mapped response text");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini-2026-03-01");
    expect(result.invocationId).toBe("resp-openai-1");
    expect(result.usage?.inputTokens).toBe(13);
    expect(result.usage?.outputTokens).toBe(8);
    expect(result.usage?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.raw).toEqual(sdkResponse);
  });

  test("uses providerOptions.systemPrompt when request.systemPrompt is missing", async () => {
    let capturedInstructions: string | undefined | null;
    const provider = new OpenAIProviderClient({
      apiKey: "test-key",
      client: {
        responses: {
          create: async (body) => {
            capturedInstructions = body.instructions;
            return { output_text: "OK", usage: { input_tokens: 1, output_tokens: 1 } };
          }
        }
      }
    });

    const agentWithProviderSystemPrompt: Agent = {
      ...baseAgent,
      llm: {
        ...baseLlmConfig,
        providerOptions: {
          systemPrompt: "Provider options system prompt"
        }
      }
    };

    await provider.generate(
      buildRequest({
        agent: agentWithProviderSystemPrompt,
        systemPrompt: undefined
      })
    );

    expect(capturedInstructions).toBe("Provider options system prompt");
  });

  test("maps timeout via AbortSignal and returns PROVIDER_TIMEOUT", async () => {
    const agentWithTimeout: Agent = {
      ...baseAgent,
      llm: {
        ...baseLlmConfig,
        timeoutMs: 5
      }
    };
    let signalWasAborted = false;

    const provider = new OpenAIProviderClient({
      apiKey: "test-key",
      client: {
        responses: {
          create: async (_body, options) => {
            const signal = options?.signal;
            if (!signal) {
              throw new Error("Expected abort signal.");
            }

            return await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                signalWasAborted = signal.aborted;
                reject(new DOMException("Aborted", "AbortError"));
              });
            });
          }
        }
      }
    });

    await expect(
      provider.generate(
        buildRequest({
          agent: agentWithTimeout
        })
      )
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(signalWasAborted).toBe(true);
  });

  test("maps auth errors (401/403) to PROVIDER_AUTH_FAILED", async () => {
    const provider = new OpenAIProviderClient({
      apiKey: "test-key",
      client: {
        responses: {
          create: async () => {
            throw { status: 401 };
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(ProviderAuthFailedError);
  });

  test("maps rate limit errors (429) to PROVIDER_RATE_LIMITED and preserves retry-after", async () => {
    const provider = new OpenAIProviderClient({
      apiKey: "test-key",
      client: {
        responses: {
          create: async () => {
            throw { status: 429, headers: { "retry-after": "15" } };
          }
        }
      }
    });

    try {
      await provider.generate(buildRequest());
      throw new Error("Expected provider to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRateLimitedError);
      const typedError = error as ProviderRateLimitedError;
      expect(typedError.retryAfter).toBe("15");
    }
  });

  test("maps malformed responses to PROVIDER_RESPONSE_MALFORMED", async () => {
    const provider = new OpenAIProviderClient({
      apiKey: "test-key",
      client: {
        responses: {
          create: async () => {
            return {
              output_text: "   "
            };
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(
      ProviderResponseMalformedError
    );
  });

  test("maps unknown failures to PROVIDER_REQUEST_FAILED", async () => {
    const provider = new OpenAIProviderClient({
      apiKey: "test-key",
      client: {
        responses: {
          create: async () => {
            throw new Error("Socket closed");
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(
      ProviderRequestFailedError
    );
  });

  test("throws credentials missing when api key is absent and no client is injected", async () => {
    const provider = new OpenAIProviderClient();

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(
      ProviderCredentialsMissingError
    );
  });
});
