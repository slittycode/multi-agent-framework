import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadDomainAdapter } from "../../adapters/adapter-loader";
import { runDiscussion } from "../../core/orchestrator";
import { createProviderRegistryForRun, type ProviderMode } from "../../providers/provider-bootstrap";

interface BenchmarkCliOptions {
  providerMode: ProviderMode;
  outputDir: string;
}

interface BenchmarkReportEntry {
  adapterId: string;
  topic: string;
  inputTokens: number;
  outputTokens: number;
  qualityScore: number;
  qualityPassed: boolean;
  error?: string;
}

const BASELINE_INPUT_TOKENS = 15357;
const TARGET_INPUT_TOKENS = 11518;
const QUALITY_THRESHOLD = 75;
const ENTRY_TIMEOUT_MS = 3 * 60 * 1000;
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function formatProgressTopic(topic: string): string {
  const maxLength = 28;
  if (topic.length <= maxLength) {
    return topic;
  }

  return `${topic.slice(0, maxLength - 3)}...`;
}

function getStatusLabel(entry: BenchmarkReportEntry): string {
  if (entry.qualityPassed) {
    return "pass";
  }

  if (!entry.error) {
    return "fail";
  }

  if (entry.error.includes("timed out")) {
    return "fail (timeout)";
  }

  return "fail (error)";
}

function getBenchmarkUsage(): string {
  return [
    "Usage:",
    "  benchmark [--provider-mode mock|live|auto] [--output-dir <dir>]"
  ].join("\n");
}

function parseBenchmarkOptions(args: string[]): BenchmarkCliOptions {
  const options: BenchmarkCliOptions = {
    providerMode: "mock",
    outputDir: "./benchmarks"
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    switch (token) {
      case "--provider-mode": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --provider-mode");
        }
        if (value !== "mock" && value !== "live" && value !== "auto") {
          throw new Error(`Invalid --provider-mode value: ${value}. Expected mock|live|auto.`);
        }
        options.providerMode = value;
        index += 1;
        break;
      }
      case "--output-dir": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --output-dir");
        }
        options.outputDir = value;
        index += 1;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  return options;
}

function renderSummaryTable(entries: BenchmarkReportEntry[]): void {
  const headers = {
    adapter: "adapter",
    topic: "topic",
    inputTokens: "inputTokens",
    outputTokens: "outputTokens",
    qualityScore: "qualityScore",
    status: "status"
  };

  const widths = {
    adapter: Math.max(headers.adapter.length, ...entries.map((entry) => entry.adapterId.length)),
    topic: Math.max(headers.topic.length, ...entries.map((entry) => entry.topic.length)),
    inputTokens: Math.max(
      headers.inputTokens.length,
      ...entries.map((entry) => entry.inputTokens.toString().length)
    ),
    outputTokens: Math.max(
      headers.outputTokens.length,
      ...entries.map((entry) => entry.outputTokens.toString().length)
    ),
    qualityScore: Math.max(
      headers.qualityScore.length,
      ...entries.map((entry) => entry.qualityScore.toFixed(2).length)
    ),
    status: Math.max(headers.status.length, ...entries.map((entry) => getStatusLabel(entry).length))
  };

  const divider = [
    "-".repeat(widths.adapter),
    "-".repeat(widths.topic),
    "-".repeat(widths.inputTokens),
    "-".repeat(widths.outputTokens),
    "-".repeat(widths.qualityScore),
    "-".repeat(widths.status)
  ].join("-+-");

  const formatLine = (columns: [string, string, string, string, string, string]): string =>
    [
      columns[0].padEnd(widths.adapter),
      columns[1].padEnd(widths.topic),
      columns[2].padStart(widths.inputTokens),
      columns[3].padStart(widths.outputTokens),
      columns[4].padStart(widths.qualityScore),
      columns[5].padEnd(widths.status)
    ].join(" | ");

  console.log("Benchmark Summary");
  console.log(
    formatLine([
      headers.adapter,
      headers.topic,
      headers.inputTokens,
      headers.outputTokens,
      headers.qualityScore,
      headers.status
    ])
  );
  console.log(divider);

  for (const entry of entries) {
    console.log(
      formatLine([
        entry.adapterId,
        entry.topic,
        entry.inputTokens.toString(),
        entry.outputTokens.toString(),
        entry.qualityScore.toFixed(2),
        getStatusLabel(entry)
      ])
    );
  }
}

