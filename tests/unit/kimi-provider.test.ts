import { describe, expect, test } from "bun:test";

import { DEFAULT_KIMI_BASE_URL, KimiProviderClient } from "../../src/providers/clients/kimi";
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
  provider: "kimi",
  model: "moonshot-v1-8k",
  temperature: 0.4,
  topP: 0.85,
  maxTokens: 192
} satisfies NonNullable<Agent["llm"]>;

const baseAgent: Agent = {
  id: "agent-kimi-1",
  name: "Kimi Agent",
  role: "critic",
  persona: "Direct and analytical",
  systemPrompt: "Keep answers concrete.",
  llm: baseLlmConfig
};

function buildRequest(overrides: Partial<ProviderGenerateRequest> = {}): ProviderGenerateRequest {
  return {
    runId: "run-kimi-1",
    agent: baseAgent,
    systemPrompt: "Explicit system prompt",
    prompt: "Evaluate this argument.",
    transcript: [],
    ...overrides
  };
}

describe("KimiProviderClient", () => {
  test("uses default base URL when no override is provided", () => {
    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async () => ({ choices: [{ message: { content: "ok" } }] })
          }
        }
      }
    });

    expect(provider.baseURL).toBe(DEFAULT_KIMI_BASE_URL);
  });

  test("supports explicit base URL override", () => {
    const provider = new KimiProviderClient({
      apiKey: "test-key",
      baseURL: "https://custom.moonshot.test/v1",
      client: {
        chat: {
          completions: {
            create: async () => ({ choices: [{ message: { content: "ok" } }] })
          }
        }
      }
    });

    expect(provider.baseURL).toBe("https://custom.moonshot.test/v1");
  });

  test("maps model, system prompt, prompt, params, usage, invocationId, and raw payload", async () => {
    let capturedBody:
      | {
          model: string;
          messages: Array<{ role: "system" | "user"; content: string }>;
          temperature?: number;
          top_p?: number;
          max_tokens?: number;
        }
      | undefined;
    const sdkResponse = {
      id: "chatcmpl-kimi-1",
      model: "moonshot-v1-8k",
      choices: [{ message: { content: "Mapped response text" } }],
      usage: { prompt_tokens: 17, completion_tokens: 11 }
    };

    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async (body) => {
              capturedBody = body;
              return sdkResponse;
            }
          }
        }
      }
    });

    const result = await provider.generate(buildRequest());

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.model).toBe("moonshot-v1-8k");
    expect(capturedBody?.messages).toEqual([
      { role: "system", content: "Explicit system prompt" },
      { role: "user", content: "Evaluate this argument." }
    ]);
    expect(capturedBody?.temperature).toBe(0.4);
    expect(capturedBody?.top_p).toBe(0.85);
    expect(capturedBody?.max_tokens).toBe(192);
    expect(result.content).toBe("Mapped response text");
    expect(result.provider).toBe("kimi");
    expect(result.model).toBe("moonshot-v1-8k");
    expect(result.invocationId).toBe("chatcmpl-kimi-1");
    expect(result.usage?.inputTokens).toBe(17);
    expect(result.usage?.outputTokens).toBe(11);
    expect(result.usage?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.raw).toEqual(sdkResponse);
  });

  test("uses providerOptions.systemPrompt when request.systemPrompt is missing", async () => {
    let capturedSystemPrompt: string | undefined;
    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async (body) => {
              capturedSystemPrompt = body.messages[0]?.content;
              return { choices: [{ message: { content: "ok" } }] };
            }
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

    expect(capturedSystemPrompt).toBe("Provider options system prompt");
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

    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
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
    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async () => {
              throw { status: 401 };
            }
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(ProviderAuthFailedError);
  });

  test("maps rate limit errors (429) to PROVIDER_RATE_LIMITED and preserves retry-after", async () => {
    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async () => {
              throw { status: 429, headers: { "retry-after": "60" } };
            }
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
      expect(typedError.retryAfter).toBe("60");
    }
  });

  test("maps malformed responses to PROVIDER_RESPONSE_MALFORMED", async () => {
    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async () => {
              return {
                choices: [{ message: { content: "" } }]
              };
            }
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(
      ProviderResponseMalformedError
    );
  });

  test("maps unknown failures to PROVIDER_REQUEST_FAILED", async () => {
    const provider = new KimiProviderClient({
      apiKey: "test-key",
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error("Socket closed");
            }
          }
        }
      }
    });

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(ProviderRequestFailedError);
  });

  test("throws credentials missing when api key is absent and no client is injected", async () => {
    const provider = new KimiProviderClient();

    await expect(provider.generate(buildRequest())).rejects.toBeInstanceOf(
      ProviderCredentialsMissingError
    );
  });
});
