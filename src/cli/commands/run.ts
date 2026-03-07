import type { ExecutionMode } from "../../connectors/connector-resolution";
import type { ActionabilityEvaluation } from "../../core/actionability";
import {
  assertExecutionReady,
  executePreparedRun,
  prepareRunExecution
} from "../../run/prepare-run";
import { TerminalRenderer } from "../output/terminal-renderer";

interface RunCliOptions {
  adapterId?: string;
  adapterFile?: string;
  topic?: string;
  runId?: string;
  outputDir?: string;
  format?: "json" | "jsonl";
  model?: string;
  phaseJudgeEnabled?: boolean;
  qualityThreshold?: number;
  citationMode?: "transcript_only" | "optional_web";
  contextPolicyMode?: "full" | "round_plus_recent";
  recentContextCount?: number;
  executionMode: ExecutionMode;
  connectorId?: string;
  noPersist: boolean;
}

function getRunUsage(): string {
  return [
    "Usage:",
    "  run --adapter-id <id> --topic <text> [--execution-mode mock|live|auto] [--connector <id>] [--model <model>] [--phase-judge on|off] [--quality-threshold 0-100] [--citation-mode transcript|optional-web] [--context-policy full|round-plus-recent] [--recent-context-count <n>] [--run-id <id>] [--output-dir <dir>] [--format json|jsonl] [--no-persist]",
    "  run --adapter-file <path> --topic <text> [--execution-mode mock|live|auto] [--connector <id>] [--model <model>] [--phase-judge on|off] [--quality-threshold 0-100] [--citation-mode transcript|optional-web] [--context-policy full|round-plus-recent] [--recent-context-count <n>] [--run-id <id>] [--output-dir <dir>] [--format json|jsonl] [--no-persist]"
  ].join("\n");
}

