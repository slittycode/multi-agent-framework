import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadDomainAdapter } from "../../adapters/adapter-loader";
import {
  ACTIONABILITY_RUBRIC_VERSION,
  DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD,
  LIVE_CERTIFICATION_ENTRY_THRESHOLD,
  LIVE_CERTIFICATION_MEAN_THRESHOLD,
  getEvaluationTierForProviderMode,
  type ActionabilityEvaluation,
  type ActionabilityEvaluationTier
} from "../../core/actionability";
import { runDiscussion } from "../../core/orchestrator";
import {
  LIVE_CERTIFICATION_PROVIDER_IDS,
  createProviderRegistryForRun,
  describeProviderSupport,
  type ProviderMode
} from "../../providers/provider-bootstrap";
import type { DomainAdapter, Transcript } from "../../types";

interface BenchmarkCliOptions {
  providerMode: ProviderMode;
  outputDir: string;
}

interface BenchmarkProviderProfile {
  providerId: string;
  label: string;
}

interface BenchmarkDebugArtifact {
  generatedAt: string;
  entryId: string;
  evaluationTier: ActionabilityEvaluationTier;
  providerMode: ProviderMode;
  adapterId: string;
  providerId: string;
  topic: string;
  transcriptPath?: string;
  error?: string;
  failureReasons: string[];
  providerInvocationIds: string[];
  providerModels: string[];
  totalLatencyMs: number;
  actionability: ActionabilityEvaluation;
}

interface BenchmarkReportEntry {
  entryId: string;
  adapterId: string;
  providerId: string;
  topic: string;
  inputTokens: number;
  outputTokens: number;
  tokenBudgetPassed: boolean;
  actionability: ActionabilityEvaluation;
  failureReasons: string[];
  transcriptPath?: string;
  debugArtifactPath?: string;
  error?: string;
}

interface BenchmarkReport {
  generatedAt: string;
  evaluationTier: ActionabilityEvaluationTier;
  providerMode: ProviderMode;
  providerIds: string[];
  rubricVersion: string;
  baselineInputTokens: number;
  targetInputTokens: number;
  actionabilityThreshold: number;
  certificationMeanThreshold?: number;
  meanInputTokens: number;
  meanActionabilityScore: number;
  entries: BenchmarkReportEntry[];
}

