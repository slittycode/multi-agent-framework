import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadDomainAdapter } from "../../src/adapters/adapter-loader";
import { runDiscussion } from "../../src/core/orchestrator";
import { MockProvider } from "../../src/providers/mock-provider";
import { ProviderRegistry } from "../../src/providers/provider-registry";

const shouldRunBenchmark = process.env.RUN_BENCHMARK_TESTS === "1";
const runOrSkip = shouldRunBenchmark ? test : test.skip;

const BASELINE_INPUT_TOKENS = 15357;
const TARGET_INPUT_TOKENS = 11518;
const QUALITY_THRESHOLD = 75;
const BUILTIN_ADAPTER_IDS = ["general-debate", "creative-writing", "ableton-feedback"] as const;
type BuiltinAdapterId = (typeof BUILTIN_ADAPTER_IDS)[number];
const BENCHMARK_TOPICS_BY_ADAPTER: Record<BuiltinAdapterId, readonly string[]> = {
  "general-debate": [
    "Is remote work better than office work?",
    "How should teams balance experimentation and reliability?",
    "What makes creative feedback actionable?"
  ],
  "creative-writing": [
    "Write a story about an AI that becomes self-aware",
    "What makes a villain more compelling than the hero?",
    "How does setting shape character in fiction?"
  ],
  "ableton-feedback": [
    "How should a producer approach mixing a dense arrangement?",
    "What is the role of silence and space in electronic music?",
    "How do you decide when a track is finished?"
  ]
} as const;

describe("integration/v02-benchmark", () => {
  runOrSkip("replays built-ins and exports benchmark report", async () => {
    const reportEntries: Array<{
      adapterId: string;
      topic: string;
      inputTokens: number;
      outputTokens: number;
      qualityScore: number;
      qualityPassed: boolean;
    }> = [];

    for (const adapterId of BUILTIN_ADAPTER_IDS) {
      const adapter = await loadDomainAdapter(adapterId);
      const adapterTopics = BENCHMARK_TOPICS_BY_ADAPTER[adapterId];
      for (const topic of adapterTopics) {
        const result = await runDiscussion({
          adapter,
          topic,
          providerRegistry: new ProviderRegistry([new MockProvider({ id: "gemini" })]),
          config: {
            transcript: {
              persistToFile: false,
              outputDir: "./runs",
              format: "json"
            }
          }
        });

        const inputTokens = result.context.transcript.messages.reduce(
          (total, message) => total + (message.usage?.inputTokens ?? 0),
          0
        );
        const outputTokens = result.context.transcript.messages.reduce(
          (total, message) => total + (message.usage?.outputTokens ?? 0),
          0
        );
        const qualityGate = (result.context.transcript.metadata as { qualityGate?: unknown } | undefined)
          ?.qualityGate as { score?: number; passed?: boolean } | undefined;

        reportEntries.push({
          adapterId,
          topic,
          inputTokens,
          outputTokens,
          qualityScore: qualityGate?.score ?? 0,
          qualityPassed: Boolean(qualityGate?.passed)
        });
      }
    }

    const meanInputTokens =
      reportEntries.reduce((total, entry) => total + entry.inputTokens, 0) / reportEntries.length;
    const meanQualityScore =
      reportEntries.reduce((total, entry) => total + entry.qualityScore, 0) / reportEntries.length;
    const distinctQualityScores = new Set(
      reportEntries.map((entry) => entry.qualityScore.toFixed(2))
    );

    const report = {
      generatedAt: new Date().toISOString(),
      baselineInputTokens: BASELINE_INPUT_TOKENS,
      targetInputTokens: TARGET_INPUT_TOKENS,
      qualityThreshold: QUALITY_THRESHOLD,
      meanInputTokens: Number(meanInputTokens.toFixed(2)),
      meanQualityScore: Number(meanQualityScore.toFixed(2)),
      entries: reportEntries
    };

    const outputDir = resolve(process.cwd(), "runs", "benchmarks");
    await mkdir(outputDir, { recursive: true });
    const outputPath = join(outputDir, `v02-benchmark-${Date.now()}.json`);
    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

    expect(report.meanInputTokens).toBeLessThanOrEqual(TARGET_INPUT_TOKENS);
    expect(report.meanQualityScore).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
    expect(distinctQualityScores.size).toBeGreaterThan(1);
  });
});
