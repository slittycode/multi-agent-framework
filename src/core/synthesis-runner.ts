import type { ProviderRegistry } from "../providers/provider-registry";
import type { Message, RunContext, SynthesisOutput } from "../types";

import { OrchestratorIntegrationError } from "./errors";
import { renderTranscriptContext } from "./turn-router";

export interface RunSynthesisInput {
  context: RunContext;
  providerRegistry: ProviderRegistry;
}

export interface RunSynthesisResult {
  output?: SynthesisOutput;
  message?: Message;
  errorMessage?: Message;
}

interface ParsedSynthesisPayload {
  summary: string;
  verdict?: string;
  recommendations?: {
    text: string;
    priority?: "high" | "medium" | "low";
  }[];
  raw?: string;
}

const FALLBACK_SUMMARY_LIMIT = 500;
const FALLBACK_TRUNCATION_MARKER = "... [truncated]";
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
const DEFAULT_SYNTHESIS_SYSTEM_PROMPT =
  "You are a synthesis agent. Your role is to analyse a structured multi-agent discussion and produce a clear, impartial summary of what was argued, what was resolved, and what remains contested.";

function buildSynthesisPrompt(context: RunContext): string {
  const transcriptBody = renderTranscriptContext(context.adapter, context.transcript, {
    showMostRecentMarker: false
  });
  const synthesisInstructions = context.adapter.prompts?.synthesisInstructions?.trim();

  return [
    "You have observed a structured multi-agent discussion on the topic below. Your task is to synthesise the key arguments made, identify where agents agreed or diverged, and produce a final verdict with actionable recommendations where applicable.",
    "Do not simply summarise each agent in turn. Synthesise across them.",
    `Topic: ${context.transcript.topic}`,
    "",
    ...(synthesisInstructions
      ? ["Synthesis Instructions:", synthesisInstructions, ""]
      : []),
    "Return output as strict JSON using this schema:",
    "{",
    '  "summary": "string (required)",',
    '  "verdict": "string (optional)",',
    '  "recommendations": [',
    '    { "text": "string", "priority": "high|medium|low (optional)" }',
    "  ]",
    "}",
    "",
    "Guidelines:",
    "- summary: 2-4 sentences covering the arc of the discussion, not a list of who said what",
    "- verdict: one clear conclusion or finding (omit if genuinely unresolved)",
    "- recommendations: concrete and actionable, not restatements of positions. Assign priority honestly.",
    "- include explicit consensus points and unresolved disagreements in summary or verdict wording.",
    "- tie recommendations to cited evidence from the transcript (e.g., reference [T4], [T7] inline when useful).",
    "",
    "Transcript:",
    transcriptBody
  ].join("\n");
}

function extractFencedJson(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return fenced?.[1];
}

function normalizeRecommendations(value: unknown): ParsedSynthesisPayload["recommendations"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized: NonNullable<ParsedSynthesisPayload["recommendations"]> = [];

  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) {
        normalized.push({ text: trimmed });
      }
      continue;
    }

    if (typeof item !== "object" || item === null) {
      continue;
    }

    const candidate = item as Record<string, unknown>;
    const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
    if (!text) {
      continue;
    }

    const priority = typeof candidate.priority === "string" ? candidate.priority.toLowerCase() : undefined;
    if (priority && VALID_PRIORITIES.has(priority)) {
      normalized.push({
        text,
        priority: priority as "high" | "medium" | "low"
      });
      continue;
    }

    normalized.push({ text });
  }

  return normalized.length > 0 ? normalized : undefined;
}

function parseStructuredSynthesisPayload(value: unknown): ParsedSynthesisPayload | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const payload = value as Record<string, unknown>;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (!summary) {
    return undefined;
  }

  const verdict = typeof payload.verdict === "string" ? payload.verdict.trim() || undefined : undefined;
  const recommendations = normalizeRecommendations(payload.recommendations);
  const raw = typeof payload.raw === "string" ? payload.raw : undefined;

  return {
    summary,
    verdict,
    recommendations,
    raw
  };
}

function parseJsonCandidate(raw: string): ParsedSynthesisPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseStructuredSynthesisPayload(parsed);
  } catch {
    return undefined;
  }
}

function truncateFallbackSummary(raw: string): string {
  if (raw.length <= FALLBACK_SUMMARY_LIMIT) {
    return raw;
  }
  return `${raw.slice(0, FALLBACK_SUMMARY_LIMIT)}${FALLBACK_TRUNCATION_MARKER}`;
}

function parseSynthesisPayload(rawResponseText: string): ParsedSynthesisPayload {
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

  const normalizedRaw = rawResponseText.trim() || "No synthesis content returned.";
  return {
    summary: truncateFallbackSummary(normalizedRaw),
    raw: normalizedRaw
  };
}

export async function runSynthesis(input: RunSynthesisInput): Promise<RunSynthesisResult> {
  const synthesisAgent = input.context.adapter.agents.find(
    (agent) => agent.id === input.context.config.synthesis.agentId
  );

  if (!synthesisAgent) {
    throw new OrchestratorIntegrationError(
      "runtime",
      "UNKNOWN_SYNTHESIS_AGENT",
      `Synthesis agent "${input.context.config.synthesis.agentId}" was not found in adapter "${input.context.adapter.id}".`
    );
  }

  const provider = input.providerRegistry.resolveForAgent(synthesisAgent);
  const turnIndex = input.context.transcript.messages.length + 1;
  const previousMessage = input.context.transcript.messages.at(-1);
  const synthesisSystemPrompt = synthesisAgent.systemPrompt?.trim()
    ? synthesisAgent.systemPrompt
    : DEFAULT_SYNTHESIS_SYSTEM_PROMPT;

  const result = await provider.generate({
    runId: input.context.runId,
    agent: synthesisAgent,
    systemPrompt: synthesisSystemPrompt,
    prompt: buildSynthesisPrompt(input.context),
    transcript: input.context.transcript.messages,
    phaseId: "synthesis",
    messageKind: "synthesis",
    turnIndex,
    metadata: {
      adapterId: input.context.adapter.id,
      topic: input.context.transcript.topic,
      synthesisAgentId: synthesisAgent.id
    }
  });

  const parsed = parseSynthesisPayload(result.content);

  const message: Message = {
    id: crypto.randomUUID(),
    runId: input.context.runId,
    roundId: input.context.adapter.rounds.at(-1)?.id,
    phaseId: "synthesis",
    turnIndex,
    timestamp: new Date().toISOString(),
    from: synthesisAgent.id,
    to: "all",
    kind: "synthesis",
    content: parsed.summary,
    respondingToMessageId: previousMessage?.id,
    provider: result.provider,
    model: result.model,
    providerInvocationId: result.invocationId,
    usage: result.usage
  };

  const output: SynthesisOutput = {
    agentId: synthesisAgent.id,
    messageId: message.id,
    summary: parsed.summary,
    verdict: parsed.verdict,
    recommendations: parsed.recommendations,
    raw: parsed.raw
  };

  return {
    output,
    message
  };
}
