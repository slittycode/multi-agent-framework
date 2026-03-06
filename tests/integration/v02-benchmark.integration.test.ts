import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadDomainAdapter } from "../../src/adapters/adapter-loader";
import {
  ACTIONABILITY_RUBRIC_VERSION,
  DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD
} from "../../src/core/actionability";
import { runDiscussion } from "../../src/core/orchestrator";
import { MockProvider } from "../../src/providers/mock-provider";
import { ProviderRegistry } from "../../src/providers/provider-registry";

const shouldRunBenchmark = process.env.RUN_BENCHMARK_TESTS === "1";
const runOrSkip = shouldRunBenchmark ? test : test.skip;

const BASELINE_INPUT_TOKENS = 15357;
const TARGET_INPUT_TOKENS = 11518;
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
      actionability: {
        score: number;
        passed: boolean;
        evaluationTier: string;
      };
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
          ?.qualityGate as
            | { score?: number; passed?: boolean; evaluationTier?: string }
            | undefined;

        reportEntries.push({
          adapterId,
          topic,
          inputTokens,
          outputTokens,
          actionability: {
            score: qualityGate?.score ?? 0,
            passed: Boolean(qualityGate?.passed),
            evaluationTier: qualityGate?.evaluationTier ?? "baseline"
          }
        });
      }
    }

    const meanInputTokens =
      reportEntries.reduce((total, entry) => total + entry.inputTokens, 0) / reportEntries.length;
    const meanActionabilityScore =
      reportEntries.reduce((total, entry) => total + entry.actionability.score, 0) /
      reportEntries.length;
    const distinctActionabilityScores = new Set(
      reportEntries.map((entry) => entry.actionability.score.toFixed(2))
    );

    const report = {
      generatedAt: new Date().toISOString(),
      evaluationTier: "baseline",
      rubricVersion: ACTIONABILITY_RUBRIC_VERSION,
      baselineInputTokens: BASELINE_INPUT_TOKENS,
      targetInputTokens: TARGET_INPUT_TOKENS,
      actionabilityThreshold: DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD,
      meanInputTokens: Number(meanInputTokens.toFixed(2)),
      meanActionabilityScore: Number(meanActionabilityScore.toFixed(2)),
      entries: reportEntries
    };

    const outputDir = resolve(process.cwd(), "runs", "benchmarks");
    await mkdir(outputDir, { recursive: true });
    const outputPath = join(outputDir, `v02-benchmark-${Date.now()}.json`);
    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

    expect(report.meanInputTokens).toBeLessThanOrEqual(TARGET_INPUT_TOKENS);
    expect(report.evaluationTier).toBe("baseline");
    expect(report.rubricVersion).toBe(ACTIONABILITY_RUBRIC_VERSION);
    expect(report.entries.every((entry) => entry.actionability.passed)).toBe(true);
    expect(report.entries.every((entry) => entry.actionability.evaluationTier === "baseline")).toBe(true);
    expect(distinctActionabilityScores.size).toBeGreaterThan(1);
  });
});
