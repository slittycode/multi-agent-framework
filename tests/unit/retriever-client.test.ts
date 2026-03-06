import { describe, expect, test } from "bun:test";

import { NoopRetriever, WebRetriever } from "../../src/retrieval/retriever-client";

describe("retriever-client", () => {
  test("NoopRetriever returns empty sources with warning", async () => {
    const retriever = new NoopRetriever();
    const result = await retriever.retrieve({
      topic: "Test topic",
      roundName: "Round One",
      phaseName: "Opening",
      agentName: "Agent",
      maxSources: 2
    });

    expect(result.sources).toEqual([]);
    expect(result.warning).toContain("transcript-only citations");
  });

  test("WebRetriever delegates to injected fetcher", async () => {
    const retriever = new WebRetriever({
      fetcher: async () => ({
        sources: [
          {
            title: "Source Title",
            url: "https://example.com/source",
            snippet: "Short snippet"
          }
        ]
      })
    });

    const result = await retriever.retrieve({
      topic: "Test topic",
      roundName: "Round One",
      phaseName: "Challenge",
      agentName: "Agent",
      maxSources: 2
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.title).toBe("Source Title");
    expect(result.warning).toBeUndefined();
  });

  test("WebRetriever without fetcher returns deterministic warning", async () => {
    const retriever = new WebRetriever();
    const result = await retriever.retrieve({
      topic: "Test topic",
      roundName: "Round One",
      phaseName: "Rebuttal",
      agentName: "Agent",
      maxSources: 2
    });

    expect(result.sources).toEqual([]);
    expect(result.warning).toContain("without an active fetcher");
  });
});
