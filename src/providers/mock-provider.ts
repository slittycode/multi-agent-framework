import type { MessageKind } from "../types/message";
import type { ProviderId } from "../types/provider";
import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "./provider-client";

const KEY_WILDCARD = "*";
const KEY_SEPARATOR = "::";
const DEFAULT_TOPIC = "the current topic";

interface MockDomainProfile {
  focusAreas: readonly string[];
  concerns: readonly string[];
  evidencePoints: readonly string[];
  outcomeSignals: readonly string[];
  summaryAngles: readonly string[];
}

const GENERAL_PROFILE: MockDomainProfile = {
  focusAreas: [
    "the decision criteria",
    "the operating constraints",
    "the rollout trade-offs",
    "the risk and learning loop"
  ],
  concerns: [
    "unowned execution details",
    "missing escalation paths",
    "assumptions that have not been tested",
    "unclear measures of success"
  ],
  evidencePoints: [
    "The prior turns already point to concrete operating constraints instead of abstract preferences",
    "Both sides are grounding their claims in execution mechanics rather than slogans",
    "The transcript shows where the practical friction will surface first"
  ],
  outcomeSignals: [
    "That makes the next decision easier to sequence and verify",
    "This keeps the recommendation tied to observable outcomes",
    "It turns the debate into an execution plan instead of a rhetorical summary"
  ],
  summaryAngles: [
    "agreement on what to operationalize first",
    "the unresolved risk that still needs ownership",
    "the highest-leverage next step"
  ]
};

const CREATIVE_WRITING_PROFILE: MockDomainProfile = {
  focusAreas: [
    "scene architecture and pacing",
    "voice consistency and sentence rhythm",
    "clarity of character motivation",
    "stakes and emotional escalation"
  ],
  concerns: [
    "blurred point of view",
    "a reveal that lands before tension has built",
    "revision notes that stay generic instead of page-level",
    "a conflict arc that resolves without enough pressure"
  ],
  evidencePoints: [
    "The transcript keeps returning to revision moves the writer can actually execute on the page",
    "The strongest comments connect language choices to reader comprehension and momentum",
    "The draft feedback is most persuasive when it ties voice decisions to scene function"
  ],
  outcomeSignals: [
    "That produces a clearer rewrite target for the next draft",
    "It gives the author a revision order instead of a pile of disconnected notes",
    "It preserves intent while narrowing the next rewrite pass"
  ],
  summaryAngles: [
    "where the draft is already compelling",
    "which revision pass should happen first",
    "the unresolved tension between voice and structure"
  ]
};

const ABLETON_PROFILE: MockDomainProfile = {
  focusAreas: [
    "low-end definition and groove clarity",
    "arrangement pacing and contrast",
    "space, tension, and release",
    "translation across sections and playback systems"
  ],
  concerns: [
    "masking in the low mids",
    "a drop that arrives without enough contrast",
    "energy that plateaus because transitions stay dense",
    "emotional payoff getting buried by technical clutter"
  ],
  evidencePoints: [
    "The prior turns keep linking emotional impact to concrete mix and arrangement moves",
    "The strongest arguments connect spacing decisions to how the hook or groove actually lands",
    "The transcript is already specific about where the track gains or loses momentum"
  ],
  outcomeSignals: [
    "That gives the producer an order of operations for the next session",
    "It keeps the feedback tied to audible changes instead of taste alone",
    "It turns broad critique into a repeatable production checklist"
  ],
  summaryAngles: [
    "what the mix should emphasize first",
    "where space creates payoff",
    "which section needs the clearest revision pass"
  ]
};

export interface MockResponseKeyParts {
  agentId?: string;
  roundId?: string;
  phaseId?: string;
  messageKind?: MessageKind;
  turnIndex?: number;
}

export interface MockProviderOptions {
  id?: ProviderId;
  defaultModel?: string;
  cannedResponses?: Record<string, string>;
}

export function buildMockResponseKey(parts: MockResponseKeyParts): string {
  return [
    parts.agentId ?? KEY_WILDCARD,
    parts.roundId ?? KEY_WILDCARD,
    parts.phaseId ?? KEY_WILDCARD,
    parts.messageKind ?? KEY_WILDCARD,
    parts.turnIndex?.toString() ?? KEY_WILDCARD
  ].join(KEY_SEPARATOR);
}

function stableHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function estimateTokenCount(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/u).length;
}

