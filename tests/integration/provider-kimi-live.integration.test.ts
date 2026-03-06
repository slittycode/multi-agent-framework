import { describe, expect, test } from "bun:test";

import { KimiProviderClient } from "../../src/providers/clients/kimi";
import type { Agent } from "../../src/types";

const shouldRunLiveTest =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1" &&
  typeof process.env.KIMI_API_KEY === "string" &&
  process.env.KIMI_API_KEY.trim().length > 0;

const runOrSkip = shouldRunLiveTest ? test : test.skip;

describe("integration/provider-kimi-live", () => {
  runOrSkip(
    "generates content with real Kimi API when explicitly enabled",
    async () => {
    const apiKey = process.env.KIMI_API_KEY as string;
    const provider = new KimiProviderClient({
      apiKey,
      baseURL: process.env.KIMI_BASE_URL
    });

    const agent: Agent = {
      id: "live-kimi-agent",
      name: "Live Kimi Agent",
      role: "analyst",
      persona: "Concise",
      systemPrompt: "Be concise and factual.",
      llm: {
        provider: "kimi",
        model: "moonshot-v1-8k",
        temperature: 0.2
      }
    };

    try {
      const result = await provider.generate({
        runId: "run-live-kimi-1",
        agent,
        systemPrompt: agent.systemPrompt,
        prompt: "Reply with one short sentence about collaborative debate quality.",
        transcript: []
      });

      expect(result.provider).toBe("kimi");
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
