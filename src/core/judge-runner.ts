import type { ProviderRegistry } from "../providers/provider-registry";
import type { JudgeConfig, JudgeDecision, JudgeRoundRecord, Round, RunContext } from "../types";
import type { RoundPhase } from "../types/round";

import { OrchestratorIntegrationError } from "./errors";
import { renderTranscriptContext } from "./turn-router";

export interface RunJudgeCheckInput {
  context: RunContext;
  round: Round;
  phase?: RoundPhase;
  providerRegistry: ProviderRegistry;
  judge: JudgeConfig;
}

export interface RunJudgeCheckResult {
  decision: JudgeDecision;
  record: JudgeRoundRecord;
}

const DEFAULT_JUDGE_SYSTEM_PROMPT =
  "You are a strict discussion judge. Assess whether the current debate has reached a conclusive answer.";

function buildJudgePrompt(
  context: RunContext,
  round: Round,
  phase: RoundPhase | undefined,
  promptTemplate?: string
): string {
  const transcriptBody = renderTranscriptContext(context.adapter, context.transcript, {
    showMostRecentMarker: false
  });

  return [
    promptTemplate?.trim() ||
      "Evaluate whether the debate can stop now based on the full transcript so far.",
    `Current Round ID: ${round.id}`,
    `Current Round Name: ${round.name}`,
    `Current Phase ID: ${phase?.id ?? "N/A"}`,
    `Current Phase Name: ${phase?.name ?? "N/A"}`,
    `Topic: ${context.transcript.topic}`,
    "",
    "Return strict JSON only with this exact schema:",
    '{ "finished": boolean, "correctAnswer"?: string, "rationale"?: string, "score"?: number, "rubric"?: { "specificity"?: number, "rebuttalQuality"?: number, "evidenceQuality"?: number, "synthesisUtility"?: number }, "steeringDirectives"?: string[] }',
    "",
    "Rules:",
    "- finished=true only if the answer is sufficiently settled.",
    "- If finished=false, provide concise rationale for continuing.",
    "- score should be 0-100 overall quality for the current debate state.",
    "- rubric scores should be 0-100 if provided.",
    "- steeringDirectives should be actionable instructions for the next phase turns.",
    "- Do not include markdown fences unless unavoidable.",
    "",
    "Transcript:",
    transcriptBody
  ].join("\n");
}

function extractFencedJson(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return fenced?.[1];
}

function parseStructuredJudgeDecision(value: unknown): JudgeDecision | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.finished !== "boolean") {
    return undefined;
  }

  const correctAnswer =
    typeof payload.correctAnswer === "string" && payload.correctAnswer.trim().length > 0
      ? payload.correctAnswer.trim()
      : undefined;
  const rationale =
    typeof payload.rationale === "string" && payload.rationale.trim().length > 0
      ? payload.rationale.trim()
      : undefined;
  const score = typeof payload.score === "number" ? payload.score : undefined;
  const rubricCandidate =
    typeof payload.rubric === "object" && payload.rubric !== null
      ? (payload.rubric as Record<string, unknown>)
      : undefined;
  const rubric =
    rubricCandidate
      ? {
          specificity:
            typeof rubricCandidate.specificity === "number"
              ? rubricCandidate.specificity
              : undefined,
          rebuttalQuality:
            typeof rubricCandidate.rebuttalQuality === "number"
              ? rubricCandidate.rebuttalQuality
              : undefined,
          evidenceQuality:
            typeof rubricCandidate.evidenceQuality === "number"
              ? rubricCandidate.evidenceQuality
              : undefined,
          synthesisUtility:
            typeof rubricCandidate.synthesisUtility === "number"
              ? rubricCandidate.synthesisUtility
              : undefined
        }
      : undefined;
  const steeringDirectives = Array.isArray(payload.steeringDirectives)
    ? payload.steeringDirectives
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : undefined;

  return {
    finished: payload.finished,
    correctAnswer,
    rationale,
    score,
    rubric,
    steeringDirectives: steeringDirectives && steeringDirectives.length > 0
      ? steeringDirectives
      : undefined
  };
}

function parseJsonCandidate(raw: string): JudgeDecision | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseStructuredJudgeDecision(parsed);
  } catch {
    return undefined;
  }
}

function parseJudgeDecision(rawResponseText: string): JudgeDecision {
  const directJson = parseJsonCandidate(rawResponseText);
  if (directJson) {
    return directJson;
  }

  const fencedJson = extractFencedJson(rawResponseText);
  if (fencedJson) {
    const parsedFenced = parseJsonCandidate(fencedJson);
    if (parsedFenced) {
      return parsedFenced;
    }
  }

  return {
    finished: false,
    rationale: "parse failure"
  };
}

export async function runJudgeCheck(input: RunJudgeCheckInput): Promise<RunJudgeCheckResult> {
  const judgeAgent = input.context.adapter.agents.find((agent) => agent.id === input.judge.agentId);

  if (!judgeAgent) {
    throw new OrchestratorIntegrationError(
      "runtime",
      "UNKNOWN_JUDGE_AGENT",
      `Judge agent "${input.judge.agentId}" was not found in adapter "${input.context.adapter.id}".`
    );
  }

  const provider = input.providerRegistry.resolveForAgent(judgeAgent);
  const judgeSystemPrompt = judgeAgent.systemPrompt?.trim()
    ? judgeAgent.systemPrompt
    : DEFAULT_JUDGE_SYSTEM_PROMPT;

  const result = await provider.generate({
    runId: input.context.runId,
    agent: judgeAgent,
    systemPrompt: judgeSystemPrompt,
    prompt: buildJudgePrompt(input.context, input.round, input.phase, input.judge.promptTemplate),
    transcript: input.context.transcript.messages,
    roundId: input.round.id,
    phaseId: "judge",
    turnIndex: input.context.transcript.messages.length + 1,
    metadata: {
      adapterId: input.context.adapter.id,
      topic: input.context.transcript.topic,
      roundId: input.round.id,
      roundName: input.round.name,
      phaseId: input.phase?.id,
      phaseName: input.phase?.name,
      judgeAgentId: judgeAgent.id
    }
  });

  const decision = parseJudgeDecision(result.content);
  const record: JudgeRoundRecord = {
    roundId: input.round.id,
    roundName: input.round.name,
    phaseId: input.phase?.id,
    phaseName: input.phase?.name,
    timestamp: new Date().toISOString(),
    decision,
    provider: result.provider,
    model: result.model,
    providerInvocationId: result.invocationId
  };

  return {
    decision,
    record
  };
}
