import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import generalDebate from "../adapters/builtins/general-debate";
import { applyConnectorToAdapter } from "./adapter-override";
import {
  BENCHMARK_CERTIFICATION_TTL_MS,
  LIVE_CERTIFICATION_FIXED_TOPIC,
  QUICK_CERTIFICATION_TTL_MS,
  evaluateConnectorExecutionReadiness,
  normalizeLiveCertification,
  withUpdatedCertificationSummary
} from "./live-certification";
import { getActionabilityThreshold } from "../core/actionability";
import { runDiscussion } from "../core/orchestrator";
import {
  createLiveProviderClient,
  createProviderRegistryForRun
} from "../providers/provider-bootstrap";
import { CodexAppServerClient } from "../providers/clients/codex-app-server";
import type { Agent } from "../types";
import type {
  AvailableConnector,
  ConnectorCertificationLayerId,
  ConnectorCertificationLayerRecord,
  ConnectorCertificationProfile,
  ConnectorCertificationStatus,
  ConnectorRecord
} from "./types";

interface CertificationArtifactError {
  message: string;
  code?: string;
}

export interface AuthSmokeArtifact {
  generatedAt: string;
  connectorId: string;
  providerId: string;
  authMethod: string;
  credentialSource: string;
  defaultModel: string;
  passed: boolean;
  account?: {
    type: string;
    email?: string;
    planType?: string;
  };
  error?: CertificationArtifactError;
}

export interface ProviderSmokeArtifact {
  generatedAt: string;
  connectorId: string;
  providerId: string;
  model: string;
  credentialSource: string;
  passed: boolean;
  invocationId?: string;
  latencyMs?: number;
  error?: CertificationArtifactError;
}

export interface RunProbeArtifact {
  generatedAt: string;
  connectorId: string;
  providerId: string;
  adapterId: string;
  topic: string;
  runId: string;
  passed: boolean;
  actionabilityScore?: number;
  transcriptPath?: string;
  error?: CertificationArtifactError;
}

export interface CertificationManifest {
  generatedAt: string;
  profile: ConnectorCertificationProfile;
  profilePassed: boolean;
  connectorId: string;
  providerId: string;
  authMethod: string;
  defaultModel: string;
  credentialSource: string;
  overallStatus: ConnectorCertificationStatus;
  checkedAt?: string;
  freshUntil?: string;
  runner: {
    cwd: string;
    command: string;
  };
  layers: Record<ConnectorCertificationLayerId, ConnectorCertificationLayerRecord>;
}

export interface LayerCheckResult<TArtifact> {
  artifact: TArtifact;
  artifactPath: string;
  layer: ConnectorCertificationLayerRecord;
}

function addMs(timestamp: string, durationMs: number): string {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function buildLayerRecord(
  layerId: ConnectorCertificationLayerId,
  generatedAt: string,
  passed: boolean,
  artifactPath: string,
  message?: string
): ConnectorCertificationLayerRecord {
  const ttlMs = layerId === "benchmark" ? BENCHMARK_CERTIFICATION_TTL_MS : QUICK_CERTIFICATION_TTL_MS;
  return {
    status: passed ? "passed" : "failed",
    checkedAt: generatedAt,
    freshUntil: addMs(generatedAt, ttlMs),
    artifactPath,
    ...(message ? { message } : {})
  };
}

async function persistArtifact<TArtifact>(
  outputDir: string,
  name: string,
  artifact: TArtifact
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, name);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

function toArtifactError(error: unknown, providerId?: string): CertificationArtifactError {
  const message = error instanceof Error ? error.message : "Unknown certification failure.";
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;

  if (providerId === "kimi" && code === "PROVIDER_AUTH_FAILED") {
    return {
      message: `${message} Use a Moonshot platform API key from platform.moonshot.cn.`,
      ...(code ? { code } : {})
    };
  }

  return {
    message,
    ...(code ? { code } : {})
  };
}

export async function runAuthSmokeCheck(input: {
  connector: AvailableConnector;
  env: Record<string, string | undefined>;
  outputDir?: string;
}): Promise<LayerCheckResult<AuthSmokeArtifact>> {
  const outputDir = resolve(process.cwd(), input.outputDir ?? "./runs/auth");
  const generatedAt = new Date().toISOString();

  try {
    if (input.connector.credentialSource === "codex-app-server") {
      const appServer = new CodexAppServerClient({ env: input.env });
      try {
        const account = await appServer.getAccount({ refresh: true });
        if (!account.account || account.account.type !== "chatgpt") {
          throw new Error("OpenAI ChatGPT OAuth account is not available.");
        }

        const artifact: AuthSmokeArtifact = {
          generatedAt,
          connectorId: input.connector.id,
          providerId: input.connector.providerId,
          authMethod: input.connector.authMethod,
          credentialSource: input.connector.credentialSource,
          defaultModel: input.connector.defaultModel,
          passed: true,
          account: {
            type: account.account.type,
            ...(account.account.email ? { email: account.account.email } : {}),
            ...(account.account.planType ? { planType: account.account.planType } : {})
          }
        };
        const artifactPath = await persistArtifact(
          outputDir,
          `${input.connector.id}-${Date.now()}.auth-smoke.json`,
          artifact
        );

        return {
          artifact,
          artifactPath,
          layer: buildLayerRecord("auth", generatedAt, true, artifactPath)
        };
      } finally {
        await appServer.disconnect();
      }
    }

    const envName =
      input.connector.providerId === "gemini"
        ? "GEMINI_API_KEY"
        : input.connector.providerId === "kimi"
          ? "KIMI_API_KEY"
          : "OPENAI_API_KEY";
    const credentialValue = input.env[envName]?.trim();
    if (!credentialValue) {
      throw new Error(`Credential ${envName} is unavailable for connector "${input.connector.id}".`);
    }

    const artifact: AuthSmokeArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      authMethod: input.connector.authMethod,
      credentialSource: input.connector.credentialSource,
      defaultModel: input.connector.defaultModel,
      passed: true
    };
    const artifactPath = await persistArtifact(
      outputDir,
      `${input.connector.id}-${Date.now()}.auth-smoke.json`,
      artifact
    );

    return {
      artifact,
      artifactPath,
      layer: buildLayerRecord("auth", generatedAt, true, artifactPath)
    };
  } catch (error) {
    const artifact: AuthSmokeArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      authMethod: input.connector.authMethod,
      credentialSource: input.connector.credentialSource,
      defaultModel: input.connector.defaultModel,
      passed: false,
      error: toArtifactError(error, input.connector.providerId)
    };
    const artifactPath = await persistArtifact(
      outputDir,
      `${input.connector.id}-${Date.now()}.auth-smoke.json`,
      artifact
    );

    return {
      artifact,
      artifactPath,
      layer: buildLayerRecord("auth", generatedAt, false, artifactPath, artifact.error?.message)
    };
  }
}

