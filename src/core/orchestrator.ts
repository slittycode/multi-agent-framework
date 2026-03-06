import type { ProviderRegistry } from "../providers/provider-registry";
import type { RetrieverClient } from "../retrieval/retriever-client";
import { NoopRetriever } from "../retrieval/retriever-client";
import { persistTranscript } from "../transcript/file-persistor";
import { appendMessage, finalizeTranscript, initializeTranscript } from "../transcript/transcript-store";
import type {
  DomainAdapter,
  JudgeRoundRecord,
  Message,
  OrchestratorConfig,
  RunContext,
  RunId,
  Transcript
} from "../types";
import { normalizeOrchestratorError, OrchestratorConfigError } from "./errors";
import { runJudgeCheck } from "./judge-runner";
import { runRound } from "./round-runner";
import { advanceRound, createRunContext, setRunStatus, updateTranscript } from "./run-context";
import { runSynthesis } from "./synthesis-runner";

export interface RunDiscussionInput {
  adapter: DomainAdapter;
  topic: string;
  providerRegistry: ProviderRegistry;
  retriever?: RetrieverClient;
  config?: Partial<OrchestratorConfig>;
  runId?: RunId;
  metadata?: Record<string, unknown>;
  onMessage?: (message: Message) => void;
}

export interface RunDiscussionResult {
  context: RunContext;
  persistedPath?: string;
}

const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  executionMode: "sequential",
  failFast: false,
  contextPolicy: {
    mode: "round_plus_recent",
    recentMessageCount: 4,
    includePhaseSummaries: true
  },
  phaseJudge: {
    enabled: false,
    cadence: "after_each_phase",
    agentId: ""
  },
  qualityGate: {
    enabled: false,
    threshold: 75,
    recordInTranscriptMetadata: true
  },
  citations: {
    mode: "transcript_only",
    failPolicy: "graceful_fallback",
    maxWebSourcesPerTurn: 2
  },
  retry: {
    attempts: 1,
    backoffMs: 0
  },
  synthesis: {
    agentId: "",
    trigger: "after_all_rounds"
  },
  transcript: {
    persistToFile: true,
    outputDir: "./runs",
    format: "json"
  },
  cli: {
    showTimestamps: true,
    showUsage: true,
    colorize: true
  }
};

const DEFAULT_RETRY = {
  attempts: 1,
  backoffMs: 0
} as const;

function appendJudgeRoundRecord(
  transcript: Transcript,
  record: JudgeRoundRecord
): Transcript {
  const existingJudgeRounds = Array.isArray(transcript.metadata?.judgeRounds)
    ? (transcript.metadata.judgeRounds as JudgeRoundRecord[])
    : undefined;

  return {
    ...transcript,
    metadata: {
      ...(transcript.metadata ?? {}),
      judgeRounds: existingJudgeRounds
        ? [...existingJudgeRounds, record]
        : [record]
    }
  };
}

