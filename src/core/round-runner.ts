import type {
  DomainAdapter,
  JudgePhaseRecord,
  Message,
  Round,
  RoundPhase,
  RunContext
} from "../types";
import type { RetrievedWebSource, RetrieverClient } from "../retrieval/retriever-client";
import type { ProviderRegistry } from "../providers/provider-registry";
import { appendMessage } from "../transcript/transcript-store";
import { advancePhase, updateTranscript } from "./run-context";
import { runJudgeCheck } from "./judge-runner";
import { buildProviderRequest, filterVisibleTranscriptForAgent, inferMessageKind } from "./turn-router";
import { OrchestratorIntegrationError } from "./errors";

type AdapterAgent = DomainAdapter["agents"][number];

export interface RunRoundDependencies {
  adapter: DomainAdapter;
  topic: string;
  providerRegistry: ProviderRegistry;
  retriever?: RetrieverClient;
  onMessage?: (message: Message) => void;
}

function getPhaseAgent(adapter: DomainAdapter, phase: RoundPhase, agentId: string): AdapterAgent {
  const agent = adapter.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new OrchestratorIntegrationError(
      "runtime",
      "UNKNOWN_TURN_ORDER_AGENT",
      `Phase "${phase.id}" references unknown agent "${agentId}".`
    );
  }

  return agent;
}

function buildAgentTurnMessage(input: {
  runId: string;
  roundId: string;
  phaseId: string;
  turnIndex: number;
  agent: AdapterAgent;
  content: string;
  provider: string;
  model: string;
  usage?: Message["usage"];
  providerInvocationId?: string;
  respondingToMessageId?: string;
  metadata?: Record<string, unknown>;
}): Message {
  return {
    id: crypto.randomUUID(),
    runId: input.runId,
    roundId: input.roundId,
    phaseId: input.phaseId,
    turnIndex: input.turnIndex,
    timestamp: new Date().toISOString(),
    from: input.agent.id,
    to: "all",
    kind: inferMessageKind(input.phaseId),
    content: input.content,
    respondingToMessageId: input.respondingToMessageId,
    provider: input.provider,
    model: input.model,
    providerInvocationId: input.providerInvocationId,
    usage: input.usage,
    metadata: input.metadata
  };
}

function buildFanoutErrorMessage(input: {
  runId: string;
  roundId: string;
  phaseId: string;
  turnIndex: number;
  agentId: string;
  respondingToMessageId?: string;
  errorMessage: string;
}): Message {
  return {
    id: crypto.randomUUID(),
    runId: input.runId,
    roundId: input.roundId,
    phaseId: input.phaseId,
    turnIndex: input.turnIndex,
    timestamp: new Date().toISOString(),
    from: "orchestrator",
    to: input.agentId,
    kind: "error",
    content: `Fanout phase "${input.phaseId}" failed for agent "${input.agentId}": ${input.errorMessage}`,
    respondingToMessageId: input.respondingToMessageId,
    metadata: {
      source: "runtime",
      code: "FANOUT_AGENT_ERROR",
      agentId: input.agentId
    }
  };
}

function getErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }

  if (typeof reason === "string") {
    return reason;
  }

  return "Unknown fanout error.";
}

function appendJudgePhaseRecord(
  transcript: RunContext["transcript"],
  record: JudgePhaseRecord
): RunContext["transcript"] {
  const existingJudgePhases = Array.isArray(transcript.metadata?.judgePhases)
    ? (transcript.metadata.judgePhases as JudgePhaseRecord[])
    : undefined;

  return {
    ...transcript,
    metadata: {
      ...(transcript.metadata ?? {}),
      judgePhases: existingJudgePhases
        ? [...existingJudgePhases, record]
        : [record]
    }
  };
}

function extractTranscriptRefs(content: string): { turnIndex: number; reason?: string }[] | undefined {
  const matches = [...content.matchAll(/\[T(\d+)\]/giu)];
  if (matches.length === 0) {
    return undefined;
  }

  const seen = new Set<number>();
  const refs: { turnIndex: number; reason?: string }[] = [];
  for (const match of matches) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isNaN(parsed) || seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    refs.push({ turnIndex: parsed });
  }

  return refs.length > 0 ? refs : undefined;
}

function extractWebRefs(
  content: string,
  webEvidence: RetrievedWebSource[]
): { title: string; url: string; snippet?: string }[] | undefined {
  const matches = [...content.matchAll(/\[W(\d+)\]/giu)];
  if (matches.length === 0) {
    return undefined;
  }

  const seen = new Set<number>();
  const refs: { title: string; url: string; snippet?: string }[] = [];
  for (const match of matches) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isNaN(parsed) || seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    const source = webEvidence[parsed - 1];
    if (!source) {
      continue;
    }
    refs.push({
      title: source.title,
      url: source.url,
      snippet: source.snippet
    });
  }

  return refs.length > 0 ? refs : undefined;
}