export async function runProviderSmokeCheck(input: {
  connector: AvailableConnector;
  env: Record<string, string | undefined>;
  outputDir?: string;
}): Promise<LayerCheckResult<ProviderSmokeArtifact>> {
  const outputDir = resolve(process.cwd(), input.outputDir ?? "./runs/auth");
  const provider = createLiveProviderClient(input.connector.providerId, input.env, input.connector);
  const generatedAt = new Date().toISOString();
  const agent: Agent = {
    id: "provider-smoke",
    name: "Provider Smoke",
    role: "availability-check",
    persona: "Concise and factual",
    systemPrompt: "Confirm service availability in one short sentence.",
    llm: {
      provider: input.connector.providerId,
      model: input.connector.defaultModel,
      temperature: 0.1
    }
  };

  try {
    const result = await provider.generate({
      runId: `provider-smoke-${input.connector.id}`,
      agent,
      systemPrompt: agent.systemPrompt,
      prompt: "Confirm this provider is available for certification in one short sentence.",
      transcript: []
    });

    const artifact: ProviderSmokeArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      model: result.model,
      credentialSource: input.connector.credentialSource,
      passed: true,
      invocationId: result.invocationId,
      latencyMs: result.usage?.latencyMs
    };
    const artifactPath = await persistArtifact(
      outputDir,
      `${input.connector.id}-${Date.now()}.provider-smoke.json`,
      artifact
    );

    return {
      artifact,
      artifactPath,
      layer: buildLayerRecord("provider", generatedAt, true, artifactPath)
    };
  } catch (error) {
    const artifact: ProviderSmokeArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      model: input.connector.defaultModel,
      credentialSource: input.connector.credentialSource,
      passed: false,
      error: toArtifactError(error, input.connector.providerId)
    };
    const artifactPath = await persistArtifact(
      outputDir,
      `${input.connector.id}-${Date.now()}.provider-smoke.json`,
      artifact
    );

    return {
      artifact,
      artifactPath,
      layer: buildLayerRecord("provider", generatedAt, false, artifactPath, artifact.error?.message)
    };
  }
}