export async function benchmarkCommand(args: string[]): Promise<number> {
  let options: BenchmarkCliOptions;
  try {
    options = parseBenchmarkOptions(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid benchmark arguments.");
    console.error(getBenchmarkUsage());
    return 1;
  }

  try {
    const reportEntries: BenchmarkReportEntry[] = [];
    const totalEntries = BUILTIN_ADAPTER_IDS.reduce(
      (total, adapterId) => total + BENCHMARK_TOPICS_BY_ADAPTER[adapterId].length,
      0
    );
    let completedEntries = 0;

    for (const adapterId of BUILTIN_ADAPTER_IDS) {
      const adapter = await loadDomainAdapter(adapterId);
      const providerRegistry = createProviderRegistryForRun({
        adapter,
        providerMode: options.providerMode,
        env: process.env as Record<string, string | undefined>
      });
      const adapterTopics = BENCHMARK_TOPICS_BY_ADAPTER[adapterId];

      for (const topic of adapterTopics) {
        completedEntries += 1;
        const progressTopic = formatProgressTopic(topic);
        const progressPrefix = `[${completedEntries}/${totalEntries}] ${adapterId} — "${progressTopic}"`;
        console.log(`${progressPrefix} starting...`);

        try {
          const result = await withTimeout(
            runDiscussion({
              adapter,
              topic,
              providerRegistry,
              config: {
                transcript: {
                  persistToFile: false,
                  outputDir: "./runs",
                  format: "json"
                }
              }
            }),
            ENTRY_TIMEOUT_MS,
            `Run timed out after ${Math.floor(ENTRY_TIMEOUT_MS / 1000)} seconds`
          );

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

          const qualityScore =
            typeof qualityGate?.score === "number" && Number.isFinite(qualityGate.score)
              ? qualityGate.score
              : 0;
          const qualityPassed =
            typeof qualityGate?.passed === "boolean"
              ? qualityGate.passed
              : qualityScore >= QUALITY_THRESHOLD;

          reportEntries.push({
            adapterId,
            topic,
            inputTokens,
            outputTokens,
            qualityScore,
            qualityPassed
          });

          console.log(
            `${progressPrefix} done (${outputTokens} out tokens, score: ${qualityScore.toFixed(2)})`
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown benchmark entry failure.";

          reportEntries.push({
            adapterId,
            topic,
            inputTokens: 0,
            outputTokens: 0,
            qualityScore: 0,
            qualityPassed: false,
            error: errorMessage
          });

          console.log(`${progressPrefix} failed (${errorMessage})`);
        }
      }
    }

    const meanInputTokens =
      reportEntries.reduce((total, entry) => total + entry.inputTokens, 0) / reportEntries.length;
    const meanQualityScore =
      reportEntries.reduce((total, entry) => total + entry.qualityScore, 0) / reportEntries.length;

    const report = {
      generatedAt: new Date().toISOString(),
      baselineInputTokens: BASELINE_INPUT_TOKENS,
      targetInputTokens: TARGET_INPUT_TOKENS,
      qualityThreshold: QUALITY_THRESHOLD,
      meanInputTokens: Number(meanInputTokens.toFixed(2)),
      meanQualityScore: Number(meanQualityScore.toFixed(2)),
      entries: reportEntries
    };

    const resolvedOutputDir = resolve(process.cwd(), options.outputDir);
    await mkdir(resolvedOutputDir, { recursive: true });
    const outputPath = join(resolvedOutputDir, `v02-benchmark-${Date.now()}.json`);
    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

    renderSummaryTable(reportEntries);
    console.log(`\nReport written: ${outputPath}`);

    return reportEntries.every((entry) => entry.qualityPassed) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Benchmark command failed.");
    return 1;
  }
}
