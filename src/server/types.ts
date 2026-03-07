export interface ApiRunStartRequest {
  adapterId: string;
  topic: string;
  connectorId?: string;
  model?: string;
}

export interface ApiRunListEntry {
  runId: string;
  adapterId: string;
  topic: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  actionabilityScore?: number;
}

export interface ApiRunCompleteEventMessage {
  runId: string;
  status: "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  persistedPath?: string;
}

export interface ApiConnectorListEntry {
  id: string;
  active: boolean;
  providerId: string;
  authMethod: string;
  credentialSource: string;
  ephemeral: boolean;
  defaultModel: string;
  runtimeStatus: string;
  runtimeStatusReason?: string;
  certificationStatus: string;
  certificationProfile?: string;
  trackedIssueUrl?: string;
  providerNote?: string;
}