export async function runRunProbeCheck(input: {
  connector: AvailableConnector;
  env: Record<string, string | undefined>;
  outputDir?: string;
}): Promise<LayerCheckResult<RunProbeArtifact>> {
  const outputDir = resolve(process.cwd(), input.outputDir ?? "./runs/auth");
  const transcriptOutputDir = join(outputDir, "transcripts");
  const generatedAt = new Date().toISOString();
  const runId = `live-cert-run-${input.connector.id}`;

  try {
    await mkdir(transcriptOutputDir, { recursive: true });
    const adapter = applyConnectorToAdapter(generalDebate, input.connector);
    const providerRegistry = createProviderRegistryForRun({
      adapter,
      providerMode: "live",
      env: input.env,
      connectorByProviderId: {
        [input.connector.providerId]: input.connector
      }
    });
    const result = await runDiscussion({
      adapter,
      topic: LIVE_CERTIFICATION_FIXED_TOPIC,
      providerRegistry,
      runId,
      evaluationTier: "live_certification",
      config: {
        qualityGate: {
          enabled: true,
          threshold: getActionabilityThreshold("live_certification")
        },
        transcript: {
          persistToFile: true,
          outputDir: transcriptOutputDir,
          format: "json"
        }
      }
    });
    const actionability = (result.context.transcript.metadata as { qualityGate?: unknown } | undefined)
      ?.qualityGate as { score?: number; passed?: boolean } | undefined;
    const passed = Boolean(actionability?.passed);
    const artifact: RunProbeArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      adapterId: adapter.id,
      topic: LIVE_CERTIFICATION_FIXED_TOPIC,
      runId,
      passed,
      ...(typeof actionability?.score === "number" ? { actionabilityScore: actionability.score } : {}),
      ...(result.persistedPath ? { transcriptPath: result.persistedPath } : {})
    };
    const artifactPath = await persistArtifact(
      outputDir,
      `${input.connector.id}-${Date.now()}.run-probe.json`,
      artifact
    );

    return {
      artifact,
      artifactPath,
      layer: buildLayerRecord(
        "run",
        generatedAt,
        passed,
        artifactPath,
        passed ? undefined : "Run probe fell below the live actionability threshold."
      )
    };
  } catch (error) {
    const artifact: RunProbeArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      adapterId: generalDebate.id,
      topic: LIVE_CERTIFICATION_FIXED_TOPIC,
      runId,
      passed: false,
      error: toArtifactError(error, input.connector.providerId)
    };
    const artifactPath = await persistArtifact(
      outputDir,
      `${input.connector.id}-${Date.now()}.run-probe.json`,
      artifact
    );

    return {
      artifact,
      artifactPath,
      layer: buildLayerRecord("run", generatedAt, false, artifactPath, artifact.error?.message)
    };
  }
}

export function updateConnectorCertification(input: {
  connector: ConnectorRecord;
  profile: ConnectorCertificationProfile;
  generatedAt: string;
  manifestPath?: string;
  layerUpdates: Partial<Record<ConnectorCertificationLayerId, ConnectorCertificationLayerRecord>>;
}): ConnectorRecord {
  const existing = normalizeLiveCertification(input.connector.liveCertification);
  const merged = {
    ...existing,
    latestProfile: input.profile,
    checkedAt: input.generatedAt,
    ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
    layers: {
      ...existing.layers,
      ...input.layerUpdates
    }
  };

  return withUpdatedCertificationSummary({
    ...input.connector,
    liveCertification: merged,
    lastCertifiedAt: input.generatedAt
  });
}

export async function persistCertificationManifest(input: {
  connector: AvailableConnector;
  profile: ConnectorCertificationProfile;
  outputDir?: string;
  profilePassed: boolean;
  updatedConnector: ConnectorRecord;
}): Promise<{
  manifest: CertificationManifest;
  manifestPath: string;
}> {
  const outputDir = resolve(process.cwd(), input.outputDir ?? "./runs/auth");
  await mkdir(outputDir, { recursive: true });
  const liveCertification = normalizeLiveCertification(input.updatedConnector.liveCertification);
  const readiness = evaluateConnectorExecutionReadiness({
    id: input.updatedConnector.id,
    runtimeStatus: input.updatedConnector.runtimeStatus,
    runtimeStatusReason: input.updatedConnector.runtimeStatusReason,
    liveCertification
  });
  const manifest: CertificationManifest = {
    generatedAt: liveCertification.checkedAt ?? new Date().toISOString(),
    profile: input.profile,
    profilePassed: input.profilePassed,
    connectorId: input.connector.id,
    providerId: input.connector.providerId,
    authMethod: input.connector.authMethod,
    defaultModel: input.connector.defaultModel,
    credentialSource: input.connector.credentialSource,
    overallStatus: readiness.overallStatus,
    ...(liveCertification.checkedAt ? { checkedAt: liveCertification.checkedAt } : {}),
    ...(readiness.freshUntil ? { freshUntil: readiness.freshUntil } : {}),
    runner: {
      cwd: process.cwd(),
      command: process.argv.join(" ")
    },
    layers: {
      auth: {
        ...liveCertification.layers.auth,
        ...(liveCertification.layers.auth.artifactPath
          ? { artifactPath: relative(outputDir, liveCertification.layers.auth.artifactPath) }
          : {})
      },
      provider: {
        ...liveCertification.layers.provider,
        ...(liveCertification.layers.provider.artifactPath
          ? { artifactPath: relative(outputDir, liveCertification.layers.provider.artifactPath) }
          : {})
      },
      run: {
        ...liveCertification.layers.run,
        ...(liveCertification.layers.run.artifactPath
          ? { artifactPath: relative(outputDir, liveCertification.layers.run.artifactPath) }
          : {})
      },
      benchmark: {
        ...liveCertification.layers.benchmark,
        ...(liveCertification.layers.benchmark.artifactPath
          ? { artifactPath: relative(outputDir, liveCertification.layers.benchmark.artifactPath) }
          : {})
      }
    }
  };
  const manifestPath = await persistArtifact(
    outputDir,
    `${input.connector.id}-${Date.now()}.certification-manifest.json`,
    manifest
  );

  return { manifest, manifestPath };
}
