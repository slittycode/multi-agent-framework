import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadDomainAdapter } from "../../adapters/adapter-loader";
import {
  persistCertificationManifest,
  updateConnectorCertification
} from "../../connectors/auth-certifier";
import { applyConnectorToAdapter } from "../../connectors/adapter-override";
import { loadConnectorCatalog, saveConnectorCatalog } from "../../connectors/catalog";
import { createCredentialStore } from "../../connectors/credential-store";
import { BENCHMARK_CERTIFICATION_TTL_MS } from "../../connectors/live-certification";
import {
  listAvailableConnectors,
  resolveConnectorById,
  resolveExecutionContext,
  type ExecutionMode
} from "../../connectors/connector-resolution";
import type { AvailableConnector } from "../../connectors/types";
import {
  ACTIONABILITY_RUBRIC_VERSION,
  LIVE_CERTIFICATION_ENTRY_THRESHOLD,
  LIVE_CERTIFICATION_MEAN_THRESHOLD,
  getActionabilityThreshold,
  getEvaluationTierForProviderMode,
  type ActionabilityEvaluation,
  type ActionabilityEvaluationTier
} from "../../core/actionability";
import { runDiscussion } from "../../core/orchestrator";
import {
  createProviderRegistryForRun,
  type ProviderMode
} from "../../providers/provider-bootstrap";
import type { Transcript } from "../../types";

export interface BenchmarkCliOptions {
  executionMode: ExecutionMode;
  connectorId?: string;
  allConnectors: boolean;
  outputDir: string;
}

interface BenchmarkProviderProfile {
  connector?: AvailableConnector;
  connectorId?: string;
  providerId: string;
  label: string;
  credentialSource?: string;
  envOverlay: Record<string, string>;
  resolvedExecutionMode: "mock" | "live";
}

interface BenchmarkDebugArtifact {
  generatedAt: string;
  entryId: string;
  evaluationTier: ActionabilityEvaluationTier;
  providerMode: ProviderMode;
  executionMode: ExecutionMode;
  resolvedExecutionMode: "mock" | "live";
  connectorId?: string;
  credentialSource?: string;
  certificationScope: "baseline" | "single_connector" | "all_connectors";
  activeConnectorId?: string;
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

export interface BenchmarkReportEntry {
  entryId: string;
  adapterId: string;
  providerId: string;
  connectorId?: string;
  credentialSource?: string;
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

export interface BenchmarkReport {
  generatedAt: string;
  evaluationTier: ActionabilityEvaluationTier;
  providerMode: ProviderMode;
  executionMode: ExecutionMode;
  resolvedExecutionMode: "mock" | "live";
  certificationScope: "baseline" | "single_connector" | "all_connectors";
  activeConnectorId?: string;
  providerIds: string[];
  rubricVersion: string;
  baselineInputTokens: number;
  targetInputTokens: number;
  actionabilityThreshold: number;
  certificationMeanThreshold?: number;
  meanInputTokens: number;
  meanActionabilityScore: number;
  skippedConnectorIds?: string[];
  skippedConnectorReasons?: Record<string, string>;
  entries: BenchmarkReportEntry[];
}

interface BenchmarkCertificationIndexEntry {
  connectorId: string;
  status: "passed" | "failed" | "skipped";
  manifestPath?: string;
  reason?: string;
}

const BASELINE_INPUT_TOKENS = 15357;
const TARGET_INPUT_TOKENS = 11518;
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
    "  benchmark [--execution-mode mock|live|auto] [--connector <id>] [--all-connectors] [--output-dir <dir>]"
  ].join("\n");
}