function pickDeterministic<T>(items: readonly T[], hash: number, offset = 0): T {
  return items[(hash + offset) % items.length] as T;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function getStringMetadata(request: ProviderGenerateRequest, key: string): string | undefined {
  const value = request.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getTopic(request: ProviderGenerateRequest): string {
  const metadataTopic = getStringMetadata(request, "topic");
  if (metadataTopic) {
    return metadataTopic;
  }

  const promptTopic = /^Topic:\s*(.+)$/imu.exec(request.prompt)?.[1]?.trim();
  return promptTopic && promptTopic.length > 0 ? promptTopic : DEFAULT_TOPIC;
}

function getAdapterId(request: ProviderGenerateRequest): string | undefined {
  return getStringMetadata(request, "adapterId");
}

function getDomainProfile(request: ProviderGenerateRequest, topic: string): MockDomainProfile {
  const adapterId = getAdapterId(request)?.toLowerCase();
  const normalizedTopic = topic.toLowerCase();

  if (
    adapterId === "creative-writing" ||
    /story|villain|fiction|character|draft|scene|writer/iu.test(normalizedTopic)
  ) {
    return CREATIVE_WRITING_PROFILE;
  }

  if (
    adapterId === "ableton-feedback" ||
    /track|producer|mix|arrangement|electronic|music|ableton|groove/iu.test(normalizedTopic)
  ) {
    return ABLETON_PROFILE;
  }

  return GENERAL_PROFILE;
}

function buildTranscriptRefs(request: ProviderGenerateRequest, limit = 2): string[] {
  return request.transcript
    .slice(-limit)
    .map((message) => `[T${message.turnIndex}]`);
}

function buildTopicFragment(topic: string): string {
  return normalizeWhitespace(topic.replace(/[?.!]+$/u, ""));
}

function buildAgentTurnFallback(
  request: ProviderGenerateRequest,
  hash: number,
  topic: string,
  profile: MockDomainProfile
): string {
  const refs = buildTranscriptRefs(request, 2);
  const latestMessage = request.transcript.at(-1);
  const latestRef = refs.at(-1);
  const phaseId = request.phaseId ?? request.messageKind ?? "turn";
  const phaseAction =
    phaseId === "challenge"
      ? "stress-test"
      : phaseId === "rebuttal"
        ? "tighten"
        : "frame";
  const focusArea = pickDeterministic(profile.focusAreas, hash);
  const concern = pickDeterministic(profile.concerns, hash, 1);
  const evidencePoint = pickDeterministic(profile.evidencePoints, hash, 2);
  const outcomeSignal = pickDeterministic(profile.outcomeSignals, hash, 3);
  const responseLead = latestMessage
    ? `${request.agent.name} uses ${latestMessage.from}'s earlier point`
    : `${request.agent.name} opens by centering`;
  const citationTail = latestRef ? ` ${latestRef}` : "";

  return [
    `Claim: ${responseLead} to ${phaseAction} ${focusArea} for ${buildTopicFragment(topic)}${citationTail}.`,
    `Counterpoint: The transcript still leaves ${concern} exposed, so the next reply should name the trade-off directly${latestRef ? ` and close the gap raised in ${latestRef}` : ""}.`,
    `Evidence: ${evidencePoint}. ${outcomeSignal}.`
  ].join("\n");
}

function buildJudgeFallback(
  request: ProviderGenerateRequest,
  hash: number,
  topic: string,
  profile: MockDomainProfile
): string {
  const refs = buildTranscriptRefs(request, 2);
  const latestRef = refs.at(-1);
  const score = 62 + (hash % 15);
  const rationale = `The discussion is progressing, but ${pickDeterministic(
    profile.concerns,
    hash
  )} still needs to be resolved before a final answer is trustworthy${latestRef ? ` ${latestRef}` : ""}.`;

  return JSON.stringify({
    finished: false,
    rationale,
    score,
    rubric: {
      specificity: score + 4,
      rebuttalQuality: score - 1,
      evidenceQuality: score + 2,
      synthesisUtility: score + 3
    },
    steeringDirectives: [
      `Name the highest-risk assumption for ${buildTopicFragment(topic)} and tie it to a concrete mitigation.`,
      `Convert the next turn into a sharper decision point around ${pickDeterministic(profile.focusAreas, hash, 1)}${latestRef ? ` with explicit reference to ${latestRef}` : ""}.`
    ]
  });
}

function buildSynthesisFallback(
  request: ProviderGenerateRequest,
  hash: number,
  topic: string,
  profile: MockDomainProfile
): string {
  const refs = buildTranscriptRefs(request, 3);
  const firstRef = refs[0];
  const secondRef = refs[1] ?? firstRef;
  const lastRef = refs.at(-1) ?? secondRef;
  const focusArea = pickDeterministic(profile.focusAreas, hash);
  const concern = pickDeterministic(profile.concerns, hash, 1);
  const evidencePoint = pickDeterministic(profile.evidencePoints, hash, 2);
  const outcomeSignal = pickDeterministic(profile.outcomeSignals, hash, 3);
  const summaryAngle = pickDeterministic(profile.summaryAngles, hash, 4);
  const topicFragment = buildTopicFragment(topic);

  return JSON.stringify({
    summary: [
      `The discussion converged on ${focusArea} as the main lever for ${topicFragment}, with the strongest supporting evidence surfacing in ${firstRef ?? "[T1]"} and ${secondRef ?? "[T2]"}.`,
      `${evidencePoint}, so the synthesis prioritizes ${summaryAngle} over broad restatement.`,
      `The remaining disagreement is about ${concern}, which should be handled explicitly before the team scales the recommendation${lastRef ? ` ${lastRef}` : ""}.`
    ].join(" "),
    verdict: `Proceed with a concrete plan for ${topicFragment}, but treat ${concern} as the gating risk and verify it against the transcript evidence${lastRef ? ` ${lastRef}` : ""}.`,
    recommendations: [
      {
        text: `Define the first operating move around ${focusArea} and document who owns ${concern} before the next review${firstRef ? ` ${firstRef}` : ""}.`,
        priority: "high"
      },
      {
        text: `Review the strongest evidence from the discussion and translate it into one measurable checkpoint for ${topicFragment}${secondRef ? ` ${secondRef}` : ""}.`,
        priority: "high"
      },
      {
        text: `Track whether the next iteration actually improves ${summaryAngle}; if it does not, update the plan and re-evaluate the trade-off${lastRef ? ` ${lastRef}` : ""}.`,
        priority: "medium"
      }
    ]
  });
}

export class MockProvider implements ProviderClient {
  readonly id: ProviderId;
  private readonly defaultModel: string;
  private readonly cannedResponses = new Map<string, string>();

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? "mock";
    this.defaultModel = options.defaultModel ?? "mock-model-v1";
    if (options.cannedResponses) {
      for (const [key, content] of Object.entries(options.cannedResponses)) {
        this.cannedResponses.set(key, content);
      }
    }
  }

  setResponse(key: string, content: string): void {
    this.cannedResponses.set(key, content);
  }

  clearResponses(): void {
    this.cannedResponses.clear();
  }

  async generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    const startedAt = performance.now();
    const matched = this.resolveCannedResponse(request);
    const content = matched?.content ?? this.createDeterministicFallback(request);
    const latencyMs = Math.round(performance.now() - startedAt);
    const model = request.agent.llm?.model ?? this.defaultModel;
    const invocationSeed = [
      request.runId,
      request.agent.id,
      request.roundId ?? "",
      request.phaseId ?? "",
      request.turnIndex?.toString() ?? "",
      content
    ].join("|");
    const invocationId = `mock-inv-${stableHash(invocationSeed).toString(16).padStart(8, "0")}`;

    return {
      content,
      provider: this.id,
      model,
      invocationId,
      usage: {
        inputTokens: estimateTokenCount(request.prompt),
        outputTokens: estimateTokenCount(content),
        latencyMs
      },
      raw: {
        source: matched ? "canned" : "generated",
        matchedKey: matched?.key
      }
    };
  }

  private resolveCannedResponse(
    request: ProviderGenerateRequest
  ): { key: string; content: string } | undefined {
    const keyCandidates = this.buildLookupKeys(request);
    for (const key of keyCandidates) {
      const content = this.cannedResponses.get(key);
      if (content !== undefined) {
        return { key, content };
      }
    }
    return undefined;
  }

  private buildLookupKeys(request: ProviderGenerateRequest): string[] {
    const parts: MockResponseKeyParts = {
      agentId: request.agent.id,
      roundId: request.roundId,
      phaseId: request.phaseId,
      messageKind: request.messageKind,
      turnIndex: request.turnIndex
    };

    const roundCandidates = [parts.roundId, undefined];
    const phaseCandidates = [parts.phaseId, undefined];
    const messageKindCandidates = [parts.messageKind, undefined];
    const turnIndexCandidates = [parts.turnIndex, undefined];

    const scoredKeys: { key: string; score: number }[] = [];

    for (const roundId of roundCandidates) {
      for (const phaseId of phaseCandidates) {
        for (const messageKind of messageKindCandidates) {
          for (const turnIndex of turnIndexCandidates) {
            const key = buildMockResponseKey({
              agentId: parts.agentId,
              roundId,
              phaseId,
              messageKind,
              turnIndex
            });

            const score =
              (roundId === undefined ? 1 : 0) +
              (phaseId === undefined ? 1 : 0) +
              (messageKind === undefined ? 1 : 0) +
              (turnIndex === undefined ? 1 : 0);

            scoredKeys.push({ key, score });
          }
        }
      }
    }

    scoredKeys.sort((left, right) => left.score - right.score);

    const keys = [...new Set(scoredKeys.map((item) => item.key))];

    keys.push(buildMockResponseKey({}));

    return keys;
  }

  private createDeterministicFallback(request: ProviderGenerateRequest): string {
    const transcriptTail = request.transcript.at(-1)?.content ?? "";
    const seedSource = [
      request.runId,
      request.agent.id,
      request.roundId ?? "",
      request.phaseId ?? "",
      request.messageKind ?? "",
      request.turnIndex?.toString() ?? "",
      request.prompt,
      transcriptTail
    ].join("|");

    const hash = stableHash(seedSource);
    const topic = getTopic(request);
    const profile = getDomainProfile(request, topic);

    if (request.phaseId === "judge") {
      return buildJudgeFallback(request, hash, topic, profile);
    }

    if (request.phaseId === "synthesis" || request.messageKind === "synthesis") {
      return buildSynthesisFallback(request, hash, topic, profile);
    }

    return buildAgentTurnFallback(request, hash, topic, profile);
  }
}
