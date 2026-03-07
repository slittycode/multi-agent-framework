import { loadDomainAdapter } from "../adapters/adapter-loader";
import { applyConnectorToAdapter } from "../connectors/adapter-override";
import { createCredentialStore } from "../connectors/credential-store";
import {
  buildLiveExecutionRemediation,
  evaluateConnectorExecutionReadiness
} from "../connectors/live-certification";
import {
  resolveExecutionContext,
  type ExecutionMode,
  type ResolvedExecutionContext
} from "../connectors/connector-resolution";
import {
  getActionabilityThreshold,
  getEvaluationTierForProviderMode,
  type ActionabilityEvaluationTier
} from "../core/actionability";
import { runDiscussion, type RunDiscussionResult } from "../core/orchestrator";
import {
  createProviderRegistryForRun,
  getAdapterProviderCapabilities,
  type ProviderSupportDescriptor
} from "../providers/provider-bootstrap";
import type { ProviderRegistry } from "../providers/provider-registry";
import type {
  DomainAdapter,
  InterTurnHook,
  Message,
  RunLifecycleEvent
} from "../types";

export interface RunAgentOverride {
  systemPrompt?: string;
  systemPromptSuffix?: string;
  persona?: string;
}

export type RunAgentOverrideMap = Record<string, RunAgentOverride>;

export interface PrepareRunExecutionInput {
  adapterSource: string;
  topic: string;
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
  noPersist?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
  requireStoredConnector?: boolean;
  agentOverrides?: RunAgentOverrideMap;
}

export interface PreparedRunExecution {
  runId: string;
  topic: string;
  adapter: DomainAdapter;
  providerRegistry: ProviderRegistry;
  evaluationTier: ActionabilityEvaluationTier;
  providerSupport: ProviderSupportDescriptor[];
  resolution: ResolvedExecutionContext;
  runConfig: NonNullable<Parameters<typeof runDiscussion>[0]["config"]>;
  metadata: Record<string, unknown>;
}

export interface ExecutePreparedRunInput {
  preparedRun: PreparedRunExecution;
  onMessage?: (message: Message) => void;
  onEvent?: (event: RunLifecycleEvent) => void;
  interTurnHook?: InterTurnHook;
}

export function assertExecutionReady(resolution: ResolvedExecutionContext): void {
  if (resolution.resolvedExecutionMode !== "live" || !resolution.connector) {
    return;
  }

  const readiness = evaluateConnectorExecutionReadiness({
    id: resolution.connector.id,
    runtimeStatus: resolution.connector.runtimeStatus,
    runtimeStatusReason: resolution.connector.runtimeStatusReason,
    liveCertification: resolution.connector.liveCertification
  });

  if (!readiness.runnable) {
    throw new Error(buildLiveExecutionRemediation(resolution.connector, readiness));
  }
}

function applyModelOverride(adapter: DomainAdapter, model?: string): DomainAdapter {
  const normalizedModel = model?.trim();
  if (!normalizedModel) {
    return adapter;
  }

  return {
    ...adapter,
    agents: adapter.agents.map((agent) => {
      if (!agent.llm) {
        return agent;
      }

      return {
        ...agent,
        llm: {
          ...agent.llm,
          model: normalizedModel
        }
      };
    })
  };
}

function applyAgentOverrides(
  adapter: DomainAdapter,
  overrides?: RunAgentOverrideMap
): DomainAdapter {
  if (!overrides || Object.keys(overrides).length === 0) {
    return adapter;
  }

  const unknownAgentIds = Object.keys(overrides).filter(
    (agentId) => !adapter.agents.some((agent) => agent.id === agentId)
  );
  if (unknownAgentIds.length > 0) {
    throw new Error(`Unknown agent override ids: ${unknownAgentIds.join(", ")}.`);
  }

  return {
    ...adapter,
    agents: adapter.agents.map((agent) => {
      const override = overrides[agent.id];
      if (!override) {
        return agent;
      }

      const systemPrompt =
        typeof override.systemPrompt === "string" && override.systemPrompt.trim().length > 0
          ? override.systemPrompt.trim()
          : typeof override.systemPromptSuffix === "string" &&
              override.systemPromptSuffix.trim().length > 0
            ? `${agent.systemPrompt}\n\n${override.systemPromptSuffix.trim()}`
            : agent.systemPrompt;

      return {
        ...agent,
        persona:
          typeof override.persona === "string" && override.persona.trim().length > 0
            ? override.persona.trim()
            : agent.persona,
        systemPrompt
      };
    })
  };
}

