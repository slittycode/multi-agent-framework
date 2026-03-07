import type {
  ConnectorCertificationLayerId,
  ConnectorCertificationLayerRecord,
  ConnectorCertificationProfile,
  ConnectorCertificationStatus,
  ConnectorLiveCertification,
  ConnectorRecord,
  ConnectorRuntimeStatus,
  ConnectorRuntimeStatusReason
} from "./types";

export type { ConnectorLiveCertification } from "./types";

export const QUICK_CERTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const BENCHMARK_CERTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LIVE_CERTIFICATION_FIXED_TOPIC =
  "Should teams default to async communication for cross-functional planning?";

function isValidStatus(value: unknown): value is ConnectorCertificationStatus {
  return (
    value === "never" ||
    value === "passed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "stale"
  );
}

function isValidProfile(value: unknown): value is ConnectorCertificationProfile {
  return value === "auth" || value === "smoke" || value === "full" || value === "benchmark";
}

function isValidLayerStatus(value: unknown): value is ConnectorCertificationLayerRecord["status"] {
  return value === "never" || value === "passed" || value === "failed";
}

function normalizeLayerRecord(value: unknown): ConnectorCertificationLayerRecord {
  if (typeof value !== "object" || value === null) {
    return { status: "never" };
  }

  const candidate = value as Record<string, unknown>;
  return {
    status: isValidLayerStatus(candidate.status) ? candidate.status : "never",
    ...(typeof candidate.checkedAt === "string" ? { checkedAt: candidate.checkedAt } : {}),
    ...(typeof candidate.freshUntil === "string" ? { freshUntil: candidate.freshUntil } : {}),
    ...(typeof candidate.artifactPath === "string" ? { artifactPath: candidate.artifactPath } : {}),
    ...(typeof candidate.message === "string" ? { message: candidate.message } : {})
  };
}

function toIsoString(value: Date): string {
  return value.toISOString();
}

function minIsoString(values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return [...values].sort((left, right) => left.localeCompare(right))[0];
}

export function createEmptyLiveCertification(): ConnectorLiveCertification {
  return {
    overallStatus: "never",
    layers: {
      auth: { status: "never" },
      provider: { status: "never" },
      run: { status: "never" },
      benchmark: { status: "never" }
    }
  };
}

export function normalizeLiveCertification(
  value: unknown,
  fallbackStatus: ConnectorCertificationStatus = "never",
  fallbackCheckedAt?: string
): ConnectorLiveCertification {
  if (typeof value !== "object" || value === null) {
    return {
      ...createEmptyLiveCertification(),
      overallStatus: fallbackStatus,
      ...(fallbackCheckedAt ? { checkedAt: fallbackCheckedAt } : {})
    };
  }

  const candidate = value as Record<string, unknown>;
  const layers =
    typeof candidate.layers === "object" && candidate.layers !== null
      ? (candidate.layers as Record<string, unknown>)
      : {};

  return {
    overallStatus: isValidStatus(candidate.overallStatus) ? candidate.overallStatus : fallbackStatus,
    ...(isValidProfile(candidate.latestProfile) ? { latestProfile: candidate.latestProfile } : {}),
    ...(typeof candidate.checkedAt === "string"
      ? { checkedAt: candidate.checkedAt }
      : fallbackCheckedAt
        ? { checkedAt: fallbackCheckedAt }
        : {}),
    ...(typeof candidate.freshUntil === "string" ? { freshUntil: candidate.freshUntil } : {}),
    ...(typeof candidate.manifestPath === "string" ? { manifestPath: candidate.manifestPath } : {}),
    layers: {
      auth: normalizeLayerRecord(layers.auth),
      provider: normalizeLayerRecord(layers.provider),
      run: normalizeLayerRecord(layers.run),
      benchmark: normalizeLayerRecord(layers.benchmark)
    }
  };
}

export function migrateLegacyLiveCertification(input: {
  runtimeStatus: ConnectorRuntimeStatus;
  runtimeStatusReason?: ConnectorRuntimeStatusReason;
  lastCertificationStatus?: ConnectorCertificationStatus;
  lastCertifiedAt?: string;
  liveCertification?: unknown;
}): ConnectorLiveCertification {
  const legacyStatus =
    input.runtimeStatus === "blocked"
      ? "blocked"
      : input.lastCertificationStatus === "passed"
        ? "stale"
        : input.lastCertificationStatus ?? "never";

  const normalized = normalizeLiveCertification(
    input.liveCertification,
    legacyStatus,
    input.lastCertifiedAt
  );

  if (input.runtimeStatus === "blocked") {
    return {
      ...normalized,
      overallStatus: "blocked"
    };
  }

  return normalized;
}

function isFresh(layer: ConnectorCertificationLayerRecord, now: Date): boolean {
  return (
    layer.status === "passed" &&
    typeof layer.freshUntil === "string" &&
    layer.freshUntil.localeCompare(toIsoString(now)) >= 0
  );
}

