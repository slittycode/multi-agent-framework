import type { MessageKind } from "../types/message";
import type { ProviderId } from "../types/provider";
import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "./provider-client";

const KEY_WILDCARD = "*";
const KEY_SEPARATOR = "::";
const DEFAULT_TOPIC = "the current topic";

type MockTurnMode = "measured" | "questioning" | "compressed";
type MockVerdictMode = "firm" | "soft" | "omit";
type MockSummaryMode = "balanced" | "partial" | "open";
type MockOverlapMode = "none" | "light" | "strong";

interface MockWeaknessProfile {
  id: string;
  turnMode: MockTurnMode;
  includeTurnCitation: boolean;
  verdictMode: MockVerdictMode;
  summaryMode: MockSummaryMode;
  recommendationOverlap: MockOverlapMode;
  prioritizedRecommendationCount: 0 | 1 | 2 | 3;
  actionableRecommendationCount: 0 | 1 | 2 | 3;
  citationBudget: 0 | 1;
  judgeDirectiveCount: 0 | 1;
  judgeBaseScore: number;
}

interface MockDomainProfile {
  adapterId: "general-debate" | "creative-writing" | "ableton-feedback";
  turnFocusAreas: readonly string[];
  turnObservations: readonly string[];
  turnConcerns: readonly string[];
  turnNudges: readonly string[];
  synthesisFrames: readonly string[];
  synthesisLessons: readonly string[];
  synthesisRisks: readonly string[];
  recommendationTargets: readonly string[];
  actionOpeners: readonly string[];
  softOpeners: readonly string[];
  variants: readonly MockWeaknessProfile[];
}

const GENERAL_PROFILE: MockDomainProfile = {
  adapterId: "general-debate",
  turnFocusAreas: [
    "the working decision rule",
    "the rollout boundary",
    "the accountability check",
    "the operating trade-off"
  ],
  turnObservations: [
    "the last turn names a workable condition instead of a slogan",
    "the argument gets more useful once it narrows to operating choices",
    "the exchange is strongest when it stops arguing preferences and starts naming constraints"
  ],
  turnConcerns: [
    "ownership is still diffuse",
    "the exception path is missing",
    "the success signal is still vague",
    "the trade-off is only implied"
  ],
  turnNudges: [
    "The next reply should narrow the scope instead of broadening the claim.",
    "The next turn needs one concrete checkpoint, not a broader defense.",
    "A tighter answer would name who carries the risk if the plan slips."
  ],
  synthesisFrames: [
    "a workable default",
    "the first decision checkpoint",
    "the narrowest useful policy",
    "a review boundary the team can actually use"
  ],
  synthesisLessons: [
    "The useful part of the transcript is the shape of the choice, not a complete operating plan",
    "It reads more like a decent briefing than a settled recommendation",
    "The discussion is actionable only once someone turns the preferred direction into a named checkpoint"
  ],
  synthesisRisks: [
    "edge cases are still unowned",
    "the measurement plan is still thin",
    "the fallback path is still underspecified",
    "the success criteria still blur together"
  ],
  recommendationTargets: [
    "the rollout check",
    "the decision log",
    "the exception path",
    "the success measure"
  ],
  actionOpeners: ["Define", "Document", "Review", "Track"],
  softOpeners: ["Keep", "Use", "Carry", "Watch"],
  variants: [
    {
      id: "debate-balanced",
      turnMode: "measured",
      includeTurnCitation: true,
      verdictMode: "soft",
      summaryMode: "balanced",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 2,
      actionableRecommendationCount: 1,
      citationBudget: 1,
      judgeDirectiveCount: 1,
      judgeBaseScore: 61
    },
    {
      id: "debate-open",
      turnMode: "questioning",
      includeTurnCitation: false,
      verdictMode: "omit",
      summaryMode: "open",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 2,
      actionableRecommendationCount: 1,
      citationBudget: 0,
      judgeDirectiveCount: 1,
      judgeBaseScore: 58
    },
    {
      id: "debate-soft-checkpoint",
      turnMode: "measured",
      includeTurnCitation: false,
      verdictMode: "soft",
      summaryMode: "partial",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 2,
      actionableRecommendationCount: 1,
      citationBudget: 0,
      judgeDirectiveCount: 1,
      judgeBaseScore: 60
    }
  ]
};