function parseRunOptions(args: string[]): RunCliOptions {
  const options: RunCliOptions = {
    executionMode: "auto",
    noPersist: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    switch (token) {
      case "--adapter-id": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --adapter-id");
        }
        options.adapterId = value;
        index += 1;
        break;
      }
      case "--adapter-file": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --adapter-file");
        }
        options.adapterFile = value;
        index += 1;
        break;
      }
      case "--topic": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --topic");
        }
        options.topic = value;
        index += 1;
        break;
      }
      case "--run-id": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --run-id");
        }
        options.runId = value;
        index += 1;
        break;
      }
      case "--output-dir": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --output-dir");
        }
        options.outputDir = value;
        index += 1;
        break;
      }
      case "--format": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --format");
        }
        if (value !== "json" && value !== "jsonl") {
          throw new Error(`Invalid --format value: ${value}`);
        }
        options.format = value;
        index += 1;
        break;
      }
      case "--execution-mode":
      case "--provider-mode": {
        const value = args[index + 1];
        if (!value) {
          throw new Error(`Missing value for ${token}`);
        }
        if (value !== "mock" && value !== "live" && value !== "auto") {
          throw new Error(`Invalid ${token} value: ${value}. Expected mock|live|auto.`);
        }
        options.executionMode = value;
        index += 1;
        break;
      }
      case "--connector": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --connector");
        }
        options.connectorId = value;
        index += 1;
        break;
      }
      case "--model": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --model");
        }
        options.model = value;
        index += 1;
        break;
      }
      case "--phase-judge": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --phase-judge");
        }
        if (value !== "on" && value !== "off") {
          throw new Error(`Invalid --phase-judge value: ${value}. Expected on|off.`);
        }
        options.phaseJudgeEnabled = value === "on";
        index += 1;
        break;
      }
      case "--quality-threshold": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --quality-threshold");
        }
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          throw new Error(`Invalid --quality-threshold value: ${value}. Expected number between 0 and 100.`);
        }
        options.qualityThreshold = parsed;
        index += 1;
        break;
      }
      case "--citation-mode": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --citation-mode");
        }
        if (value === "transcript") {
          options.citationMode = "transcript_only";
          index += 1;
          break;
        }
        if (value === "optional-web") {
          options.citationMode = "optional_web";
          index += 1;
          break;
        }
        throw new Error(`Invalid --citation-mode value: ${value}. Expected transcript|optional-web.`);
      }
      case "--context-policy": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --context-policy");
        }
        if (value === "full") {
          options.contextPolicyMode = "full";
          index += 1;
          break;
        }
        if (value === "round-plus-recent") {
          options.contextPolicyMode = "round_plus_recent";
          index += 1;
          break;
        }
        throw new Error(
          `Invalid --context-policy value: ${value}. Expected full|round-plus-recent.`
        );
      }
      case "--recent-context-count": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("Missing value for --recent-context-count");
        }
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(
            `Invalid --recent-context-count value: ${value}. Expected a positive integer.`
          );
        }
        options.recentContextCount = parsed;
        index += 1;
        break;
      }
      case "--no-persist": {
        options.noPersist = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${token}`);
      }
    }
  }

  return options;
}

function validateRunOptions(options: RunCliOptions): void {
  const normalizedTopic = options.topic?.trim();
  if (!normalizedTopic) {
    throw new Error("--topic is required and must be non-empty.");
  }
  options.topic = normalizedTopic;

  const hasAdapterId = Boolean(options.adapterId);
  const hasAdapterFile = Boolean(options.adapterFile);

  if (hasAdapterId === hasAdapterFile) {
    throw new Error("Exactly one of --adapter-id or --adapter-file must be provided.");
  }
}

function getTranscriptActionability(
  metadata: Record<string, unknown> | undefined
): ActionabilityEvaluation | undefined {
  const qualityGate = metadata?.qualityGate;
  if (typeof qualityGate !== "object" || qualityGate === null) {
    return undefined;
  }

  return qualityGate as ActionabilityEvaluation;
}

export async function runCommand(args: string[]): Promise<number> {
  let options: RunCliOptions;

  try {
    options = parseRunOptions(args);
    validateRunOptions(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid run arguments.");
    console.error(getRunUsage());
    return 1;
  }

  const renderer = new TerminalRenderer({
    showTimestamps: true,
    showUsage: true
  });

  try {
    const adapterSource = options.adapterId ?? options.adapterFile;
    const preparedRun = await prepareRunExecution({
      adapterSource: adapterSource as string,
      topic: options.topic as string,
      runId: options.runId,
      outputDir: options.outputDir,
      format: options.format,
      model: options.model,
      phaseJudgeEnabled: options.phaseJudgeEnabled,
      qualityThreshold: options.qualityThreshold,
      citationMode: options.citationMode,
      contextPolicyMode: options.contextPolicyMode,
      recentContextCount: options.recentContextCount,
      executionMode: options.executionMode,
      connectorId: options.connectorId,
      noPersist: options.noPersist,
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      requireStoredConnector: true
    });

    renderer.renderHeader({
      runId: preparedRun.runId,
      adapterName: preparedRun.adapter.name,
      topic: options.topic as string,
      requestedExecutionMode: options.executionMode,
      resolvedExecutionMode: preparedRun.resolution.resolvedExecutionMode,
      evaluationTier: preparedRun.evaluationTier,
      providerSupport: preparedRun.providerSupport,
      connector: preparedRun.resolution.connector,
      activeConnectorId: preparedRun.resolution.activeConnectorId
    });

    assertExecutionReady(preparedRun.resolution);

    const result = await executePreparedRun({
      preparedRun,
      onMessage: (message) => {
        renderer.renderMessage(message);
      }
    });

    renderer.renderSynthesis(result.context.transcript.synthesis);
    renderer.renderSummary(
      result.context,
      result.persistedPath,
      getTranscriptActionability(result.context.transcript.metadata)
    );
    return 0;
  } catch (error) {
    renderer.renderError(error);
    return 1;
  }
}