function buildRunConfig(
  adapter: DomainAdapter,
  input: PrepareRunExecutionInput,
  evaluationTier: ActionabilityEvaluationTier
): NonNullable<Parameters<typeof runDiscussion>[0]["config"]> {
  const runConfig: NonNullable<Parameters<typeof runDiscussion>[0]["config"]> = {
    transcript: {
      persistToFile: !input.noPersist,
      outputDir: input.outputDir ?? "./runs",
      format: input.format ?? "json"
    }
  };
  const adapterQualityGate = adapter.orchestrator?.qualityGate;

  if (input.phaseJudgeEnabled !== undefined) {
    runConfig.phaseJudge = {
      enabled: input.phaseJudgeEnabled,
      cadence: "after_each_phase",
      agentId: adapter.synthesisAgentId
    };
  }

  if (input.qualityThreshold !== undefined) {
    runConfig.qualityGate = {
      enabled: true,
      threshold: input.qualityThreshold,
      recordInTranscriptMetadata: adapterQualityGate?.recordInTranscriptMetadata
    };
  } else if (adapterQualityGate?.enabled) {
    runConfig.qualityGate = {
      ...adapterQualityGate,
      enabled: true,
      threshold: getActionabilityThreshold(evaluationTier)
    };
  }

  if (input.citationMode) {
    runConfig.citations = {
      mode: input.citationMode,
      failPolicy: "graceful_fallback"
    };
  }

  if (input.contextPolicyMode || input.recentContextCount !== undefined) {
    runConfig.contextPolicy = {
      mode: input.contextPolicyMode ?? "round_plus_recent",
      ...(input.recentContextCount !== undefined
        ? { recentMessageCount: input.recentContextCount }
        : {})
    };
  }

  return runConfig;
}

function buildRunMetadata(
  input: PrepareRunExecutionInput,
  resolution: ResolvedExecutionContext,
  providerSupport: ProviderSupportDescriptor[],
  evaluationTier: ActionabilityEvaluationTier
): Record<string, unknown> {
  return {
    evaluationTier,
    providerMode: input.executionMode,
    executionMode: input.executionMode,
    resolvedExecutionMode: resolution.resolvedExecutionMode,
    providerSupport,
    connectorId: resolution.connector?.id,
    activeConnectorId: resolution.activeConnectorId
  };
}

export async function prepareRunExecution(
  input: PrepareRunExecutionInput
): Promise<PreparedRunExecution> {
  const adapterSource = input.adapterSource.trim();
  if (!adapterSource) {
    throw new Error("Adapter source is required.");
  }

  const topic = input.topic.trim();
  if (!topic) {
    throw new Error("Topic is required and must be non-empty.");
  }

  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const loadedAdapter = await loadDomainAdapter(adapterSource, { cwd });
  const credentialStore = createCredentialStore(env);
  const resolution = await resolveExecutionContext({
    cwd,
    executionMode: input.executionMode,
    explicitConnectorId: input.connectorId,
    env,
    credentialStore,
    requireStoredConnector: input.requireStoredConnector ?? true
  });
  const resolvedAdapter = resolution.connector
    ? applyConnectorToAdapter(loadedAdapter, resolution.connector)
    : loadedAdapter;
  const adapter = applyAgentOverrides(applyModelOverride(resolvedAdapter, input.model), input.agentOverrides);
  const providerSupport = getAdapterProviderCapabilities(adapter);
  const evaluationTier = getEvaluationTierForProviderMode(resolution.resolvedExecutionMode);

  const providerRegistry = createProviderRegistryForRun({
    adapter,
    providerMode: resolution.resolvedExecutionMode,
    env: {
      ...env,
      ...resolution.envOverlay
    },
    connectorByProviderId: resolution.connector
      ? { [resolution.connector.providerId]: resolution.connector }
      : undefined
  });
  const metadata = buildRunMetadata(input, resolution, providerSupport, evaluationTier);

  return {
    runId: input.runId ?? crypto.randomUUID(),
    topic,
    adapter,
    providerRegistry,
    evaluationTier,
    providerSupport,
    resolution,
    runConfig: buildRunConfig(adapter, input, evaluationTier),
    metadata
  };
}

export async function executePreparedRun(
  input: ExecutePreparedRunInput
): Promise<RunDiscussionResult> {
  return runDiscussion({
    adapter: input.preparedRun.adapter,
    topic: input.preparedRun.topic,
    providerRegistry: input.preparedRun.providerRegistry,
    runId: input.preparedRun.runId,
    config: input.preparedRun.runConfig,
    evaluationTier: input.preparedRun.evaluationTier,
    metadata: input.preparedRun.metadata,
    onMessage: input.onMessage,
    onEvent: input.onEvent,
    interTurnHook: input.interTurnHook
  });
}
