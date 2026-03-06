import { describe, expect, test } from "bun:test";

import { GeminiProviderClient } from "../../src/providers/clients/gemini";
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
  provider: "gemini",
  model: "gemini-2.5-flash",
  temperature: 0.4,
  topP: 0.9,
  maxTokens: 256
} satisfies NonNullable<Agent["llm"]>;

const baseAgent: Agent = {
  id: "agent-1",
  name: "Gemini Agent",
  role: "critic",
  persona: "Direct and analytical",
  systemPrompt: "Keep answers concrete.",
  llm: baseLlmConfig
};

function buildRequest(overrides: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    runId: "run-gemini-1",
    agent: baseAgent,
    systemPrompt: "Explicit system prompt",
    prompt: "Evaluate this argument.",
    transcript: [],
    ...overrides
  };
}

describe("GeminiProviderClient", () => {
  test("maps model, system prompt, prompt, generation params, usage, invocationId, and raw payload", async () => {
    let capturedInput:
      | {
          model: string;
          contents: string;
          config?: {
            systemInstruction?: string;
            temperature?: number;
            topP?: number;
            maxOutputTokens?: number;
            abortSignal?: AbortSignal;
          };
        }
      | undefined;
    const sdkResponse = {
      text: "Mapped response text",
      modelVersion: "gemini-2.5-flash-001",
      responseId: "resp-123",
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 9
      }
    };

    const provider = new GeminiProviderClient({
      apiKey: "test-key",
      client: {
        models: {
          generateContent: async (input) => {
            capturedInput = input;
            return sdkResponse;
          }
        }
      }
    });

    const result = await provider.generate(buildRequest());

    expect(capturedInput).toBeDefined();
    expect(capturedInput?.model).toBe("gemini-2.5-flash");
    expect(capturedInput?.contents).toBe("Evaluate this argument.");
    expect(capturedInput?.config?.systemInstruction).toBe("Explicit system prompt");
    expect(capturedInput?.config?.temperature).toBe(0.4);
    expect(capturedInput?.config?.topP).toBe(0.9);
    expect(capturedInput?.config?.maxOutputTokens).toBe(256);
    expect(result.content).toBe("Mapped response text");
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-2.5-flash-001");
    expect(result.invocationId).toBe("resp-123");
    expect(result.usage?.inputTokens).toBe(12);
    expect(result.usage?.outputTokens).toBe(9);
    expect(result.usage?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.raw).toEqual(sdkResponse);
  });

  test("uses providerOptions.systemPrompt when request.systemPrompt is missing", async () => {
    let capturedSystemInstruction: string | undefined;

    const provider = new GeminiProviderClient({
      apiKey: "test-key",
      client: {
        models: {
          generateContent: async (input) => {
            capturedSystemInstruction = input.config?.systemInstruction;
            return { text: "OK" };
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

    expect(capturedSystemInstruction).toBe("Provider options system prompt");
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

    const provider = new GeminiProviderClient({
      apiKey: "test-key",
      client: {
        models: {
          generateContent: async (input) => {
            const signal = input.config?.abortSignal;
            if (!signal) {
              throw new Error("Expected abortSignal to be set.");
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
    const provider = new GeminiProviderClient({
      apiKey: "test-key",
      client: {
        models: {
          generateContent: async () => {
            throw { status: 401 };
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(ProviderAuthFailedError);
  });

  test("maps rate limit errors (429) to PROVIDER_RATE_LIMITED and preserves retry-after", async () => {
    const provider = new GeminiProviderClient({
      apiKey: "test-key",
      client: {
        models: {
          generateContent: async () => {
            throw { status: 429, headers: { "retry-after": "42" } };
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
      expect(typedError.retryAfter).toBe("42");
    }
  });

  test("maps empty/malformed responses to PROVIDER_RESPONSE_MALFORMED", async () => {
    const provider = new GeminiProviderClient({
      apiKey: "test-key",
      client: {
        models: {
          generateContent: async () => {
            return {
              text: "   ",
              candidates: []
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
    const provider = new GeminiProviderClient({
      apiKey: "test-key",
      client: {
        models: {
          generateContent: async () => {
            throw new Error("Socket closed");
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(ProviderRequestFailedError);
  });

  test("throws credentials missing when api key is absent and no client is injected", async () => {
    const provider = new GeminiProviderClient();

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(
      ProviderCredentialsMissingError
    );
  });
});