function parseBenchmarkOptions(args: string[]): BenchmarkCliOptions {
  const options: BenchmarkCliOptions = {
    executionMode: "auto",
    allConnectors: false,
    outputDir: "./benchmarks"
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    switch (token) {
      case "--execution-mode":
      case "--provider-mode": {
        const value = args[index + 1];
        if (!value) {
          throw new Error(`Missing value for ${token}`);
        }
        if (value !== "mock" && value !== "live" && value !== "auto") {
          throw new Error(`Invalid ${token} value: ${value}. Expected mock|live|auto.`);
        }
        options.executionMode = value;
        index += 1;
        break;
      }
      case "--connector": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --connector");
        }
        options.connectorId = value;
        index += 1;
        break;
      }
      case "--all-connectors": {
        options.allConnectors = true;
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

async function buildBenchmarkProfiles(
  options: BenchmarkCliOptions,
  env: Record<string, string | undefined>
): Promise<{
  activeConnectorId?: string;
  certificationScope: "baseline" | "single_connector" | "all_connectors";
  resolvedExecutionMode: "mock" | "live";
  skippedConnectorIds?: string[];
  skippedConnectorReasons?: Record<string, string>;
  profiles: BenchmarkProviderProfile[];
}> {
  const credentialStore = createCredentialStore(env);

  if (options.executionMode === "mock") {
    return {
      certificationScope: "baseline",
      resolvedExecutionMode: "mock",
      profiles: [
        {
          providerId: "gemini",
          label: "declared-providers",
          envOverlay: {},
          resolvedExecutionMode: "mock"
        }
      ]
    };
  }

  if (options.allConnectors) {
    const available = await listAvailableConnectors({ cwd: process.cwd(), env });
    if (available.connectors.length === 0) {
      throw new Error("No runnable live connectors are available for --all-connectors.");
    }

    const profiles: BenchmarkProviderProfile[] = [];
    const skippedConnectorReasons: Record<string, string> = {};
    for (const connector of available.connectors) {
      if (connector.ephemeral) {
        skippedConnectorReasons[connector.id] =
          "Environment-backed connectors must be stored before live certification.";
        continue;
      }

      try {
        const resolved = await resolveConnectorById({
          connectorId: connector.id,
          cwd: process.cwd(),
          env,
          credentialStore
        });
        profiles.push({
          connector: resolved.connector,
          connectorId: resolved.connector.id,
          providerId: resolved.connector.providerId,
          label: resolved.connector.id,
          credentialSource: resolved.connector.credentialSource,
          envOverlay: resolved.envOverlay,
          resolvedExecutionMode: "live"
        });
      } catch (error) {
        skippedConnectorReasons[connector.id] =
          error instanceof Error ? error.message : "Connector could not be materialized.";
      }
    }

    if (profiles.length === 0) {
      throw new Error("No runnable live connectors are available for --all-connectors.");
    }

    return {
      activeConnectorId: available.activeConnectorId,
      certificationScope: "all_connectors",
      resolvedExecutionMode: "live",
      ...(Object.keys(skippedConnectorReasons).length > 0
        ? {
            skippedConnectorIds: Object.keys(skippedConnectorReasons),
            skippedConnectorReasons
          }
        : {}),
      profiles
    };
  }

  const resolution = await resolveExecutionContext({
    cwd: process.cwd(),
    executionMode: options.executionMode,
    explicitConnectorId: options.connectorId,
    env,
    credentialStore
  });

  if (resolution.resolvedExecutionMode === "mock") {
    return {
      activeConnectorId: resolution.activeConnectorId,
      certificationScope: "baseline",
      resolvedExecutionMode: "mock",
      profiles: [
        {
          providerId: "gemini",
          label: "declared-providers",
          envOverlay: {},
          resolvedExecutionMode: "mock"
        }
      ]
    };
  }

  if (resolution.connector?.ephemeral) {
    throw new Error(
      `Connector "${resolution.connector.id}" is environment-backed. Store it with auth login before live certification.`
    );
  }

  return {
    activeConnectorId: resolution.activeConnectorId,
    certificationScope: "single_connector",
    resolvedExecutionMode: "live",
    profiles: [
      {
        connector: resolution.connector,
        connectorId: resolution.connector?.id,
        providerId: resolution.connector?.providerId as string,
        label: resolution.connector?.id as string,
        credentialSource: resolution.connector?.credentialSource,
        envOverlay: resolution.envOverlay,
        resolvedExecutionMode: "live"
      }
    ]
  };
}

function getReportPassStatus(report: BenchmarkReport): boolean {
  if (report.entries.length === 0) {
    return false;
  }

  if (report.evaluationTier === "baseline") {
    return report.entries.every((entry) => !entry.error);
  }

  return (
    report.providerIds.length > 0 &&
    report.meanActionabilityScore >= LIVE_CERTIFICATION_MEAN_THRESHOLD &&
    report.entries.every((entry) => entry.actionability.score >= LIVE_CERTIFICATION_ENTRY_THRESHOLD)
  );
}

function addMs(timestamp: string, durationMs: number): string {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function getConnectorBenchmarkPassStatus(entries: BenchmarkReportEntry[]): boolean {
  if (entries.length === 0) {
    return false;
  }

  const meanActionabilityScore =
    entries.reduce((total, entry) => total + entry.actionability.score, 0) / entries.length;
  return (
    meanActionabilityScore >= LIVE_CERTIFICATION_MEAN_THRESHOLD &&
    entries.every((entry) => !entry.error && entry.actionability.score >= LIVE_CERTIFICATION_ENTRY_THRESHOLD)
  );
}

async function persistBenchmarkCertificationMetadata(
  report: BenchmarkReport,
  outputPath: string,
  outputDir: string
): Promise<void> {
  if (report.resolvedExecutionMode !== "live") {
    return;
  }

  const catalog = await loadConnectorCatalog();
  const groupedEntries = new Map<string, BenchmarkReportEntry[]>();
  for (const entry of report.entries) {
    if (!entry.connectorId) {
      continue;
    }

    const existing = groupedEntries.get(entry.connectorId) ?? [];
    existing.push(entry);
    groupedEntries.set(entry.connectorId, existing);
  }

  const certificationDir = join(outputDir, "certification");
  await mkdir(certificationDir, { recursive: true });
  const indexEntries: BenchmarkCertificationIndexEntry[] = [];
  let updatedCatalog = catalog;

  for (const connector of catalog.connectors) {
    const connectorEntries = groupedEntries.get(connector.id);
    if (!connectorEntries) {
      continue;
    }

    const passed = getConnectorBenchmarkPassStatus(connectorEntries);
    const generatedAt = new Date().toISOString();
    const updatedConnector = updateConnectorCertification({
      connector,
      profile: "benchmark",
      generatedAt,
      layerUpdates: {
        benchmark: {
          status: passed ? "passed" : "failed",
          checkedAt: report.generatedAt,
          freshUntil: addMs(report.generatedAt, BENCHMARK_CERTIFICATION_TTL_MS),
          artifactPath: outputPath,
          ...(passed ? {} : { message: "Live benchmark certification thresholds were not met." })
        }
      }
    });
    const manifestResult = await persistCertificationManifest({
      connector: {
        ...updatedConnector,
        ephemeral: false
      },
      profile: "benchmark",
      outputDir: certificationDir,
      profilePassed: passed,
      updatedConnector
    });
    const finalConnector = updateConnectorCertification({
      connector: updatedConnector,
      profile: "benchmark",
      generatedAt,
      manifestPath: manifestResult.manifestPath,
      layerUpdates: {}
    });
    updatedCatalog = {
      ...updatedCatalog,
      connectors: updatedCatalog.connectors
        .map((candidate) => (candidate.id === finalConnector.id ? finalConnector : candidate))
        .sort((left, right) => left.id.localeCompare(right.id))
    };

    indexEntries.push({
      connectorId: connector.id,
      status: passed ? "passed" : "failed",
      manifestPath: manifestResult.manifestPath
    });
  }

  if (report.skippedConnectorIds?.length) {
    for (const connectorId of report.skippedConnectorIds) {
      indexEntries.push({
        connectorId,
        status: "skipped",
        reason: report.skippedConnectorReasons?.[connectorId]
      });
    }
  }

  if (indexEntries.length === 0) {
    return;
  }

  await saveConnectorCatalog(updatedCatalog);
  await writeFile(
    join(certificationDir, `benchmark-certification-index-${Date.now()}.json`),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        reportPath: outputPath,
        connectors: indexEntries
      },
      null,
      2
    )}\n`,
    "utf8"
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
    const result = await runBenchmarkSuite(options, process.env as Record<string, string | undefined>);
    await persistBenchmarkCertificationMetadata(
      result.report,
      result.outputPath,
      resolve(process.cwd(), options.outputDir)
    );
    return result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Benchmark command failed.");
    return 1;
  }
}

export async function runBenchmarkSuite(
  options: BenchmarkCliOptions,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Promise<{
  report: BenchmarkReport;
  outputPath: string;
  exitCode: number;
}> {
  const profileResolution = await buildBenchmarkProfiles(options, env);
  const evaluationTier = getEvaluationTierForProviderMode(profileResolution.resolvedExecutionMode);
  const entryThreshold = getActionabilityThreshold(evaluationTier);
  const resolvedOutputDir = resolve(process.cwd(), options.outputDir);
  const transcriptOutputDir = join(resolvedOutputDir, "transcripts");
  const debugOutputDir = join(resolvedOutputDir, "debug");
  await mkdir(transcriptOutputDir, { recursive: true });
  await mkdir(debugOutputDir, { recursive: true });

  const profiles = profileResolution.profiles;
  const reportEntries: BenchmarkReportEntry[] = [];
  const totalEntries = BUILTIN_ADAPTER_IDS.reduce(
    (total, adapterId) => total + BENCHMARK_TOPICS_BY_ADAPTER[adapterId].length * profiles.length,
    0
  );
  let completedEntries = 0;

  for (const profile of profiles) {
    for (const adapterId of BUILTIN_ADAPTER_IDS) {
      const loadedAdapter = await loadDomainAdapter(adapterId);
      const adapter = profile.connector
        ? applyConnectorToAdapter(loadedAdapter, profile.connector)
        : loadedAdapter;
      const providerRegistry = createProviderRegistryForRun({
        adapter,
        providerMode: profile.resolvedExecutionMode,
        env: {
          ...env,
          ...profile.envOverlay
        },
        connectorByProviderId: profile.connector
          ? { [profile.connector.providerId]: profile.connector }
          : undefined
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
                providerMode: options.executionMode,
                executionMode: options.executionMode,
                resolvedExecutionMode: profile.resolvedExecutionMode,
                providerId: profile.providerId,
                connectorId: profile.connectorId,
                credentialSource: profile.credentialSource,
                activeConnectorId: profileResolution.activeConnectorId,
                certificationScope: profileResolution.certificationScope
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
            connectorId: profile.connectorId,
            credentialSource: profile.credentialSource,
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
              providerMode: options.executionMode,
              executionMode: options.executionMode,
              resolvedExecutionMode: profile.resolvedExecutionMode,
              connectorId: profile.connectorId,
              credentialSource: profile.credentialSource,
              certificationScope: profileResolution.certificationScope,
              activeConnectorId: profileResolution.activeConnectorId,
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
            providerMode: options.executionMode,
            executionMode: options.executionMode,
            resolvedExecutionMode: profile.resolvedExecutionMode,
            connectorId: profile.connectorId,
            credentialSource: profile.credentialSource,
            certificationScope: profileResolution.certificationScope,
            activeConnectorId: profileResolution.activeConnectorId,
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
            connectorId: profile.connectorId,
            credentialSource: profile.credentialSource,
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
    providerMode: options.executionMode,
    executionMode: options.executionMode,
    resolvedExecutionMode: profileResolution.resolvedExecutionMode,
    certificationScope: profileResolution.certificationScope,
    activeConnectorId: profileResolution.activeConnectorId,
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
    ...(profileResolution.skippedConnectorIds?.length
      ? {
          skippedConnectorIds: profileResolution.skippedConnectorIds,
          skippedConnectorReasons: profileResolution.skippedConnectorReasons
        }
      : {}),
    entries: reportEntries
  };

  const outputPath = join(resolvedOutputDir, `v02-benchmark-${Date.now()}.json`);
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  renderSummaryTable(reportEntries, evaluationTier);
  console.log(`\nReport written: ${outputPath}`);

  return {
    report,
    outputPath,
    exitCode: getReportPassStatus(report) ? 0 : 1
  };
}
