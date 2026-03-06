import type { MessageKind } from "../types/message";
import type { ProviderId } from "../types/provider";
import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "./provider-client";

const KEY_WILDCARD = "*";
const KEY_SEPARATOR = "::";

const FALLBACK_TEMPLATES = [
  "I support this position and can back it with concrete examples.",
  "I challenge this claim because key assumptions are still unproven.",
  "I partially agree, but the trade-offs need to be made explicit.",
  "The argument is strong in principle, yet execution details are underspecified.",
  "A balanced view suggests keeping strengths while mitigating obvious risks.",
  "The next step should prioritize clarity, measurable outcomes, and iteration speed."
] as const;

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
    const template = FALLBACK_TEMPLATES[hash % FALLBACK_TEMPLATES.length];
    const signature = hash.toString(16).padStart(8, "0");
    return `[mock:${request.agent.id}] ${template} [sig:${signature}]`;
  }
}