function evaluateQuickLayerState(
  layerId: Exclude<ConnectorCertificationLayerId, "benchmark">,
  layer: ConnectorCertificationLayerRecord,
  now: Date
): {
  status: ConnectorCertificationStatus;
  reason: string;
  requiredProfile: ConnectorCertificationProfile;
} | null {
  if (layer.status === "failed") {
    return {
      status: "failed",
      reason: `${layerId} certification failed.`,
      requiredProfile: "smoke"
    };
  }

  if (layer.status === "never") {
    return {
      status: "never",
      reason: `${layerId} certification has not been recorded yet.`,
      requiredProfile: "smoke"
    };
  }

  if (!isFresh(layer, now)) {
    return {
      status: "stale",
      reason: `${layerId} certification has gone stale.`,
      requiredProfile: "smoke"
    };
  }

  return null;
}

function evaluateBenchmarkState(
  layer: ConnectorCertificationLayerRecord,
  now: Date
): {
  status: ConnectorCertificationStatus;
  reason: string;
  requiredProfile: ConnectorCertificationProfile;
} | null {
  if (layer.status === "failed") {
    return {
      status: "failed",
      reason: "benchmark certification failed.",
      requiredProfile: "full"
    };
  }

  if (layer.status === "never") {
    return {
      status: "never",
      reason: "full certification is required before live execution.",
      requiredProfile: "full"
    };
  }

  if (!isFresh(layer, now)) {
    return {
      status: "stale",
      reason: "benchmark certification has gone stale.",
      requiredProfile: "full"
    };
  }

  return null;
}

export function evaluateConnectorExecutionReadiness(
  connector: Pick<ConnectorRecord, "runtimeStatus" | "runtimeStatusReason" | "liveCertification" | "id">,
  input: {
    now?: Date;
  } = {}
): {
  overallStatus: ConnectorCertificationStatus;
  runnable: boolean;
  reason: string;
  requiredProfile?: ConnectorCertificationProfile;
  freshUntil?: string;
} {
  if (connector.runtimeStatus === "blocked") {
    return {
      overallStatus: "blocked",
      runnable: false,
      reason: `Connector "${connector.id}" is blocked (${connector.runtimeStatusReason ?? "unknown"}).`
    };
  }

  const now = input.now ?? new Date();
  const certification = normalizeLiveCertification(connector.liveCertification);
  const quickLayers: Array<Exclude<ConnectorCertificationLayerId, "benchmark">> = [
    "auth",
    "provider",
    "run"
  ];

  for (const layerId of quickLayers) {
    const layerState = evaluateQuickLayerState(layerId, certification.layers[layerId], now);
    if (layerState) {
      return {
        overallStatus: layerState.status,
        runnable: false,
        reason: layerState.reason,
        requiredProfile: layerState.requiredProfile
      };
    }
  }

  const benchmarkState = evaluateBenchmarkState(certification.layers.benchmark, now);
  if (benchmarkState) {
    return {
      overallStatus: benchmarkState.status,
      runnable: false,
      reason: benchmarkState.reason,
      requiredProfile: benchmarkState.requiredProfile
    };
  }

  const freshUntil = minIsoString(
    ["auth", "provider", "run", "benchmark"]
      .map((layerId) => certification.layers[layerId as ConnectorCertificationLayerId].freshUntil)
      .filter((value): value is string => typeof value === "string")
  );

  return {
    overallStatus: "passed",
    runnable: true,
    reason: "Live certification is current.",
    ...(freshUntil ? { freshUntil } : {})
  };
}

export function withUpdatedCertificationSummary(
  connector: ConnectorRecord,
  input: {
    now?: Date;
  } = {}
): ConnectorRecord {
  const liveCertification = migrateLegacyLiveCertification({
    runtimeStatus: connector.runtimeStatus,
    runtimeStatusReason: connector.runtimeStatusReason,
    lastCertificationStatus: connector.lastCertificationStatus,
    lastCertifiedAt: connector.lastCertifiedAt,
    liveCertification: connector.liveCertification
  });
  const readiness = evaluateConnectorExecutionReadiness(
    {
      id: connector.id,
      runtimeStatus: connector.runtimeStatus,
      runtimeStatusReason: connector.runtimeStatusReason,
      liveCertification
    },
    input
  );

  return {
    ...connector,
    liveCertification: {
      ...liveCertification,
      overallStatus: readiness.overallStatus,
      ...(readiness.freshUntil ? { freshUntil: readiness.freshUntil } : {})
    },
    lastCertificationStatus: readiness.overallStatus,
    ...(liveCertification.checkedAt ? { lastCertifiedAt: liveCertification.checkedAt } : {})
  };
}

export function buildLiveExecutionRemediation(
  connector: Pick<ConnectorRecord, "id">,
  readiness: ReturnType<typeof evaluateConnectorExecutionReadiness>
): string {
  if (readiness.overallStatus === "blocked") {
    return readiness.reason;
  }

  const requiredProfile = readiness.requiredProfile ?? "full";
  return [
    `Connector "${connector.id}" is not ready for live execution: ${readiness.reason}`,
    `Run bun run start -- auth certify --profile ${requiredProfile} --connector ${connector.id}.`
  ].join(" ");
}
