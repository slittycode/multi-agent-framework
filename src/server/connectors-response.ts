import type { AvailableConnector } from "../connectors/types";
import type { ApiConnectorListEntry } from "./types";

export function formatConnectorListResponse(input: {
  activeConnectorId?: string;
  connectors: AvailableConnector[];
}): ApiConnectorListEntry[] {
  return [...input.connectors]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((connector) => ({
      id: connector.id,
      active: input.activeConnectorId === connector.id,
      providerId: connector.providerId,
      authMethod: connector.authMethod,
      credentialSource: connector.credentialSource,
      ephemeral: connector.ephemeral,
      defaultModel: connector.defaultModel,
      runtimeStatus: connector.runtimeStatus,
      runtimeStatusReason: connector.runtimeStatusReason,
      certificationStatus: connector.lastCertificationStatus,
      certificationProfile: connector.liveCertification?.latestProfile,
      trackedIssueUrl: connector.trackedIssueUrl,
      providerNote: connector.providerNote
    }));
}
