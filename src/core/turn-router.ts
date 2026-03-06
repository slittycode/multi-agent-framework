import type { AgentId, ContextPolicyConfig, DomainAdapter, Message, MessageKind, Round, RoundPhase, Transcript } from "../types";
import type { Agent } from "../types/agent";
import type { RetrievedWebSource } from "../retrieval/retriever-client";
import type { ProviderGenerateRequest } from "../providers/provider-client";

export interface BuildTurnPromptInput {
  adapter: DomainAdapter;
  topic: string;
  round: Round;
  phase: RoundPhase;
  agent: Agent;
  transcript: Transcript;
  contextPolicy?: ContextPolicyConfig;
  citationsMode?: "transcript_only" | "optional_web";
  steeringDirectives?: string[];
  webEvidence?: RetrievedWebSource[];
}

export interface BuildProviderRequestInput extends BuildTurnPromptInput {
  runId: ProviderGenerateRequest["runId"];
  turnIndex: number;
  transcriptMessages?: Message[];
  metadata?: Record<string, unknown>;
}

export interface RenderTranscriptContextOptions {
  showMostRecentMarker?: boolean;
  includePhaseSummaries?: boolean;
}

export interface SelectContextMessagesInput {
  round: Round;
  messages: Message[];
  policy?: ContextPolicyConfig;
}

export interface NormalizedContextPolicy {
  mode: "full" | "round_plus_recent";
  recentMessageCount: number;
  includePhaseSummaries: boolean;
}

