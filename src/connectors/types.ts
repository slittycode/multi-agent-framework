import type { ProviderId } from "../types/provider";

export type ConnectorAuthMethod = "api-key" | "chatgpt-oauth";
export type ConnectorCredentialSource = "env" | "keychain" | "codex-app-server";
export type ConnectorCertificationStatus = "never" | "passed" | "failed" | "blocked" | "stale";
export type ConnectorCertificationProfile = "auth" | "smoke" | "full" | "benchmark";
export type ConnectorCertificationLayerId = "auth" | "provider" | "run" | "benchmark";
export type ConnectorCertificationLayerStatus = "never" | "passed" | "failed";
export type ConnectorRuntimeStatus = "ready" | "blocked";
export type ConnectorRuntimeStatusReason =
  | "oauth_not_implemented"
  | "credential_missing"
  | "auth_method_not_supported";

export interface ConnectorCertificationLayerRecord {
  status: ConnectorCertificationLayerStatus;
  checkedAt?: string;
  freshUntil?: string;
  artifactPath?: string;
  message?: string;
}

export interface ConnectorLiveCertification {
  latestProfile?: ConnectorCertificationProfile;
  overallStatus: ConnectorCertificationStatus;
  checkedAt?: string;
  freshUntil?: string;
  manifestPath?: string;
  layers: Record<ConnectorCertificationLayerId, ConnectorCertificationLayerRecord>;
}

export interface ConnectorRecord {
  id: string;
  providerId: ProviderId;
  authMethod: ConnectorAuthMethod;
  defaultModel: string;
  credentialSource: ConnectorCredentialSource;
  credentialRef: string;
  lastCertifiedAt?: string;
  lastCertificationStatus: ConnectorCertificationStatus;
  liveCertification?: ConnectorLiveCertification;
  runtimeStatus: ConnectorRuntimeStatus;
  runtimeStatusReason?: ConnectorRuntimeStatusReason;
  trackedIssueUrl?: string;
  baseURL?: string;
  providerNote?: string;
}

export interface ConnectorCatalog {
  schemaVersion: 2;
  activeConnectorId?: string;
  connectors: ConnectorRecord[];
}

export interface AvailableConnector extends ConnectorRecord {
  ephemeral: boolean;
}

export function isConnectorBlocked(
  connector: Pick<ConnectorRecord, "runtimeStatus">
): boolean {
  return connector.runtimeStatus === "blocked";
}
