import { describe, expect, test } from "bun:test";

import { OpenAIProviderClient } from "../../src/providers/clients/openai";
import type { Agent } from "../../src/types";

const shouldRunLiveTest =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1" &&
  typeof process.env.OPENAI_API_KEY === "string" &&
  process.env.OPENAI_API_KEY.trim().length > 0;

const runOrSkip = shouldRunLiveTest ? test : test.skip;

describe("integration/provider-openai-live", () => {
  runOrSkip("generates content with real OpenAI API when explicitly enabled", async () => {
    const apiKey = process.env.OPENAI_API_KEY as string;
    const provider = new OpenAIProviderClient({ apiKey });

    const agent: Agent = {
      id: "live-openai-agent",
      name: "Live OpenAI Agent",
      role: "analyst",
      persona: "Concise",
      systemPrompt: "Be concise and factual.",
      llm: {
        provider: "openai",
        model: "gpt-4.1-mini",
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
      expect(result.content.trim().length).toBeGreaterThan(0);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      expect(errorMessage).not.toContain(apiKey);
      throw error;
    }
  });
});
