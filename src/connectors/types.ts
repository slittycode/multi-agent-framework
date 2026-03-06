import type { ProviderId } from "../types/provider";

export type ConnectorAuthMethod = "api-key" | "chatgpt-oauth";
export type ConnectorCredentialSource = "env" | "keychain" | "codex-app-server";
export type ConnectorCertificationStatus = "never" | "passed" | "failed" | "blocked";
export type ConnectorRuntimeStatus = "ready" | "blocked";
export type ConnectorRuntimeStatusReason =
  | "oauth_not_implemented"
  | "credential_missing"
  | "auth_method_not_supported";

export interface ConnectorRecord {
  id: string;
  providerId: ProviderId;
  authMethod: ConnectorAuthMethod;
  defaultModel: string;
  credentialSource: ConnectorCredentialSource;
  credentialRef: string;
  lastCertifiedAt?: string;
  lastCertificationStatus: ConnectorCertificationStatus;
  runtimeStatus: ConnectorRuntimeStatus;
  runtimeStatusReason?: ConnectorRuntimeStatusReason;
  trackedIssueUrl?: string;
  baseURL?: string;
}

export interface ConnectorCatalog {
  schemaVersion: 1;
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