function buildCitationMetadata(
  content: string,
  webEvidence: RetrievedWebSource[],
  retrievalWarning?: string
): Record<string, unknown> | undefined {
  const transcriptRefs = extractTranscriptRefs(content);
  const webRefs = extractWebRefs(content, webEvidence);
  const citations =
    transcriptRefs || webRefs
      ? {
          citations: {
            transcriptRefs,
            webRefs
          }
        }
      : undefined;

  if (!citations && !retrievalWarning) {
    return undefined;
  }

  return {
    ...(citations ?? {}),
    ...(retrievalWarning ? { retrievalWarning } : {})
  };
}

async function resolveWebEvidenceForTurn(input: {
  context: RunContext;
  round: Round;
  phase: RoundPhase;
  agent: AdapterAgent;
  deps: RunRoundDependencies;
}): Promise<{ sources: RetrievedWebSource[]; warning?: string }> {
  const citationsMode = input.context.config.citations?.mode ?? "transcript_only";
  if (citationsMode !== "optional_web") {
    return { sources: [] };
  }

  const retriever = input.deps.retriever;
  if (!retriever) {
    return {
      sources: [],
      warning:
        "Web retrieval requested but no retriever is configured; falling back to transcript-only citations."
    };
  }

  try {
    return await retriever.retrieve({
      topic: input.deps.topic,
      roundName: input.round.name,
      phaseName: input.phase.name,
      agentName: input.agent.name,
      maxSources: input.context.config.citations?.maxWebSourcesPerTurn ?? 2
    });
  } catch (error) {
    const failPolicy = input.context.config.citations?.failPolicy ?? "graceful_fallback";
    if (failPolicy === "fail_fast") {
      throw error;
    }

    return {
      sources: [],
      warning: `Web retrieval failed: ${getErrorMessage(error)}`
    };
  }
}

async function runSequentialPhase(
  context: RunContext,
  round: Round,
  phase: RoundPhase,
  deps: RunRoundDependencies,
  steeringDirectives: string[]
): Promise<RunContext> {
  let nextContext = context;

  for (const agentId of phase.turnOrder) {
    const agent = getPhaseAgent(deps.adapter, phase, agentId);
    const turnIndex = nextContext.transcript.messages.length + 1;
    const visibleMessages = filterVisibleTranscriptForAgent(
      deps.adapter,
      nextContext.transcript,
      agent.id
    );
    const webEvidenceResult = await resolveWebEvidenceForTurn({
      context: nextContext,
      round,
      phase,
      agent,
      deps
    });

    const request = buildProviderRequest({
      runId: nextContext.runId,
      adapter: deps.adapter,
      topic: deps.topic,
      round,
      phase,
      agent,
      transcript: nextContext.transcript,
      transcriptMessages: visibleMessages,
      contextPolicy: nextContext.config.contextPolicy,
      citationsMode: nextContext.config.citations?.mode ?? "transcript_only",
      steeringDirectives,
      webEvidence: webEvidenceResult.sources,
      turnIndex
    });

    const provider = deps.providerRegistry.resolveForAgent(agent);
    const result = await provider.generate(request);
    const citationMetadata = buildCitationMetadata(
      result.content,
      webEvidenceResult.sources,
      webEvidenceResult.warning
    );

    const previousMessage = nextContext.transcript.messages.at(-1);
    const message = buildAgentTurnMessage({
      runId: nextContext.runId,
      roundId: round.id,
      phaseId: phase.id,
      turnIndex,
      agent,
      content: result.content,
      respondingToMessageId: previousMessage?.id,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      providerInvocationId: result.invocationId,
      metadata: citationMetadata
    });

    const updatedTranscript = appendMessage(nextContext.transcript, message);
    nextContext = updateTranscript(nextContext, updatedTranscript);
    deps.onMessage?.(message);
  }

  return nextContext;
}