function capitalizeForDisplay(value: string): string {
  if (!value.trim()) {
    return value;
  }

  return value
    .split(/[\s_-]+/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function getPhaseByIds(
  adapter: DomainAdapter,
  roundId?: string,
  phaseId?: string
): RoundPhase | undefined {
  if (!roundId || !phaseId) {
    return undefined;
  }

  const round = adapter.rounds.find((candidate) => candidate.id === roundId);
  return round?.phases.find((candidate) => candidate.id === phaseId);
}

function summarizeContent(content: string, maxLength = 180): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function buildPhaseSummaryLines(adapter: DomainAdapter, messages: Message[]): string[] {
  if (messages.length === 0) {
    return [];
  }

  const roundLookup = new Map(adapter.rounds.map((round) => [round.id, round]));
  const lastMessageByPhase = new Map<string, Message>();

  for (const message of messages) {
    const phaseKey = `${message.roundId ?? "unspecified-round"}|${message.phaseId ?? "unspecified-phase"}`;
    lastMessageByPhase.set(phaseKey, message);
  }

  const lines = ["Phase Snapshots:"];
  for (const message of lastMessageByPhase.values()) {
    const round = message.roundId ? roundLookup.get(message.roundId) : undefined;
    const roundName = round?.name ?? "Unspecified";
    const phaseName =
      message.phaseId && round
        ? round.phases.find((phase) => phase.id === message.phaseId)?.name ?? message.phaseId
        : message.phaseId ?? "Unspecified";
    lines.push(`- ${phaseName} (${roundName}): ${summarizeContent(message.content)}`);
  }

  return lines;
}

function getSoftBrevityGuidance(phaseId: string): string {
  const normalizedPhase = phaseId.toLowerCase();
  if (normalizedPhase.includes("opening")) {
    return "Soft length target: 120-180 words.";
  }
  if (normalizedPhase.includes("challenge") || normalizedPhase.includes("rebuttal")) {
    return "Soft length target: 100-160 words.";
  }
  return "Soft length target: 100-180 words.";
}

export function normalizeContextPolicy(policy?: ContextPolicyConfig): NormalizedContextPolicy {
  return {
    mode: policy?.mode ?? "round_plus_recent",
    recentMessageCount: Math.max(1, policy?.recentMessageCount ?? 4),
    includePhaseSummaries: policy?.includePhaseSummaries ?? true
  };
}

export function selectContextMessages(input: SelectContextMessagesInput): Message[] {
  const policy = normalizeContextPolicy(input.policy);
  if (policy.mode === "full") {
    return [...input.messages];
  }

  const currentRoundMessages = input.messages.filter((message) => message.roundId === input.round.id);
  const crossRoundMessages = input.messages.filter((message) => message.roundId !== input.round.id);
  const recentCrossRoundMessages = crossRoundMessages.slice(-policy.recentMessageCount);
  const selectedIds = new Set(
    [...currentRoundMessages, ...recentCrossRoundMessages].map((message) => message.id)
  );

  return input.messages.filter((message) => selectedIds.has(message.id));
}

export function filterVisibleTranscriptForAgent(
  adapter: DomainAdapter,
  transcript: Transcript,
  receiverAgentId: AgentId
): Message[] {
  return transcript.messages.filter((message) => {
    if (message.from === "user" || message.from === "system" || message.from === "orchestrator") {
      return true;
    }

    const phase = getPhaseByIds(adapter, message.roundId, message.phaseId);
    const participants = phase?.visibilityPolicy?.participants;
    if (!participants || participants.length === 0) {
      return true;
    }

    // TODO: Split visibility policy into receiveFrom/publishTo for asymmetric routing.
    const receiverIsParticipant = participants.includes(receiverAgentId);
    if (!receiverIsParticipant) {
      return false;
    }

    return participants.includes(message.from);
  });
}

export function renderTranscriptContext(
  adapter: DomainAdapter,
  transcript: Transcript,
  options: RenderTranscriptContextOptions = {}
): string {
  if (transcript.messages.length === 0) {
    return "No prior discussion yet.";
  }

  const showMostRecentMarker = options.showMostRecentMarker ?? true;
  const includePhaseSummaries = options.includePhaseSummaries ?? true;
  const roundLookup = new Map(adapter.rounds.map((round) => [round.id, round]));
  const renderedLines: string[] = [];
  let previousRoundKey: string | undefined;

  transcript.messages.forEach((message, index) => {
    const roundKey = message.roundId ?? "__unspecified_round__";
    const round = message.roundId ? roundLookup.get(message.roundId) : undefined;
    const roundName = round?.name;
    const phaseName = message.phaseId
      ? round?.phases.find((phase) => phase.id === message.phaseId)?.name
      : undefined;

    if (roundKey !== previousRoundKey) {
      renderedLines.push(`--- Round: ${roundName ?? "Unspecified"} ---`);
      previousRoundKey = roundKey;
    }

    let phaseRoundLabel = "";
    if (phaseName && roundName) {
      phaseRoundLabel = ` (${phaseName} — ${roundName})`;
    } else if (phaseName) {
      phaseRoundLabel = ` (${phaseName})`;
    } else if (roundName) {
      phaseRoundLabel = ` (${roundName})`;
    }

    const isMostRecent = showMostRecentMarker && index === transcript.messages.length - 1;
    const mostRecentMarker = isMostRecent ? " ← most recent" : "";
    renderedLines.push(
      `[${message.turnIndex}] ${capitalizeForDisplay(message.from)}${phaseRoundLabel}: ${message.content}${mostRecentMarker}`
    );
  });

  if (includePhaseSummaries) {
    renderedLines.push("");
    renderedLines.push(...buildPhaseSummaryLines(adapter, transcript.messages));
  }

  return renderedLines.join("\n");
}

function buildTurnClosingInstruction(transcript: Transcript): string {
  const lastMessage = transcript.messages.at(-1);
  if (!lastMessage) {
    return "You are opening this phase. State your position clearly and directly. Be concise but substantive.";
  }

  const lastSpeakerName = capitalizeForDisplay(lastMessage.from);
  return `You are responding to ${lastSpeakerName}'s message above (marked ←). Engage with it directly — challenge, build on, or reframe it specifically. Do not simply restate your opening position.`;
}

export function inferMessageKind(phaseId: string): MessageKind {
  const normalized = phaseId.toLowerCase();
  if (normalized.includes("challenge")) {
    return "challenge";
  }

  if (normalized.includes("rebuttal")) {
    return "rebuttal";
  }

  return "agent_turn";
}

export function buildTurnPrompt(input: BuildTurnPromptInput): string {
  const normalizedContextPolicy = normalizeContextPolicy(input.contextPolicy);
  const citationsMode = input.citationsMode ?? "transcript_only";
  const transcriptContext = renderTranscriptContext(input.adapter, input.transcript, {
    includePhaseSummaries: normalizedContextPolicy.includePhaseSummaries
  });
  const closingInstruction = buildTurnClosingInstruction(input.transcript);
  const steeringLines = input.steeringDirectives?.filter((line) => line.trim().length > 0) ?? [];
  const webEvidence = input.webEvidence ?? [];
  const citationInstruction =
    citationsMode === "optional_web"
      ? "Citations: include transcript refs like [T2], [T5]. If using provided web evidence, cite as [W1], [W2]."
      : "Citations: include transcript refs like [T2], [T5].";

  return [
    `Adapter: ${input.adapter.name}`,
    `Topic: ${input.topic}`,
    `Round: ${input.round.name}`,
    `Phase: ${input.phase.name}`,
    `Phase Instructions: ${input.phase.instructions}`,
    `Context Mode: ${normalizedContextPolicy.mode}`,
    getSoftBrevityGuidance(input.phase.id),
    "",
    `Agent Name: ${input.agent.name}`,
    `Agent Role: ${input.agent.role}`,
    `Agent Persona: ${input.agent.persona}`,
    `Agent Objective: ${input.agent.objective ?? "N/A"}`,
    "",
    "Required response structure:",
    "1) Claim: your core position for this turn.",
    "2) Counterpoint/Rebuttal: directly engage the strongest competing claim.",
    "3) Evidence: concrete reasons, examples, or mechanisms supporting your argument.",
    `4) ${citationInstruction}`,
    ...(steeringLines.length > 0
      ? ["", "Steering Directives:", ...steeringLines.map((line) => `- ${line}`)]
      : []),
    ...(webEvidence.length > 0
      ? [
          "",
          "Optional Web Evidence:",
          ...webEvidence.map(
            (source, index) =>
              `[W${index + 1}] ${source.title} | ${source.url}${source.snippet ? ` | ${source.snippet}` : ""}`
          )
        ]
      : citationsMode === "optional_web"
        ? [
            "",
            "Optional Web Evidence:",
            "No web sources available for this turn. Use transcript citations only."
          ]
        : []),
    "",
    "Transcript So Far:",
    transcriptContext,
    "",
    closingInstruction
  ].join("\n");
}

export function buildProviderRequest(input: BuildProviderRequestInput): ProviderGenerateRequest {
  const citationsMode = input.citationsMode ?? "transcript_only";
  const visibleTranscriptMessages = input.transcriptMessages ?? input.transcript.messages;
  const contextualMessages = selectContextMessages({
    round: input.round,
    messages: visibleTranscriptMessages,
    policy: input.contextPolicy
  });
  const transcriptForPrompt: Transcript = {
    ...input.transcript,
    messages: contextualMessages
  };
  const contextPolicy = normalizeContextPolicy(input.contextPolicy);

  return {
    runId: input.runId,
    agent: input.agent,
    systemPrompt: input.agent.systemPrompt,
    prompt: buildTurnPrompt({
      adapter: input.adapter,
      topic: input.topic,
      round: input.round,
      phase: input.phase,
      agent: input.agent,
      transcript: transcriptForPrompt,
      contextPolicy,
      citationsMode,
      steeringDirectives: input.steeringDirectives,
      webEvidence: input.webEvidence
    }),
    transcript: contextualMessages,
    roundId: input.round.id,
    phaseId: input.phase.id,
    messageKind: inferMessageKind(input.phase.id),
    turnIndex: input.turnIndex,
    metadata: {
      adapterId: input.adapter.id,
      topic: input.topic,
      roundId: input.round.id,
      phaseId: input.phase.id,
      agentId: input.agent.id,
      contextPolicyMode: contextPolicy.mode,
      contextMessageCount: contextualMessages.length,
      citationsMode,
      webSourceCount: input.webEvidence?.length ?? 0,
      ...(input.metadata ?? {})
    }
  };
}
