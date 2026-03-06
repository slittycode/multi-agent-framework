import type { Message, RunContext, SynthesisOutput } from "../../types";

export interface MessageFormatOptions {
  showTimestamps?: boolean;
  showUsage?: boolean;
}

export function formatMessage(message: Message, options: MessageFormatOptions = {}): string {
  const timestampPrefix = options.showTimestamps ? `[${message.timestamp}] ` : "";
  const usageSuffix =
    options.showUsage && message.usage
      ? ` (tokens in/out: ${message.usage.inputTokens ?? 0}/${message.usage.outputTokens ?? 0})`
      : "";

  return `${timestampPrefix}#${message.turnIndex} ${message.from} [${message.kind}] ${message.content}${usageSuffix}`;
}

export function formatRunHeader(input: {
  runId: string;
  adapterName: string;
  topic: string;
}): string {
  return [
    "=== Multi-Agent Discussion Run ===",
    `Run ID: ${input.runId}`,
    `Adapter: ${input.adapterName}`,
    `Topic: ${input.topic}`,
    "----------------------------------"
  ].join("\n");
}

export function formatRunSummary(input: {
  context: RunContext;
  persistedPath?: string;
}): string {
  const persistedLine = input.persistedPath
    ? `Transcript: ${input.persistedPath}`
    : "Transcript persistence: disabled";

  return [
    "----------------------------------",
    "=== Run Summary ===",
    `Status: ${input.context.transcript.status}`,
    `Messages: ${input.context.transcript.messages.length}`,
    `Rounds processed: ${input.context.currentRoundIndex + 1}`,
    persistedLine
  ].join("\n");
}

export function formatSynthesisOutput(synthesis: SynthesisOutput): string {
  const lines = ["=== Synthesis ===", `Summary: ${synthesis.summary}`];

  if (synthesis.verdict) {
    lines.push(`Verdict: ${synthesis.verdict}`);
  }

  if (synthesis.recommendations && synthesis.recommendations.length > 0) {
    lines.push("Recommendations:");
    for (const recommendation of synthesis.recommendations) {
      const priority = recommendation.priority ? ` (${recommendation.priority})` : "";
      lines.push(`- ${recommendation.text}${priority}`);
    }
  }

  return lines.join("\n");
}

export function formatSynthesisUnavailableNotice(): string {
  return "=== Synthesis ===\nSynthesis unavailable for this run.";
}