function mergeOrchestratorConfig(
  adapter: DomainAdapter,
  override?: Partial<OrchestratorConfig>
): OrchestratorConfig {
  const adapterOverride = adapter.orchestrator;

  return {
    executionMode:
      override?.executionMode ??
      adapterOverride?.executionMode ??
      DEFAULT_ORCHESTRATOR_CONFIG.executionMode,
    failFast:
      override?.failFast ??
      adapterOverride?.failFast ??
      DEFAULT_ORCHESTRATOR_CONFIG.failFast,
    contextPolicy: {
      mode:
        override?.contextPolicy?.mode ??
        adapterOverride?.contextPolicy?.mode ??
        DEFAULT_ORCHESTRATOR_CONFIG.contextPolicy?.mode ??
        "round_plus_recent",
      recentMessageCount:
        override?.contextPolicy?.recentMessageCount ??
        adapterOverride?.contextPolicy?.recentMessageCount ??
        DEFAULT_ORCHESTRATOR_CONFIG.contextPolicy?.recentMessageCount ??
        4,
      includePhaseSummaries:
        override?.contextPolicy?.includePhaseSummaries ??
        adapterOverride?.contextPolicy?.includePhaseSummaries ??
        DEFAULT_ORCHESTRATOR_CONFIG.contextPolicy?.includePhaseSummaries ??
        true
    },
    phaseJudge: {
      enabled:
        override?.phaseJudge?.enabled ??
        adapterOverride?.phaseJudge?.enabled ??
        DEFAULT_ORCHESTRATOR_CONFIG.phaseJudge?.enabled ??
        false,
      cadence: "after_each_phase",
      agentId:
        override?.phaseJudge?.agentId ??
        adapterOverride?.phaseJudge?.agentId ??
        adapter.synthesisAgentId,
      promptTemplate:
        override?.phaseJudge?.promptTemplate ??
        adapterOverride?.phaseJudge?.promptTemplate
    },
    qualityGate: {
      enabled:
        override?.qualityGate?.enabled ??
        adapterOverride?.qualityGate?.enabled ??
        DEFAULT_ORCHESTRATOR_CONFIG.qualityGate?.enabled ??
        false,
      threshold:
        override?.qualityGate?.threshold ??
        adapterOverride?.qualityGate?.threshold ??
        DEFAULT_ORCHESTRATOR_CONFIG.qualityGate?.threshold ??
        75,
      recordInTranscriptMetadata:
        override?.qualityGate?.recordInTranscriptMetadata ??
        adapterOverride?.qualityGate?.recordInTranscriptMetadata ??
        DEFAULT_ORCHESTRATOR_CONFIG.qualityGate?.recordInTranscriptMetadata ??
        true
    },
    citations: {
      mode:
        override?.citations?.mode ??
        adapterOverride?.citations?.mode ??
        DEFAULT_ORCHESTRATOR_CONFIG.citations?.mode ??
        "transcript_only",
      failPolicy:
        override?.citations?.failPolicy ??
        adapterOverride?.citations?.failPolicy ??
        DEFAULT_ORCHESTRATOR_CONFIG.citations?.failPolicy ??
        "graceful_fallback",
      maxWebSourcesPerTurn:
        override?.citations?.maxWebSourcesPerTurn ??
        adapterOverride?.citations?.maxWebSourcesPerTurn ??
        DEFAULT_ORCHESTRATOR_CONFIG.citations?.maxWebSourcesPerTurn ??
        2
    },
    judge:
      override?.judge ??
      adapterOverride?.judge ??
      DEFAULT_ORCHESTRATOR_CONFIG.judge,
    retry: {
      attempts:
        override?.retry?.attempts ??
        adapterOverride?.retry?.attempts ??
        DEFAULT_RETRY.attempts,
      backoffMs:
        override?.retry?.backoffMs ??
        adapterOverride?.retry?.backoffMs ??
        DEFAULT_RETRY.backoffMs
    },
    synthesis: {
      trigger: "after_all_rounds",
      agentId:
        override?.synthesis?.agentId ??
        adapterOverride?.synthesis?.agentId ??
        adapter.synthesisAgentId
    },
    transcript: {
      ...DEFAULT_ORCHESTRATOR_CONFIG.transcript,
      ...(adapterOverride?.transcript ?? {}),
      ...(override?.transcript ?? {})
    },
    cli: {
      ...DEFAULT_ORCHESTRATOR_CONFIG.cli,
      ...(adapterOverride?.cli ?? {}),
      ...(override?.cli ?? {})
    }
  };
}

function appendQualityGateRecord(
  transcript: Transcript,
  result: {
    threshold: number;
    score: number;
    passed: boolean;
    phaseScores: number[];
    synthesisScore?: number;
  }
): Transcript {
  return {
    ...transcript,
    metadata: {
      ...(transcript.metadata ?? {}),
      qualityGate: result
    }
  };
}

function tokenizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .match(/[a-z0-9]+/giu)
    ?.filter((token) => token.length > 0) ?? [];
}

