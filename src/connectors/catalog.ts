import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { describeProviderSupport } from "../providers/provider-support";
import type { ConnectorCatalog, ConnectorRecord } from "./types";

const SCHEMA_VERSION = 1 as const;

function emptyCatalog(): ConnectorCatalog {
  return {
    schemaVersion: SCHEMA_VERSION,
    connectors: []
  };
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeConnectorRecord(value: unknown): ConnectorRecord {
  if (!isObjectLike(value)) {
    throw new Error("Connector record must be an object.");
  }

  const id = value.id;
  const providerId = value.providerId;
  const authMethod = value.authMethod;
  const defaultModel = value.defaultModel;
  const credentialSource = value.credentialSource;
  const credentialRef = value.credentialRef;
  const lastCertificationStatus = value.lastCertificationStatus;
  const runtimeStatus = value.runtimeStatus;
  const runtimeStatusReason = value.runtimeStatusReason;
  const providerNote =
    typeof value.providerNote === "string"
      ? value.providerNote
      : describeProviderSupport(providerId as ConnectorRecord["providerId"]).providerNote;

  if (
    typeof id !== "string" ||
    typeof providerId !== "string" ||
    (authMethod !== "api-key" && authMethod !== "chatgpt-oauth") ||
    typeof defaultModel !== "string" ||
    (credentialSource !== "env" &&
      credentialSource !== "keychain" &&
      credentialSource !== "codex-app-server") ||
    typeof credentialRef !== "string" ||
    (lastCertificationStatus !== "never" &&
      lastCertificationStatus !== "passed" &&
      lastCertificationStatus !== "failed" &&
      lastCertificationStatus !== "blocked") ||
    (runtimeStatus !== undefined && runtimeStatus !== "ready" && runtimeStatus !== "blocked") ||
    (runtimeStatusReason !== undefined &&
      runtimeStatusReason !== "oauth_not_implemented" &&
      runtimeStatusReason !== "credential_missing" &&
      runtimeStatusReason !== "auth_method_not_supported")
  ) {
    throw new Error("Connector record is missing required fields.");
  }

  const normalizedRuntimeStatus = runtimeStatus === "blocked" ? "blocked" : "ready";

  return {
    id,
    providerId,
    authMethod,
    defaultModel,
    credentialSource,
    credentialRef,
    lastCertificationStatus,
    runtimeStatus: normalizedRuntimeStatus,
    ...(typeof value.lastCertifiedAt === "string" ? { lastCertifiedAt: value.lastCertifiedAt } : {}),
    ...(typeof runtimeStatusReason === "string" ? { runtimeStatusReason } : {}),
    ...(typeof value.trackedIssueUrl === "string" ? { trackedIssueUrl: value.trackedIssueUrl } : {}),
    ...(typeof value.baseURL === "string" ? { baseURL: value.baseURL } : {}),
    ...(typeof providerNote === "string" ? { providerNote } : {})
  };
}

function normalizeCatalog(value: unknown): ConnectorCatalog {
  if (!isObjectLike(value)) {
    throw new Error("Connector catalog must be an object.");
  }

  const schemaVersion = value.schemaVersion;
  const connectors = value.connectors;

  if (schemaVersion !== SCHEMA_VERSION || !Array.isArray(connectors)) {
    throw new Error("Connector catalog has an invalid schema.");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    ...(typeof value.activeConnectorId === "string"
      ? { activeConnectorId: value.activeConnectorId }
      : {}),
    connectors: connectors.map((connector) => normalizeConnectorRecord(connector))
  };
}

export function resolveConnectorCatalogPath(input: {
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): string {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const stateDir = env.MAF_STATE_DIR?.trim();

  if (stateDir) {
    return resolve(stateDir, "connectors.json");
  }

  const cwd = input.cwd ?? process.cwd();
  return join(cwd, ".multi-agent-framework", "connectors.json");
}

export async function loadConnectorCatalog(input: {
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): Promise<ConnectorCatalog> {
  const path = resolveConnectorCatalogPath(input);

  if (!existsSync(path)) {
    return emptyCatalog();
  }

  const contents = await readFile(path, "utf8");
  return normalizeCatalog(JSON.parse(contents) as unknown);
}

export async function saveConnectorCatalog(
  catalog: ConnectorCatalog,
  input: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<string> {
  const path = resolveConnectorCatalogPath(input);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  return path;
}