async function runFanoutPhase(
  context: RunContext,
  round: Round,
  phase: RoundPhase,
  deps: RunRoundDependencies,
  steeringDirectives: string[]
): Promise<RunContext> {
  const failFast = context.config.failFast ?? false;
  const transcriptSnapshot = context.transcript;
  const baseTurnIndex = transcriptSnapshot.messages.length + 1;
  const respondedToMessageId = transcriptSnapshot.messages.at(-1)?.id;

  const plannedTurns = await Promise.all(
    phase.turnOrder.map(async (agentId, index) => {
    const agent = getPhaseAgent(deps.adapter, phase, agentId);
    const turnIndex = baseTurnIndex + index;
    const visibleMessages = filterVisibleTranscriptForAgent(
      deps.adapter,
      transcriptSnapshot,
      agent.id
    );
      const webEvidenceResult = await resolveWebEvidenceForTurn({
        context,
        round,
        phase,
        agent,
        deps
      });

    const request = buildProviderRequest({
      runId: context.runId,
      adapter: deps.adapter,
      topic: deps.topic,
      round,
      phase,
      agent,
      transcript: transcriptSnapshot,
      transcriptMessages: visibleMessages,
      contextPolicy: context.config.contextPolicy,
      citationsMode: context.config.citations?.mode ?? "transcript_only",
      steeringDirectives,
      webEvidence: webEvidenceResult.sources,
      turnIndex
    });

    const provider = deps.providerRegistry.resolveForAgent(agent);
    return {
      index,
      agent,
      turnIndex,
        webEvidenceResult,
      run: provider.generate(request)
    };
    })
  );

  const settled = await Promise.allSettled(plannedTurns.map((turn) => turn.run));

  if (failFast) {
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      throw rejected.reason instanceof Error
        ? rejected.reason
        : new Error(getErrorMessage(rejected.reason));
    }
  }

  const phaseMessages: Message[] = [];

  for (const turn of plannedTurns) {
    const result = settled[turn.index];
    if (!result) {
      continue;
    }

    if (result.status === "fulfilled") {
      const citationMetadata = buildCitationMetadata(
        result.value.content,
        turn.webEvidenceResult.sources,
        turn.webEvidenceResult.warning
      );
      phaseMessages.push(
        buildAgentTurnMessage({
          runId: context.runId,
          roundId: round.id,
          phaseId: phase.id,
          turnIndex: turn.turnIndex,
          agent: turn.agent,
          content: result.value.content,
          respondingToMessageId: respondedToMessageId,
          provider: result.value.provider,
          model: result.value.model,
          usage: result.value.usage,
          providerInvocationId: result.value.invocationId,
          metadata: citationMetadata
        })
      );
      continue;
    }

    if (!failFast) {
      phaseMessages.push(
        buildFanoutErrorMessage({
          runId: context.runId,
          roundId: round.id,
          phaseId: phase.id,
          turnIndex: turn.turnIndex,
          agentId: turn.agent.id,
          respondingToMessageId: respondedToMessageId,
          errorMessage: getErrorMessage(result.reason)
        })
      );
    }
  }

  let nextContext = context;
  for (const message of phaseMessages) {
    const updatedTranscript = appendMessage(nextContext.transcript, message);
    nextContext = updateTranscript(nextContext, updatedTranscript);
    deps.onMessage?.(message);
  }

  return nextContext;
}

export async function runRound(
  context: RunContext,
  round: Round,
  deps: RunRoundDependencies
): Promise<RunContext> {
  let nextContext = context;
  let steeringDirectives: string[] = [];

  for (let phaseIndex = 0; phaseIndex < round.phases.length; phaseIndex += 1) {
    const phase = round.phases[phaseIndex];
    if (!phase) {
      throw new OrchestratorIntegrationError(
        "runtime",
        "INVALID_PHASE_CONFIGURATION",
        `Round \"${round.id}\" contains undefined phase at index ${phaseIndex}.`
      );
    }

    nextContext = {
      ...nextContext,
      currentPhaseIndex: phaseIndex
    };

    if (phase.executionMode === "fanout") {
      nextContext = await runFanoutPhase(nextContext, round, phase, deps, steeringDirectives);
    } else {
      nextContext = await runSequentialPhase(nextContext, round, phase, deps, steeringDirectives);
    }

    const phaseJudge = nextContext.config.phaseJudge;
    if (phaseJudge?.enabled && phaseJudge.cadence === "after_each_phase") {
      try {
        const judgeResult = await runJudgeCheck({
          context: nextContext,
          round,
          phase,
          providerRegistry: deps.providerRegistry,
          judge: {
            agentId: phaseJudge.agentId,
            promptTemplate: phaseJudge.promptTemplate
          }
        });
        const phaseJudgeRecord: JudgePhaseRecord = {
          ...judgeResult.record,
          phaseId: judgeResult.record.phaseId ?? phase.id,
          phaseName: judgeResult.record.phaseName ?? phase.name
        };

        nextContext = updateTranscript(
          nextContext,
          appendJudgePhaseRecord(nextContext.transcript, phaseJudgeRecord)
        );
        steeringDirectives = judgeResult.decision.steeringDirectives ?? [];
      } catch (judgeError) {
        if (nextContext.config.failFast) {
          throw judgeError;
        }

        steeringDirectives = [];
        const fallbackJudgePhaseRecord: JudgePhaseRecord = {
          roundId: round.id,
          roundName: round.name,
          phaseId: phase.id,
          phaseName: phase.name,
          timestamp: new Date().toISOString(),
          decision: {
            finished: false,
            rationale: `phase judge failed: ${getErrorMessage(judgeError)}`
          }
        };
        nextContext = updateTranscript(
          nextContext,
          appendJudgePhaseRecord(nextContext.transcript, fallbackJudgePhaseRecord)
        );
      }
    }

    if (phaseIndex < round.phases.length - 1) {
      nextContext = advancePhase(nextContext);
    }
  }

  return nextContext;
}
