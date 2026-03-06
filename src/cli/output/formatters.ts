import type { Message, RunContext, SynthesisOutput } from "../../types";
import type { ActionabilityEvaluation } from "../../core/actionability";
import type { AvailableConnector } from "../../connectors/types";
import type { ProviderMode, ProviderSupportDescriptor } from "../../providers/provider-bootstrap";

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
  requestedExecutionMode: ProviderMode;
  resolvedExecutionMode: "mock" | "live";
  evaluationTier: string;
  providerSupport: ProviderSupportDescriptor[];
  connector?: AvailableConnector;
  activeConnectorId?: string;
}): string {
  const providerLines =
    input.providerSupport.length === 0
      ? ["Provider Support:", "- none declared"]
      : [
          "Provider Support:",
          ...input.providerSupport.map((support) => {
            const liveStatus = support.liveCapable
              ? "live-capable"
              : support.recognized
                ? "recognized, live unsupported"
                : "unrecognized";
            const envSuffix =
              support.requiredEnv.length > 0
                ? ` (env: ${support.requiredEnv.join(", ")})`
                : "";

            return `- ${support.providerId}: ${liveStatus}${envSuffix}`;
          })
        ];

  return [
    "=== Multi-Agent Discussion Run ===",
    `Run ID: ${input.runId}`,
    `Adapter: ${input.adapterName}`,
    `Topic: ${input.topic}`,
    `Execution Mode: ${input.requestedExecutionMode}`,
    `Resolved Execution Mode: ${input.resolvedExecutionMode}`,
    `Selected Connector: ${
      input.connector
        ? `${input.connector.id} (${input.connector.providerId}/${input.connector.credentialSource})`
        : "none"
    }`,
    `Active Connector: ${input.activeConnectorId ?? "none"}`,
    `Evaluation Tier: ${input.evaluationTier}`,
    ...providerLines,
    "----------------------------------"
  ].join("\n");
}

export function formatRunSummary(input: {
  context: RunContext;
  persistedPath?: string;
  actionability?: ActionabilityEvaluation;
}): string {
  const persistedLine = input.persistedPath
    ? `Transcript: ${input.persistedPath}`
    : "Transcript persistence: disabled";
  const actionabilityLine = input.actionability
    ? `Actionability Score: ${input.actionability.score.toFixed(2)}/${input.actionability.threshold} (${input.actionability.passed ? "passed" : "failed"})`
    : "Actionability Score: unavailable";
  const breakdownLine = input.actionability
    ? `Actionability Breakdown: structural=${input.actionability.subscores.structuralCompleteness.toFixed(2)}, specificity=${input.actionability.subscores.recommendationSpecificity.toFixed(2)}, grounding=${input.actionability.subscores.grounding.toFixed(2)}, nonRedundancy=${input.actionability.subscores.nonRedundancy.toFixed(2)}, nextSteps=${input.actionability.subscores.prioritizedNextStepUsefulness.toFixed(2)}, penalties=${input.actionability.penalties.reduce((total, penalty) => total + penalty.points, 0)}`
    : undefined;
  const failureReasonLine =
    input.actionability && input.actionability.failureReasons.length > 0
      ? `Failure Reasons: ${input.actionability.failureReasons.join(" | ")}`
      : undefined;

  return [
    "----------------------------------",
    "=== Run Summary ===",
    `Status: ${input.context.transcript.status}`,
    `Messages: ${input.context.transcript.messages.length}`,
    `Rounds processed: ${input.context.currentRoundIndex + 1}`,
    actionabilityLine,
    ...(breakdownLine ? [breakdownLine] : []),
    ...(failureReasonLine ? [failureReasonLine] : []),
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
