import { describe, expect, test } from "bun:test";

import type { CodexAppServerClient } from "../../src/providers/clients/codex-app-server";
import { CodexAppServerTurnError } from "../../src/providers/clients/codex-app-server";
import { OpenAIChatGptOAuthProviderClient } from "../../src/providers/clients/openai-chatgpt-oauth";
import type { Agent } from "../../src/types";

const agent: Agent = {
  id: "openai-oauth-agent",
  name: "OpenAI OAuth Agent",
  role: "analyst",
  persona: "Concise",
  systemPrompt: "Be concise and factual.",
  llm: {
    provider: "openai",
    model: "gpt-5.3-codex",
    temperature: 0.2
  }
};

describe("OpenAIChatGptOAuthProviderClient", () => {
  test("maps AUTH_REQUIRED failures to PROVIDER_AUTH_FAILED", async () => {
    const provider = new OpenAIChatGptOAuthProviderClient({
      appServerClient: {
        runTextTurn: async () => {
          throw new Error("AUTH_REQUIRED");
        }
      } as unknown as CodexAppServerClient
    });

    await expect(
      provider.generate({
        runId: "run-1",
        agent,
        systemPrompt: agent.systemPrompt,
        prompt: "Reply in one short sentence.",
        transcript: []
      })
    ).rejects.toMatchObject({
      code: "PROVIDER_AUTH_FAILED"
    });
  });

  test("maps failed Codex turns to PROVIDER_REQUEST_FAILED without reporting a timeout", async () => {
    const provider = new OpenAIChatGptOAuthProviderClient({
      appServerClient: {
        runTextTurn: async () => {
          throw new CodexAppServerTurnError({
            message: "The 'gpt-5.3-codex' model is temporarily unavailable.",
            turnId: "turn-123",
            codexErrorInfo: "other"
          });
        }
      } as unknown as CodexAppServerClient
    });

    await expect(
      provider.generate({
        runId: "run-2",
        agent,
        systemPrompt: agent.systemPrompt,
        prompt: "Reply in one short sentence.",
        transcript: []
      })
    ).rejects.toMatchObject({
      code: "PROVIDER_REQUEST_FAILED"
    });
  });
});
