import { describe, expect, test } from "bun:test";

import { CodexAppServerClient } from "../../src/providers/clients/codex-app-server";
import { OpenAIChatGptOAuthProviderClient } from "../../src/providers/clients/openai-chatgpt-oauth";
import type { Agent } from "../../src/types";

const shouldRunLiveTest = process.env.RUN_LIVE_PROVIDER_TESTS === "1";

const runOrSkip = shouldRunLiveTest ? test : test.skip;

describe("integration/provider-openai-live", () => {
  runOrSkip(
    "generates content with real OpenAI ChatGPT OAuth when explicitly enabled",
    async () => {
    const env = {
      ...(process.env as Record<string, string | undefined>),
      MAF_DISABLE_BROWSER_OPEN: "1"
    };
    const appServerClient = new CodexAppServerClient({ env });
    const defaultModel = await appServerClient.getDefaultModel();
    const provider = new OpenAIChatGptOAuthProviderClient({
      env,
      appServerClient
    });

    const agent: Agent = {
      id: "live-openai-agent",
      name: "Live OpenAI Agent",
      role: "analyst",
      persona: "Concise",
      systemPrompt: "Be concise and factual.",
      llm: {
        provider: "openai",
        model: defaultModel.model,
        temperature: 0.2
      }
    };

    try {
      const result = await provider.generate({
        runId: "run-live-openai-1",
        agent,
        systemPrompt: agent.systemPrompt,
        prompt: "Reply with one short sentence about collaborative debate quality.",
        transcript: []
      });

      expect(result.provider).toBe("openai");
      expect(result.model).toBe(defaultModel.model);
      expect(result.content.trim().length).toBeGreaterThan(0);
    } catch (error) {
      throw error;
    } finally {
      await appServerClient.disconnect();
    }
    },
    30_000
  );
});
