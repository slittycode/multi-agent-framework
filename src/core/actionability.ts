import type { Transcript } from "../types";

export const ACTIONABILITY_RUBRIC_VERSION = "2026-03-06.v1";
export const DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD = 60;
export const LIVE_CERTIFICATION_ENTRY_THRESHOLD = 70;
export const LIVE_CERTIFICATION_MEAN_THRESHOLD = 80;

export type ActionabilityEvaluationTier = "baseline" | "live_certification";

export function getEvaluationTierForProviderMode(
  providerMode: "mock" | "live" | "auto"
): ActionabilityEvaluationTier {
  return providerMode === "mock" ? "baseline" : "live_certification";
}

export function getActionabilityThreshold(
  evaluationTier: ActionabilityEvaluationTier
): number {
  return evaluationTier === "baseline"
    ? DEFAULT_BASELINE_ACTIONABILITY_THRESHOLD
    : LIVE_CERTIFICATION_ENTRY_THRESHOLD;
}

export interface ActionabilitySubscores {
  structuralCompleteness: number;
  recommendationSpecificity: number;
  grounding: number;
  nonRedundancy: number;
  prioritizedNextStepUsefulness: number;
}

export interface ActionabilityPenalty {
  code:
    | "SYNTHESIS_UNAVAILABLE"
    | "MISSING_RECOMMENDATIONS"
    | "GENERIC_FILLER"
    | "REPEATED_TURNS";
  points: number;
  reason: string;
}

export interface ActionabilityEvaluation {
  rubricVersion: string;
  evaluationTier: ActionabilityEvaluationTier;
  threshold: number;
  score: number;
  passed: boolean;
  subscores: ActionabilitySubscores;
  penalties: ActionabilityPenalty[];
  failureReasons: string[];
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "was",
  "with"
]);

const ACTION_VERBS = new Set([
  "adopt",
  "align",
  "assess",
  "audit",
  "conduct",
  "define",
  "document",
  "establish",
  "implement",
  "instrument",
  "measure",
  "monitor",
  "pilot",
  "prioritize",
  "publish",
  "review",
  "roll",
  "run",
  "track",
  "update",
  "verify"
]);