const CREATIVE_WRITING_PROFILE: MockDomainProfile = {
  adapterId: "creative-writing",
  turnFocusAreas: [
    "the pressure inside the scene",
    "the motive line",
    "the pacing of the reveal",
    "the voice on the page"
  ],
  turnObservations: [
    "the note lands best when it points to a line-level revision",
    "the discussion gets clearer when it separates reader effect from author intent",
    "the strongest critique is the part that identifies where the page loses pressure"
  ],
  turnConcerns: [
    "the revision target is still too broad",
    "the emotional turn arrives before the pressure builds",
    "point of view slips in the middle",
    "the draft explains instead of dramatising"
  ],
  turnNudges: [
    "The next reply should point to one rewrite move instead of a general reminder.",
    "A sharper answer would choose whether voice or structure gets revised first.",
    "The next turn should protect what is already working instead of rewriting everything."
  ],
  synthesisFrames: [
    "the next revision pass",
    "the clearest reader signal",
    "the part of the draft worth preserving",
    "the narrowest rewrite target"
  ],
  synthesisLessons: [
    "The transcript is useful as revision guidance, not as a full editorial diagnosis",
    "It identifies where the draft wobbles, but not every note is equally actionable on the page",
    "The discussion settles direction better than it settles sequence"
  ],
  synthesisRisks: [
    "the rewrite could flatten the voice",
    "the scene order is still doing too much work",
    "the conflict remains under-pressured",
    "the reader payoff is still delayed"
  ],
  recommendationTargets: [
    "the opening page",
    "the reveal scene",
    "the point-of-view handoff",
    "the order of revision passes"
  ],
  actionOpeners: ["Review", "Track", "Document"],
  softOpeners: ["Keep", "Let", "Use", "Carry"],
  variants: [
    {
      id: "revision-notes",
      turnMode: "compressed",
      includeTurnCitation: false,
      verdictMode: "omit",
      summaryMode: "partial",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 1,
      actionableRecommendationCount: 0,
      citationBudget: 0,
      judgeDirectiveCount: 1,
      judgeBaseScore: 57
    },
    {
      id: "voice-structure-split",
      turnMode: "questioning",
      includeTurnCitation: false,
      verdictMode: "soft",
      summaryMode: "balanced",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 2,
      actionableRecommendationCount: 0,
      citationBudget: 0,
      judgeDirectiveCount: 1,
      judgeBaseScore: 58
    },
    {
      id: "page-level-pass",
      turnMode: "measured",
      includeTurnCitation: false,
      verdictMode: "soft",
      summaryMode: "partial",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 2,
      actionableRecommendationCount: 2,
      citationBudget: 0,
      judgeDirectiveCount: 1,
      judgeBaseScore: 59
    }
  ]
};

