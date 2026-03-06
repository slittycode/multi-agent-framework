import { describe, expect, test } from "bun:test";

import { GeminiProviderClient } from "../../src/providers/clients/gemini";
import type { Agent } from "../../src/types";

const shouldRunLiveTest =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1" &&
  typeof process.env.GEMINI_API_KEY === "string" &&
  process.env.GEMINI_API_KEY.trim().length > 0;

const runOrSkip = shouldRunLiveTest ? test : test.skip;

describe("integration/provider-gemini-live", () => {
  runOrSkip(
    "generates content with real Gemini API when explicitly enabled",
    async () => {
    const apiKey = process.env.GEMINI_API_KEY as string;
    const provider = new GeminiProviderClient({ apiKey });

    const agent: Agent = {
      id: "live-agent",
      name: "Live Agent",
      role: "analyst",
      persona: "Concise",
      systemPrompt: "Be concise and factual.",
      llm: {
        provider: "gemini",
        model: "gemini-2.5-flash",
        temperature: 0.2
      }
    };

    try {
      const result = await provider.generate({
        runId: "run-live-gemini-1",
        agent,
        systemPrompt: agent.systemPrompt,
        prompt: "Reply with one short sentence about collaborative debate quality.",
        transcript: []
      });

      expect(result.provider).toBe("gemini");
      expect(result.content.trim().length).toBeGreaterThan(0);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      expect(errorMessage).not.toContain(apiKey);
      throw error;
    }
    },
    30_000
  );
});