function countSentences(value: string): number {
  const sentences = value
    .split(/[.!?]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return sentences.length;
}

function clampScore(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countCitationMarkers(value: string): number {
  return [...value.matchAll(/\[(?:T|W)\d+\]/giu)].length;
}

function computeSynthesisQualityScore(transcript: Transcript): number | undefined {
  const synthesis = transcript.synthesis;
  if (!synthesis) {
    return undefined;
  }

  const summary = synthesis.summary.trim();
  if (!summary) {
    return 0;
  }

  const summaryWords = tokenizeWords(summary);
  const summaryWordCount = summaryWords.length;
  const summarySentenceCount = countSentences(summary);
  const uniqueWordRatio =
    summaryWordCount === 0 ? 0 : new Set(summaryWords).size / summaryWordCount;

  const summaryLengthScore = clampScore((summaryWordCount / 45) * 30, 0, 30);
  const summarySentenceScore = clampScore(summarySentenceCount * 6, 0, 18);
  const lexicalDiversityScore = clampScore(uniqueWordRatio * 18, 0, 18);

  let verdictScore = 0;
  const verdict = synthesis.verdict?.trim();
  if (verdict) {
    const verdictWordCount = tokenizeWords(verdict).length;
    verdictScore = clampScore(6 + verdictWordCount * 0.8, 0, 16);
  }

  const recommendations = synthesis.recommendations ?? [];
  const recommendationCount = recommendations.length;
  const recommendationWordCount = recommendations.reduce(
    (total, recommendation) => total + tokenizeWords(recommendation.text).length,
    0
  );
  const averageRecommendationWords =
    recommendationCount > 0 ? recommendationWordCount / recommendationCount : 0;

  let recommendationScore = 0;
  if (recommendationCount > 0) {
    const countScore = clampScore(recommendationCount * 5, 0, 12);
    const depthScore = clampScore(averageRecommendationWords * 0.6, 0, 8);
    const priorityScore = clampScore(
      recommendations.filter((item) => item.priority !== undefined).length * 1.5,
      0,
      4
    );
    recommendationScore = countScore + depthScore + priorityScore;
  }

  const citationScore = clampScore(
    countCitationMarkers(summary) + countCitationMarkers(verdict ?? ""),
    0,
    4
  );

  const score =
    summaryLengthScore +
    summarySentenceScore +
    lexicalDiversityScore +
    verdictScore +
    recommendationScore +
    citationScore;

  return Number(clampScore(score, 0, 100).toFixed(2));
}

function computeQualityGateResult(
  transcript: Transcript,
  config: OrchestratorConfig
):
  | {
      threshold: number;
      score: number;
      passed: boolean;
      phaseScores: number[];
      synthesisScore?: number;
    }
  | undefined {
  if (!config.qualityGate?.enabled) {
    return undefined;
  }

  const judgePhaseRecords = Array.isArray(transcript.metadata?.judgePhases)
    ? (transcript.metadata.judgePhases as Array<{ decision?: { score?: number } }>)
    : [];
  const phaseScores = judgePhaseRecords
    .map((record) => record.decision?.score)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const synthesisScore = computeSynthesisQualityScore(transcript);
  let score = 0;
  if (phaseScores.length > 0 || synthesisScore !== undefined) {
    const phaseTotal = phaseScores.reduce((total, value) => total + value, 0);
    const synthesisWeight = synthesisScore === undefined ? 0 : 1.5;
    const weightedTotal = phaseTotal + (synthesisScore ?? 0) * synthesisWeight;
    const weightDenominator = phaseScores.length + synthesisWeight;
    score = Number((weightedTotal / weightDenominator).toFixed(2));
  }

  return {
    threshold: config.qualityGate.threshold,
    score,
    passed: score >= config.qualityGate.threshold,
    phaseScores,
    synthesisScore
  };
}

export async function runDiscussion(input: RunDiscussionInput): Promise<RunDiscussionResult> {
  const config = mergeOrchestratorConfig(input.adapter, input.config);
  const retriever =
    input.retriever ??
    (config.citations?.mode === "optional_web" ? new NoopRetriever() : undefined);

  if (config.executionMode !== "sequential") {
    throw new OrchestratorConfigError(
      `Execution mode "${config.executionMode}" is not implemented in MVP.`,
      "UNSUPPORTED_EXECUTION_MODE"
    );
  }

  const runId = input.runId ?? crypto.randomUUID();

  let context: RunContext | undefined;
  let persistedPath: string | undefined;

  try {
    const transcript = initializeTranscript({
      runId,
      adapterId: input.adapter.id,
      topic: input.topic,
      metadata: input.metadata
    });

    context = createRunContext({
      runId,
      adapter: input.adapter,
      config,
      transcript
    });
    context = setRunStatus(context, "running");

    for (let roundIndex = 0; roundIndex < input.adapter.rounds.length; roundIndex += 1) {
      const round = input.adapter.rounds[roundIndex];
      if (!round) {
        throw new OrchestratorConfigError(
          `Round index ${roundIndex} is undefined for adapter "${input.adapter.id}".`,
          "INVALID_ROUND_CONFIGURATION"
        );
      }
      context = {
        ...context,
        currentRoundIndex: roundIndex,
        currentPhaseIndex: 0
      };

      context = await runRound(context, round, {
        adapter: input.adapter,
        topic: input.topic,
        providerRegistry: input.providerRegistry,
        retriever,
        onMessage: input.onMessage
      });

      let shouldStopAfterRound = false;
      if (config.judge) {
        try {
          const judgeResult = await runJudgeCheck({
            context,
            round,
            providerRegistry: input.providerRegistry,
            judge: config.judge
          });

          context = updateTranscript(
            context,
            appendJudgeRoundRecord(context.transcript, judgeResult.record)
          );
          shouldStopAfterRound = judgeResult.decision.finished;
        } catch (judgeError) {
          const normalizedJudgeError = normalizeOrchestratorError(judgeError);
          if (config.failFast) {
            throw normalizedJudgeError;
          }

          const fallbackJudgeRecord: JudgeRoundRecord = {
            roundId: round.id,
            roundName: round.name,
            timestamp: new Date().toISOString(),
            decision: {
              finished: false,
              rationale: normalizedJudgeError.message
            }
          };
          context = updateTranscript(
            context,
            appendJudgeRoundRecord(context.transcript, fallbackJudgeRecord)
          );
        }
      }

      if (shouldStopAfterRound) {
        break;
      }

      if (roundIndex < input.adapter.rounds.length - 1) {
        context = advanceRound(context);
      }
    }

    context = setRunStatus(context, "synthesizing");
    let synthesisOutput = undefined;

    try {
      const synthesisResult = await runSynthesis({
        context,
        providerRegistry: input.providerRegistry
      });

      if (synthesisResult.message) {
        const transcriptWithSynthesisMessage = appendMessage(
          context.transcript,
          synthesisResult.message
        );
        context = updateTranscript(context, transcriptWithSynthesisMessage);
        input.onMessage?.(synthesisResult.message);
      }

      synthesisOutput = synthesisResult.output;
    } catch (synthesisError) {
      const normalizedSynthesisError = normalizeOrchestratorError(synthesisError);
      if (config.failFast) {
        throw normalizedSynthesisError;
      }

      const previousMessage = context.transcript.messages.at(-1);
      const synthesisErrorMessage: Message = {
        id: crypto.randomUUID(),
        runId: context.runId,
        roundId: context.adapter.rounds.at(-1)?.id,
        phaseId: "synthesis",
        turnIndex: context.transcript.messages.length + 1,
        timestamp: new Date().toISOString(),
        from: "orchestrator",
        to: "all",
        kind: "error",
        content: `Synthesis failed: ${normalizedSynthesisError.message}`,
        respondingToMessageId: previousMessage?.id,
        metadata: {
          source:
            "source" in normalizedSynthesisError &&
            typeof normalizedSynthesisError.source === "string"
              ? normalizedSynthesisError.source
              : "runtime",
          code:
            "code" in normalizedSynthesisError &&
            typeof normalizedSynthesisError.code === "string"
              ? normalizedSynthesisError.code
              : normalizedSynthesisError.name
        }
      };

      const transcriptWithErrorMessage = appendMessage(context.transcript, synthesisErrorMessage);
      context = updateTranscript(context, transcriptWithErrorMessage);
      input.onMessage?.(synthesisErrorMessage);
    }

    if (synthesisOutput) {
      context = updateTranscript(context, {
        ...context.transcript,
        synthesis: synthesisOutput
      });
    }

    const qualityGateResult = computeQualityGateResult(context.transcript, config);
    if (qualityGateResult && (config.qualityGate?.recordInTranscriptMetadata ?? true)) {
      context = updateTranscript(
        context,
        appendQualityGateRecord(context.transcript, qualityGateResult)
      );
    }
    if (qualityGateResult && !qualityGateResult.passed && config.failFast) {
      throw new OrchestratorConfigError(
        `Quality gate failed: score ${qualityGateResult.score} below threshold ${qualityGateResult.threshold}.`,
        "QUALITY_GATE_FAILED"
      );
    }

    const finalizedTranscript = finalizeTranscript(context.transcript, "completed", synthesisOutput);
    context = updateTranscript(context, finalizedTranscript);
    context = setRunStatus(context, "done");

    if (config.transcript.persistToFile) {
      const persisted = await persistTranscript({
        transcript: context.transcript,
        outputDir: config.transcript.outputDir,
        format: config.transcript.format
      });
      persistedPath = persisted.path;
    }

    return {
      context,
      persistedPath
    };
  } catch (error) {
    if (context) {
      try {
        if (!context.transcript.endedAt) {
          const failedTranscript = finalizeTranscript(context.transcript, "failed");
          context = updateTranscript(context, failedTranscript);
          if (context.status === "running" || context.status === "synthesizing") {
            context = setRunStatus(context, "failed");
          }

          if (config.transcript.persistToFile) {
            const persisted = await persistTranscript({
              transcript: context.transcript,
              outputDir: config.transcript.outputDir,
              format: config.transcript.format
            });
            persistedPath = persisted.path;
          }
        }
      } catch {
        // Best-effort finalization only.
      }
    }

    throw normalizeOrchestratorError(error);
  }
}