const ABLETON_PROFILE: MockDomainProfile = {
  adapterId: "ableton-feedback",
  turnFocusAreas: [
    "the front-to-back energy curve",
    "the low-mid pocket",
    "the moment before the payoff",
    "the contrast between sections"
  ],
  turnObservations: [
    "the feedback is most convincing when it points to where the section loses lift",
    "the session notes get useful once they separate feel from engineering detail",
    "the strongest comments describe what changes in momentum, not just what sounds dense"
  ],
  turnConcerns: [
    "the chorus still arrives without enough contrast",
    "the low mids are doing too much of the work",
    "the arrangement keeps the same density for too long",
    "the emotional payoff is described more than located"
  ],
  turnNudges: [
    "The next reply should isolate one section before suggesting a full-session rewrite.",
    "A tighter answer would choose whether the problem is momentum or masking.",
    "The next turn needs one audible checkpoint instead of another broad taste statement."
  ],
  synthesisFrames: [
    "the next session priority",
    "the clearest energy checkpoint",
    "the smallest change that could open the track up",
    "the part of the arrangement that wants another pass"
  ],
  synthesisLessons: [
    "The discussion sounds like usable session notes, but it does not fully settle order of operations",
    "It captures what feels off more clearly than it proves why it is off",
    "The transcript identifies the pressure point, but not a complete production strategy"
  ],
  synthesisRisks: [
    "the fix could trade punch for space",
    "the transition problem is still loosely described",
    "the next pass could over-correct the groove",
    "the mix notes still overlap with arrangement notes"
  ],
  recommendationTargets: [
    "the intro-to-drop handoff",
    "the low-mid cleanup",
    "the contrast before the hook",
    "the first fifteen seconds after the payoff"
  ],
  actionOpeners: ["Review", "Track", "Measure"],
  softOpeners: ["Keep", "Use", "Try", "Watch"],
  variants: [
    {
      id: "session-notes",
      turnMode: "compressed",
      includeTurnCitation: false,
      verdictMode: "omit",
      summaryMode: "partial",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 0,
      actionableRecommendationCount: 0,
      citationBudget: 0,
      judgeDirectiveCount: 0,
      judgeBaseScore: 55
    },
    {
      id: "mix-pass",
      turnMode: "questioning",
      includeTurnCitation: false,
      verdictMode: "omit",
      summaryMode: "open",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 0,
      actionableRecommendationCount: 0,
      citationBudget: 0,
      judgeDirectiveCount: 1,
      judgeBaseScore: 56
    },
    {
      id: "arrangement-pass",
      turnMode: "measured",
      includeTurnCitation: false,
      verdictMode: "soft",
      summaryMode: "partial",
      recommendationOverlap: "strong",
      prioritizedRecommendationCount: 1,
      actionableRecommendationCount: 0,
      citationBudget: 0,
      judgeDirectiveCount: 1,
      judgeBaseScore: 57
    }
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
  return request.transcript.slice(-limit).map((message) => `[T${message.turnIndex}]`);
}

function buildTopicFragment(topic: string): string {
  return normalizeWhitespace(topic.replace(/[?.!]+$/u, ""));
}

function getScenarioHash(request: ProviderGenerateRequest, topic: string): number {
  return stableHash([getAdapterId(request) ?? "unknown", topic].join("|"));
}

function getWeaknessProfile(profile: MockDomainProfile, scenarioHash: number): MockWeaknessProfile {
  return pickDeterministic(profile.variants, scenarioHash);
}

function appendRefIfNeeded(value: string, ref: string | undefined, includeRef: boolean): string {
  return includeRef && ref ? `${value} ${ref}` : value;
}

function buildAgentTurnFallback(
  request: ProviderGenerateRequest,
  hash: number,
  topic: string,
  profile: MockDomainProfile,
  weakness: MockWeaknessProfile
): string {
  const refs = buildTranscriptRefs(request, 2);
  const latestMessage = request.transcript.at(-1);
  const latestRef = refs.at(-1);
  const topicFragment = buildTopicFragment(topic);
  const focusArea = pickDeterministic(profile.turnFocusAreas, hash);
  const observation = pickDeterministic(profile.turnObservations, hash, 1);
  const concern = pickDeterministic(profile.turnConcerns, hash, 2);
  const nudge = pickDeterministic(profile.turnNudges, hash, 3);
  const phaseId = request.phaseId ?? request.messageKind ?? "turn";
  const citeTurn = weakness.includeTurnCitation && phaseId !== "opening";
  const leadRef = citeTurn ? latestRef : undefined;

  let firstSentence: string;
  let secondSentence: string | undefined;

  if (phaseId === "challenge") {
    firstSentence = appendRefIfNeeded(
      `${request.agent.name} pushes on ${concern} and says the last turn reaches for ${focusArea} before it proves it`,
      leadRef,
      true
    );
    secondSentence =
      weakness.turnMode === "compressed"
        ? "That leaves the critique directionally right but still under-argued."
        : nudge;
  } else if (phaseId === "rebuttal") {
    firstSentence = appendRefIfNeeded(
      `${request.agent.name} narrows the point to ${focusArea}, arguing that ${observation.toLowerCase()}`,
      leadRef,
      true
    );
    secondSentence =
      weakness.turnMode === "questioning"
        ? `It still does not fully answer why ${concern}.`
        : `The reply is more usable now, although ${concern}.`;
  } else {
    const latestSpeaker = latestMessage ? latestMessage.from : "the topic";
    firstSentence = appendRefIfNeeded(
      `${request.agent.name} opens on ${focusArea} for ${topicFragment} and takes ${latestSpeaker === "the topic" ? "the prompt" : latestSpeaker}'s framing as a starting point`,
      leadRef,
      true
    );
    secondSentence =
      weakness.turnMode === "compressed"
        ? `${observation}.`
        : `${observation}. ${concern.charAt(0).toUpperCase() + concern.slice(1)}.`;
  }

  return normalizeWhitespace([`${firstSentence}.`, secondSentence].filter(Boolean).join(" "));
}

function buildJudgeFallback(
  request: ProviderGenerateRequest,
  hash: number,
  topic: string,
  profile: MockDomainProfile,
  weakness: MockWeaknessProfile
): string {
  const refs = buildTranscriptRefs(request, 2);
  const latestRef = refs.at(-1);
  const rationale = appendRefIfNeeded(
    `The round is useful, but ${pickDeterministic(profile.turnConcerns, hash)} still blocks a confident synthesis`,
    latestRef,
    Boolean(latestRef)
  );
  const score = weakness.judgeBaseScore + (hash % 6);

  return JSON.stringify({
    finished: false,
    rationale: `${rationale}.`,
    score,
    rubric: {
      specificity: score + 2,
      rebuttalQuality: score - 2,
      evidenceQuality: score - 1,
      synthesisUtility: score + 1
    },
    steeringDirectives:
      weakness.judgeDirectiveCount === 0
        ? []
        : [
            `Name one concrete next check for ${buildTopicFragment(topic)} instead of broadening the recommendation.`
          ]
  });
}

function buildRecommendation(
  profile: MockDomainProfile,
  weakness: MockWeaknessProfile,
  hash: number,
  topicFragment: string,
  refs: string[]
): Array<{ text: string; priority?: "high" | "medium" | "low" }> {
  const firstTarget = pickDeterministic(profile.recommendationTargets, hash);
  const secondTarget =
    weakness.recommendationOverlap !== "none"
      ? firstTarget
      : pickDeterministic(profile.recommendationTargets, hash, 1);
  const thirdTarget = pickDeterministic(profile.recommendationTargets, hash, 2);
  const firstRisk = pickDeterministic(profile.synthesisRisks, hash, 1);
  const secondRisk = pickDeterministic(profile.synthesisRisks, hash, 2);
  const thirdRisk = pickDeterministic(profile.synthesisRisks, hash, 3);
  const citationRef = weakness.citationBudget > 0 ? refs[0] : undefined;

  const targets = [firstTarget, secondTarget, thirdTarget];
  const risks = [firstRisk, secondRisk, thirdRisk];
  const firstAction = pickDeterministic(profile.actionOpeners, hash);
  const firstRecommendationText = appendRefIfNeeded(
    `${firstAction} ${firstTarget} so the next pass on ${topicFragment} stops drifting around ${firstRisk}`,
    citationRef,
    Boolean(citationRef)
  );

  return targets.map((target, index) => {
    const useActionVerb = index < weakness.actionableRecommendationCount;
    const opener = useActionVerb
      ? pickDeterministic(profile.actionOpeners, hash, index)
      : pickDeterministic(profile.softOpeners, hash, index);
    const priority =
      index < weakness.prioritizedRecommendationCount
        ? (index === 0 ? "high" : index === 1 ? "medium" : "low")
        : undefined;
    const risk = risks[index] as string;

    const text =
      index === 0
        ? firstRecommendationText
        : index === 1 && weakness.recommendationOverlap === "strong"
          ? firstRecommendationText
          : index === 1 && weakness.recommendationOverlap === "light"
            ? `${opener} the same ${target} in a narrower pass before changing anything larger`
            : `${opener} ${index === 1 ? "one checkpoint around" : "the follow-up on"} ${target} and note whether ${risk}`;

    return {
      text: `${text}.`,
      priority
    };
  });
}

function buildSynthesisFallback(
  request: ProviderGenerateRequest,
  hash: number,
  topic: string,
  profile: MockDomainProfile,
  weakness: MockWeaknessProfile
): string {
  const refs = buildTranscriptRefs(request, 3);
  const summaryRef = weakness.citationBudget > 0 ? refs.at(0) : undefined;
  const topicFragment = buildTopicFragment(topic);
  const frame = pickDeterministic(profile.synthesisFrames, hash);
  const lesson = pickDeterministic(profile.synthesisLessons, hash, 1);
  const risk = pickDeterministic(profile.synthesisRisks, hash, 2);
  const summarySentences =
    weakness.summaryMode === "balanced"
      ? [
          appendRefIfNeeded(
            `The discussion lands on ${frame} for ${topicFragment}, but it never fully closes the loop on ${risk}`,
            summaryRef,
            Boolean(summaryRef)
          ),
          `${lesson}.`,
          "That makes the output usable as a next pass, not as a finished answer."
        ]
      : weakness.summaryMode === "partial"
        ? [
            `The discussion points toward ${frame} for ${topicFragment}, with most of the confidence coming from repeated cues rather than a complete case.`,
            `${lesson}.`
          ]
        : [
            `The transcript suggests ${frame} for ${topicFragment}, yet the strongest claim still feels inferred more than demonstrated.`,
            `The unresolved part is ${risk}, so the synthesis can only narrow the next move rather than settle the debate.`
          ];

  const verdict =
    weakness.verdictMode === "omit"
      ? undefined
      : weakness.verdictMode === "soft"
        ? `Tentatively lean toward ${frame} for ${topicFragment}, but keep ${risk} open until the next review.`
        : `Use ${frame} as the working direction for ${topicFragment} and revisit it only if ${risk}.`;

  const recommendations = buildRecommendation(profile, weakness, hash, topicFragment, refs);

  return JSON.stringify({
    summary: summarySentences.join(" "),
    ...(verdict ? { verdict } : {}),
    recommendations
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
    const topic = getTopic(request);
    const scenarioHash = getScenarioHash(request, topic);
    const weakness = getWeaknessProfile(getDomainProfile(request, topic), scenarioHash);
    const seedSource = [
      request.runId,
      request.agent.id,
      request.roundId ?? "",
      request.phaseId ?? "",
      request.messageKind ?? "",
      request.turnIndex?.toString() ?? "",
      request.prompt,
      transcriptTail,
      weakness.id
    ].join("|");

    const hash = stableHash(seedSource);
    const profile = getDomainProfile(request, topic);

    if (request.phaseId === "judge") {
      return buildJudgeFallback(request, hash, topic, profile, weakness);
    }

    if (request.phaseId === "synthesis" || request.messageKind === "synthesis") {
      return buildSynthesisFallback(request, hash, topic, profile, weakness);
    }

    return buildAgentTurnFallback(request, hash, topic, profile, weakness);
  }
}