const GENERIC_FILLER_PATTERNS: RegExp[] = [
  /\[mock:/iu,
  /\[sig:/iu,
  /the next step should prioritize clarity, measurable outcomes, and iteration speed/iu,
  /i support this position and can back it with concrete examples/iu,
  /trade-offs need to be made explicit/iu,
  /key assumptions are still unproven/iu
];

function clampScore(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function tokenizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .match(/[a-z0-9]+/giu)
    ?.filter((token) => token.length > 0) ?? [];
}

function meaningfulTokens(value: string): string[] {
  return tokenizeWords(value).filter((token) => token.length > 3 && !STOPWORDS.has(token));
}

function countCitationMarkers(value: string): number {
  return [...value.matchAll(/\[(?:T|W)\d+\]/giu)].length;
}

function uniqueTokenRatio(tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }

  return new Set(tokens).size / tokens.length;
}

function jaccardSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function countRepeatedTurns(transcript: Transcript): number {
  const counts = new Map<string, number>();

  for (const message of transcript.messages) {
    const normalized = message.content.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return [...counts.values()].filter((count) => count > 1).length;
}

function countDuplicateRecommendations(recommendations: string[]): number {
  let duplicates = 0;

  for (let leftIndex = 0; leftIndex < recommendations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < recommendations.length; rightIndex += 1) {
      const leftTokens = meaningfulTokens(recommendations[leftIndex] ?? "");
      const rightTokens = meaningfulTokens(recommendations[rightIndex] ?? "");

      if (jaccardSimilarity(leftTokens, rightTokens) >= 0.7) {
        duplicates += 1;
      }
    }
  }

  return duplicates;
}

function countActionableRecommendations(recommendations: string[]): number {
  return recommendations.filter((recommendation) => {
    const firstToken = tokenizeWords(recommendation)[0];
    return typeof firstToken === "string" && ACTION_VERBS.has(firstToken);
  }).length;
}

export function evaluateTranscriptActionability(
  transcript: Transcript,
  input: {
    evaluationTier?: ActionabilityEvaluationTier;
    threshold?: number;
  } = {}
): ActionabilityEvaluation {
  const evaluationTier = input.evaluationTier ?? "baseline";
  const threshold = input.threshold ?? getActionabilityThreshold(evaluationTier);
  const synthesis = transcript.synthesis;
  const summary = synthesis?.summary?.trim() ?? "";
  const verdict = synthesis?.verdict?.trim() ?? "";
  const recommendations = synthesis?.recommendations ?? [];
  const recommendationTexts = recommendations.map((recommendation) => recommendation.text.trim());
  const transcriptCorpus = transcript.messages.map((message) => message.content).join("\n");
  const transcriptTokens = meaningfulTokens(transcript.topic + "\n" + transcriptCorpus);
  const synthesisTokens = meaningfulTokens(
    [summary, verdict, ...recommendationTexts].filter(Boolean).join("\n")
  );
  const groundedTokenCount = [...new Set(synthesisTokens)].filter((token) =>
    transcriptTokens.includes(token)
  ).length;
  const actionableRecommendationCount = countActionableRecommendations(recommendationTexts);
  const duplicateRecommendationCount = countDuplicateRecommendations(recommendationTexts);
  const repeatedTurnCount = countRepeatedTurns(transcript);
  const genericFillerMatches = [summary, verdict, ...recommendationTexts]
    .filter(Boolean)
    .filter((value) => GENERIC_FILLER_PATTERNS.some((pattern) => pattern.test(value))).length;

  const summaryWords = tokenizeWords(summary);
  const averageRecommendationWords =
    recommendationTexts.length === 0
      ? 0
      : recommendationTexts.reduce((total, recommendation) => total + tokenizeWords(recommendation).length, 0) /
        recommendationTexts.length;

  const structuralCompleteness = Number(
    clampScore(
      (summary ? 6 : 0) +
        (verdict ? 6 : 0) +
        clampScore(recommendationTexts.length * 3, 0, 8),
      0,
      20
    ).toFixed(2)
  );

  const recommendationSpecificity = Number(
    clampScore(
      clampScore((averageRecommendationWords - 4) * 1.1, 0, 10) +
        clampScore(uniqueTokenRatio(recommendationTexts.flatMap((recommendation) => meaningfulTokens(recommendation))) * 10, 0, 10),
      0,
      20
    ).toFixed(2)
  );

  const grounding = Number(
    clampScore(
      clampScore(groundedTokenCount * 1.5, 0, 16) +
        clampScore(countCitationMarkers(summary) + countCitationMarkers(verdict), 0, 4),
      0,
      20
    ).toFixed(2)
  );

  const nonRedundancy = Number(
    clampScore(
      20 - duplicateRecommendationCount * 5 - repeatedTurnCount * 4 - clampScore(genericFillerMatches * 2, 0, 6),
      0,
      20
    ).toFixed(2)
  );

  const prioritizedNextStepUsefulness = Number(
    clampScore(
      clampScore(recommendations.filter((recommendation) => recommendation.priority).length * 4, 0, 12) +
        clampScore(actionableRecommendationCount * 2.5, 0, 8),
      0,
      20
    ).toFixed(2)
  );

  const penalties: ActionabilityPenalty[] = [];
  if (!synthesis) {
    penalties.push({
      code: "SYNTHESIS_UNAVAILABLE",
      points: 30,
      reason: "Synthesis output is missing."
    });
  }
  if (recommendationTexts.length < 3) {
    penalties.push({
      code: "MISSING_RECOMMENDATIONS",
      points: 18,
      reason: "Missing at least three prioritized recommendations."
    });
  }
  if (genericFillerMatches > 0) {
    penalties.push({
      code: "GENERIC_FILLER",
      points: genericFillerMatches >= 2 ? 16 : 12,
      reason: "Generic filler language reduced actionability."
    });
  }
  if (repeatedTurnCount > 0 || duplicateRecommendationCount > 0) {
    penalties.push({
      code: "REPEATED_TURNS",
      points: clampScore(repeatedTurnCount * 6 + duplicateRecommendationCount * 4, 10, 18),
      reason: "Repeated turn or recommendation content reduced actionability."
    });
  }

  const totalBeforePenalties =
    structuralCompleteness +
    recommendationSpecificity +
    grounding +
    nonRedundancy +
    prioritizedNextStepUsefulness;
  const penaltyTotal = penalties.reduce((total, penalty) => total + penalty.points, 0);
  const score = Number(clampScore(totalBeforePenalties - penaltyTotal, 0, 100).toFixed(2));

  const failureReasons: string[] = [];
  if (!synthesis) {
    failureReasons.push("Synthesis output is missing.");
  }
  if (!verdict) {
    failureReasons.push("Synthesis verdict is missing.");
  }
  if (recommendationTexts.length < 3) {
    failureReasons.push("Missing at least three prioritized recommendations.");
  }
  if (recommendations.filter((recommendation) => recommendation.priority).length < 3) {
    failureReasons.push("Recommendations are not fully prioritized.");
  }
  if (genericFillerMatches > 0) {
    failureReasons.push("Generic filler language reduced actionability.");
  }
  if (repeatedTurnCount > 0) {
    failureReasons.push("Repeated turn content reduced actionability.");
  }
  if (summaryWords.length < 20) {
    failureReasons.push("Synthesis summary is too short to support action.");
  }
  if (score < threshold) {
    failureReasons.push(`Actionability score ${score.toFixed(2)} is below threshold ${threshold}.`);
  }

  return {
    rubricVersion: ACTIONABILITY_RUBRIC_VERSION,
    evaluationTier,
    threshold,
    score,
    passed: score >= threshold,
    subscores: {
      structuralCompleteness,
      recommendationSpecificity,
      grounding,
      nonRedundancy,
      prioritizedNextStepUsefulness
    },
    penalties,
    failureReasons: [...new Set(failureReasons)]
  };
}