const BASELINE_INPUT_TOKENS = 15357;
const TARGET_INPUT_TOKENS = 11518;
const ENTRY_TIMEOUT_MS = 3 * 60 * 1000;
const BUILTIN_ADAPTER_IDS = ["general-debate", "creative-writing", "ableton-feedback"] as const;
const DEFAULT_MODEL_BY_PROVIDER = {
  gemini: "gemini-2.5-flash",
  kimi: "moonshot-v1-8k"
} as const;

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
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        rejectPromise(error);
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
  if (!entry.error && entry.actionability.passed) {
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

function renderSummaryTable(
  entries: BenchmarkReportEntry[],
  evaluationTier: ActionabilityEvaluationTier
): void {
  const headers = {
    adapter: "adapter",
    provider: "provider",
    topic: "topic",
    inputTokens: "inputTokens",
    outputTokens: "outputTokens",
    actionability: "actionability",
    status: "status"
  };

  const widths = {
    adapter: Math.max(headers.adapter.length, ...entries.map((entry) => entry.adapterId.length)),
    provider: Math.max(headers.provider.length, ...entries.map((entry) => entry.providerId.length)),
    topic: Math.max(headers.topic.length, ...entries.map((entry) => entry.topic.length)),
    inputTokens: Math.max(
      headers.inputTokens.length,
      ...entries.map((entry) => entry.inputTokens.toString().length)
    ),
    outputTokens: Math.max(
      headers.outputTokens.length,
      ...entries.map((entry) => entry.outputTokens.toString().length)
    ),
    actionability: Math.max(
      headers.actionability.length,
      ...entries.map((entry) => entry.actionability.score.toFixed(2).length)
    ),
    status: Math.max(headers.status.length, ...entries.map((entry) => getStatusLabel(entry).length))
  };

  const divider = [
    "-".repeat(widths.adapter),
    "-".repeat(widths.provider),
    "-".repeat(widths.topic),
    "-".repeat(widths.inputTokens),
    "-".repeat(widths.outputTokens),
    "-".repeat(widths.actionability),
    "-".repeat(widths.status)
  ].join("-+-");

  const formatLine = (columns: [string, string, string, string, string, string, string]): string =>
    [
      columns[0].padEnd(widths.adapter),
      columns[1].padEnd(widths.provider),
      columns[2].padEnd(widths.topic),
      columns[3].padStart(widths.inputTokens),
      columns[4].padStart(widths.outputTokens),
      columns[5].padStart(widths.actionability),
      columns[6].padEnd(widths.status)
    ].join(" | ");

  console.log(`Evaluation Tier: ${evaluationTier}`);
  console.log("Benchmark Summary");
  console.log(
    formatLine([
      headers.adapter,
      headers.provider,
      headers.topic,
      headers.inputTokens,
      headers.outputTokens,
      headers.actionability,
      headers.status
    ])
  );
  console.log(divider);

  for (const entry of entries) {
    console.log(
      formatLine([
        entry.adapterId,
        entry.providerId,
        entry.topic,
        entry.inputTokens.toString(),
        entry.outputTokens.toString(),
        entry.actionability.score.toFixed(2),
        getStatusLabel(entry)
      ])
    );
  }
}

function createEmptyActionability(
  evaluationTier: ActionabilityEvaluationTier,
  threshold: number,
  failureReason: string
): ActionabilityEvaluation {
  return {
    rubricVersion: ACTIONABILITY_RUBRIC_VERSION,
    evaluationTier,
    threshold,
    score: 0,
    passed: false,
    subscores: {
      structuralCompleteness: 0,
      recommendationSpecificity: 0,
      grounding: 0,
      nonRedundancy: 0,
      prioritizedNextStepUsefulness: 0
    },
    penalties: [],
    failureReasons: [failureReason]
  };
}

function getActionabilityThreshold(evaluationTier: ActionabilityEvaluationTier): number {
  return evaluationTier === "baseline"
    ? DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD
    : LIVE_CERTIFICATION_ENTRY_THRESHOLD;
}

function applyProviderProfile(adapter: DomainAdapter, providerId: string): DomainAdapter {
  const defaultModel = DEFAULT_MODEL_BY_PROVIDER[providerId as keyof typeof DEFAULT_MODEL_BY_PROVIDER];

  return {
    ...adapter,
    agents: adapter.agents.map((agent) => {
      if (!agent.llm) {
        return agent;
      }

      return {
        ...agent,
        llm: {
          ...agent.llm,
          provider: providerId,
          model:
            providerId === agent.llm.provider
              ? agent.llm.model
              : defaultModel ?? agent.llm.model
        }
      };
    })
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readTranscriptIfExists(path: string | undefined): Promise<Transcript | undefined> {
  if (!path || !(await fileExists(path))) {
    return undefined;
  }

  const contents = await readFile(path, "utf8");
  return JSON.parse(contents) as Transcript;
}

function getEntryInvocationIds(transcript: Transcript | undefined): string[] {
  if (!transcript) {
    return [];
  }

  return [...new Set(transcript.messages.map((message) => message.providerInvocationId).filter(Boolean))] as string[];
}

function getEntryProviderModels(transcript: Transcript | undefined): string[] {
  if (!transcript) {
    return [];
  }

  return [
    ...new Set(
      transcript.messages
        .map((message) =>
          message.provider && message.model ? `${message.provider}:${message.model}` : undefined
        )
        .filter(Boolean)
    )
  ] as string[];
}

function getEntryLatencyMs(transcript: Transcript | undefined): number {
  if (!transcript) {
    return 0;
  }

  return transcript.messages.reduce((total, message) => total + (message.usage?.latencyMs ?? 0), 0);
}

async function persistDebugArtifact(
  outputDir: string,
  artifact: BenchmarkDebugArtifact
): Promise<string> {
  const path = join(outputDir, `${artifact.entryId}.debug.json`);
  await writeFile(path, JSON.stringify(artifact, null, 2), "utf8");
  return path;
}

function buildBenchmarkProfiles(
  providerMode: ProviderMode,
  env: Record<string, string | undefined>
): BenchmarkProviderProfile[] {
  if (providerMode === "mock") {
    return [{ providerId: "gemini", label: "declared-providers" }];
  }

  for (const providerId of LIVE_CERTIFICATION_PROVIDER_IDS) {
    const support = describeProviderSupport(providerId);
    const missing = support.requiredEnv.filter((name) => {
      const value = env[name];
      return typeof value !== "string" || value.trim() === "";
    });

    if (!support.liveCapable) {
      throw new Error(`Live certification requires ${providerId} to be live-capable.`);
    }
    if (missing.length > 0) {
      throw new Error(
        `Live certification requires credentials for ${providerId}: ${missing.join(", ")}.`
      );
    }
  }

  return LIVE_CERTIFICATION_PROVIDER_IDS.map((providerId) => ({
    providerId,
    label: providerId
  }));
}

function getReportPassStatus(report: BenchmarkReport): boolean {
  if (report.entries.length === 0) {
    return false;
  }

  if (report.evaluationTier === "baseline") {
    return report.entries.every((entry) => entry.actionability.passed);
  }

  return (
    report.providerIds.length === LIVE_CERTIFICATION_PROVIDER_IDS.length &&
    LIVE_CERTIFICATION_PROVIDER_IDS.every((providerId) => report.providerIds.includes(providerId)) &&
    report.meanActionabilityScore >= LIVE_CERTIFICATION_MEAN_THRESHOLD &&
    report.entries.every((entry) => entry.actionability.score >= LIVE_CERTIFICATION_ENTRY_THRESHOLD)
  );
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
    const env = process.env as Record<string, string | undefined>;
    const evaluationTier = getEvaluationTierForProviderMode(options.providerMode);
    const entryThreshold = getActionabilityThreshold(evaluationTier);
    const resolvedOutputDir = resolve(process.cwd(), options.outputDir);
    const transcriptOutputDir = join(resolvedOutputDir, "transcripts");
    const debugOutputDir = join(resolvedOutputDir, "debug");
    await mkdir(transcriptOutputDir, { recursive: true });
    await mkdir(debugOutputDir, { recursive: true });

    const profiles = buildBenchmarkProfiles(options.providerMode, env);
    const reportEntries: BenchmarkReportEntry[] = [];
    const totalEntries = BUILTIN_ADAPTER_IDS.reduce(
      (total, adapterId) => total + BENCHMARK_TOPICS_BY_ADAPTER[adapterId].length * profiles.length,
      0
    );
    let completedEntries = 0;

    for (const profile of profiles) {
      for (const adapterId of BUILTIN_ADAPTER_IDS) {
        const loadedAdapter = await loadDomainAdapter(adapterId);
        const adapter =
          options.providerMode === "mock"
            ? loadedAdapter
            : applyProviderProfile(loadedAdapter, profile.providerId);
        const providerRegistry = createProviderRegistryForRun({
          adapter,
          providerMode: options.providerMode,
          env
        });
        const adapterTopics = BENCHMARK_TOPICS_BY_ADAPTER[adapterId];

        for (const topic of adapterTopics) {
          completedEntries += 1;
          const progressTopic = formatProgressTopic(topic);
          const entryId = `${profile.providerId}-${adapterId}-${completedEntries}`;
          const runId = `benchmark-${entryId}`;
          const progressPrefix = `[${completedEntries}/${totalEntries}] ${adapterId}/${profile.label} — "${progressTopic}"`;
          const expectedTranscriptPath = join(transcriptOutputDir, `${runId}.transcript.json`);

          console.log(`${progressPrefix} starting...`);

          try {
            const result = await withTimeout(
              runDiscussion({
                adapter,
                topic,
                providerRegistry,
                runId,
                evaluationTier,
                metadata: {
                  benchmarkEntryId: entryId,
                  evaluationTier,
                  providerMode: options.providerMode,
                  providerId: profile.providerId
                },
                config: {
                  qualityGate: {
                    enabled: true,
                    threshold: entryThreshold
                  },
                  transcript: {
                    persistToFile: true,
                    outputDir: transcriptOutputDir,
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
            const actionability = (result.context.transcript.metadata as { qualityGate?: unknown } | undefined)
              ?.qualityGate as ActionabilityEvaluation | undefined;
            const resolvedActionability =
              actionability ??
              createEmptyActionability(
                evaluationTier,
                entryThreshold,
                "Actionability metadata was not recorded."
              );

            const entry: BenchmarkReportEntry = {
              entryId,
              adapterId,
              providerId: profile.providerId,
              topic,
              inputTokens,
              outputTokens,
              tokenBudgetPassed: inputTokens <= TARGET_INPUT_TOKENS,
              actionability: resolvedActionability,
              failureReasons: [...resolvedActionability.failureReasons],
              transcriptPath: result.persistedPath
            };

            if (!entry.actionability.passed) {
              entry.debugArtifactPath = await persistDebugArtifact(debugOutputDir, {
                generatedAt: new Date().toISOString(),
                entryId,
                evaluationTier,
                providerMode: options.providerMode,
                adapterId,
                providerId: profile.providerId,
                topic,
                transcriptPath: result.persistedPath,
                failureReasons: entry.failureReasons,
                providerInvocationIds: getEntryInvocationIds(result.context.transcript),
                providerModels: getEntryProviderModels(result.context.transcript),
                totalLatencyMs: getEntryLatencyMs(result.context.transcript),
                actionability: entry.actionability
              });
            }

            reportEntries.push(entry);

            console.log(
              `${progressPrefix} done (${outputTokens} out tokens, actionability: ${entry.actionability.score.toFixed(2)})`
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Unknown benchmark entry failure.";
            const transcript = await readTranscriptIfExists(expectedTranscriptPath);
            const actionability = transcript
              ? (((transcript.metadata as { qualityGate?: unknown } | undefined)
                  ?.qualityGate as ActionabilityEvaluation | undefined) ??
                createEmptyActionability(evaluationTier, entryThreshold, errorMessage))
              : createEmptyActionability(evaluationTier, entryThreshold, errorMessage);
            const failureReasons = [...new Set([...actionability.failureReasons, errorMessage])];
            const debugArtifactPath = await persistDebugArtifact(debugOutputDir, {
              generatedAt: new Date().toISOString(),
              entryId,
              evaluationTier,
              providerMode: options.providerMode,
              adapterId,
              providerId: profile.providerId,
              topic,
              transcriptPath: (await fileExists(expectedTranscriptPath)) ? expectedTranscriptPath : undefined,
              error: errorMessage,
              failureReasons,
              providerInvocationIds: getEntryInvocationIds(transcript),
              providerModels: getEntryProviderModels(transcript),
              totalLatencyMs: getEntryLatencyMs(transcript),
              actionability
            });

            reportEntries.push({
              entryId,
              adapterId,
              providerId: profile.providerId,
              topic,
              inputTokens: 0,
              outputTokens: 0,
              tokenBudgetPassed: true,
              actionability,
              failureReasons,
              transcriptPath: (await fileExists(expectedTranscriptPath)) ? expectedTranscriptPath : undefined,
              debugArtifactPath,
              error: errorMessage
            });

            console.log(`${progressPrefix} failed (${errorMessage})`);
          }
        }
      }
    }

    const meanInputTokens =
      reportEntries.reduce((total, entry) => total + entry.inputTokens, 0) / reportEntries.length;
    const meanActionabilityScore =
      reportEntries.reduce((total, entry) => total + entry.actionability.score, 0) /
      reportEntries.length;

    const report: BenchmarkReport = {
      generatedAt: new Date().toISOString(),
      evaluationTier,
      providerMode: options.providerMode,
      providerIds: [...new Set(reportEntries.map((entry) => entry.providerId))],
      rubricVersion: ACTIONABILITY_RUBRIC_VERSION,
      baselineInputTokens: BASELINE_INPUT_TOKENS,
      targetInputTokens: TARGET_INPUT_TOKENS,
      actionabilityThreshold: entryThreshold,
      ...(evaluationTier === "live_certification"
        ? { certificationMeanThreshold: LIVE_CERTIFICATION_MEAN_THRESHOLD }
        : {}),
      meanInputTokens: Number(meanInputTokens.toFixed(2)),
      meanActionabilityScore: Number(meanActionabilityScore.toFixed(2)),
      entries: reportEntries
    };

    const outputPath = join(resolvedOutputDir, `v02-benchmark-${Date.now()}.json`);
    await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

    renderSummaryTable(reportEntries, evaluationTier);
    console.log(`\nReport written: ${outputPath}`);

    return getReportPassStatus(report) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Benchmark command failed.");
    return 1;
  }
}
