import type { ProviderUsage } from "../provider-client";

export interface NormalizedProviderResponse {
  content: string;
  model?: string;
  usage?: ProviderUsage;
  raw: unknown;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pickUsage(raw: unknown): ProviderUsage | undefined {
  if (!isObjectLike(raw)) {
    return undefined;
  }
  const usage = raw.usage;
  if (!isObjectLike(usage)) {
    return undefined;
  }

  const inputTokens = typeof usage.input_tokens === "number"
    ? usage.input_tokens
    : typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : undefined;
  const outputTokens = typeof usage.output_tokens === "number"
    ? usage.output_tokens
    : typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : undefined;

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return { inputTokens, outputTokens };
}

function pickNestedText(raw: Record<string, unknown>): string | undefined {
  const direct =
    pickString(raw.content) ??
    pickString(raw.text) ??
    pickString(raw.output_text) ??
    pickString(raw.completion);
  if (direct) {
    return direct;
  }

  const candidates = [
    raw.output,
    raw.messages,
    raw.choices
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const item of candidate) {
      if (!isObjectLike(item)) {
        continue;
      }

      const nestedText =
        pickString(item.text) ??
        pickString(item.content) ??
        (isObjectLike(item.message) ? pickString(item.message.content) : undefined) ??
        (isObjectLike(item.delta) ? pickString(item.delta.content) : undefined);

      if (nestedText) {
        return nestedText;
      }
    }
  }

  return undefined;
}

function pickModel(raw: unknown): string | undefined {
  if (!isObjectLike(raw)) {
    return undefined;
  }

  return pickString(raw.model) ?? pickString(raw.model_name);
}

export function normalizeProviderResponse(raw: unknown): NormalizedProviderResponse {
  if (typeof raw === "string") {
    return { content: raw, raw };
  }

  if (isObjectLike(raw)) {
    const content = pickNestedText(raw);
    if (content) {
      return {
        content,
        model: pickModel(raw),
        usage: pickUsage(raw),
        raw
      };
    }
  }

  return {
    content: "",
    raw
  };
}
