import { loadConnectorCatalog } from "./catalog";
import type { CredentialStore } from "./credential-store";
import { discoverEnvConnectors } from "./env-connectors";
import { describeProviderSupport } from "../providers/provider-support";
import { isConnectorBlocked, type AvailableConnector, type ConnectorCatalog } from "./types";

export type ExecutionMode = "mock" | "live" | "auto";

export interface ResolvedExecutionContext {
  requestedExecutionMode: ExecutionMode;
  resolvedExecutionMode: "mock" | "live";
  catalog: ConnectorCatalog;
  activeConnectorId?: string;
  availableConnectors: AvailableConnector[];
  connector?: AvailableConnector;
  envOverlay: Record<string, string>;
}

export interface ResolvedConnector {
  connector: AvailableConnector;
  envOverlay: Record<string, string>;
}

function formatBlockedConnectorMessage(connector: AvailableConnector): string {
  const reason = connector.runtimeStatusReason ?? "auth_method_not_supported";
  const suffix = connector.trackedIssueUrl ? ` See ${connector.trackedIssueUrl}` : "";
  return `Connector "${connector.id}" is blocked: ${reason}.${suffix}`;
}

function buildEnvOverlay(
  connector: AvailableConnector,
  credentialValue: string
): Record<string, string> {
  switch (connector.providerId) {
    case "gemini":
      return { GEMINI_API_KEY: credentialValue };
    case "kimi":
      return {
        KIMI_API_KEY: credentialValue,
        ...(connector.baseURL ? { KIMI_BASE_URL: connector.baseURL } : {})
      };
    case "openai":
      return { OPENAI_API_KEY: credentialValue };
    default:
      return {};
  }
}

function isEnvBackedConnectorId(connectorId: string): boolean {
  return connectorId.endsWith("-env");
}

function getEnvConnectorRemediation(connectorId: string): string {
  switch (connectorId) {
    case "gemini-env":
      return "export GEMINI_API_KEY again or select/store another connector.";
    case "kimi-env":
      return "export KIMI_API_KEY again or select/store another connector.";
    case "openai-env":
      return "export OPENAI_API_KEY again or select/store another connector.";
    default:
      return "restore the environment-backed connector or select/store another connector.";
  }
}

export async function listAvailableConnectors(input: {
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): Promise<{
  catalog: ConnectorCatalog;
  activeConnectorId?: string;
  connectors: AvailableConnector[];
}> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const catalog = await loadConnectorCatalog(input);
  const envConnectors = discoverEnvConnectors(env);
  const storedConnectors: AvailableConnector[] = catalog.connectors.map((connector) => ({
    ...connector,
    ephemeral: false
  }));

  return {
    catalog,
    activeConnectorId: catalog.activeConnectorId,
    connectors: [...storedConnectors, ...envConnectors]
  };
}

async function materializeConnector(
  connector: AvailableConnector,
  input: {
    env?: Record<string, string | undefined>;
    credentialStore: CredentialStore;
  }
): Promise<ResolvedConnector> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  if (isConnectorBlocked(connector)) {
    throw new Error(formatBlockedConnectorMessage(connector));
  }

  const support = describeProviderSupport(connector.providerId);
  if (!support.liveCapable) {
    throw new Error(`Provider "${connector.providerId}" is not live-capable.`);
  }

  if (connector.credentialSource === "env") {
    const credentialValue = env[connector.credentialRef]?.trim();
    if (!credentialValue) {
      throw new Error(`Connector "${connector.id}" is unavailable because ${connector.credentialRef} is missing.`);
    }

    return {
      connector,
      envOverlay: buildEnvOverlay(connector, credentialValue)
    };
  }

  if (connector.credentialSource === "codex-app-server") {
    return {
      connector,
      envOverlay: {}
    };
  }

  if (!(await input.credentialStore.isAvailable())) {
    throw new Error(
      "Interactive credential storage is unavailable on this platform. Use env-backed connectors instead."
    );
  }

  const credentialValue = await input.credentialStore.get(connector.credentialRef);
  if (!credentialValue) {
    throw new Error(`Connector "${connector.id}" is configured but its stored credential is unavailable.`);
  }

  return {
    connector,
    envOverlay: buildEnvOverlay(connector, credentialValue)
  };
}

export async function resolveConnectorById(input: {
  connectorId: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  credentialStore: CredentialStore;
}): Promise<ResolvedConnector> {
  const available = await listAvailableConnectors(input);
  const connector = available.connectors.find((candidate) => candidate.id === input.connectorId);

  if (!connector) {
    throw new Error(`Connector "${input.connectorId}" is not available.`);
  }

  return materializeConnector(connector, input);
}

export async function resolveExecutionContext(input: {
  cwd?: string;
  executionMode: ExecutionMode;
  explicitConnectorId?: string;
  env?: Record<string, string | undefined>;
  credentialStore: CredentialStore;
}): Promise<ResolvedExecutionContext> {
  const available = await listAvailableConnectors(input);
  const activeConnectorId = available.activeConnectorId;
  const envConnectors = available.connectors.filter(
    (connector) => connector.ephemeral && !isConnectorBlocked(connector)
  );

  if (input.executionMode === "mock") {
    return {
      requestedExecutionMode: "mock",
      resolvedExecutionMode: "mock",
      catalog: available.catalog,
      activeConnectorId,
      availableConnectors: available.connectors,
      envOverlay: {}
    };
  }

  if (input.explicitConnectorId) {
    const connector = available.connectors.find((candidate) => candidate.id === input.explicitConnectorId);

    if (!connector) {
      throw new Error(`Connector "${input.explicitConnectorId}" is not available.`);
    }

    const resolved = await materializeConnector(connector, input);
    return {
      requestedExecutionMode: input.executionMode,
      resolvedExecutionMode: "live",
      catalog: available.catalog,
      activeConnectorId,
      availableConnectors: available.connectors,
      connector: resolved.connector,
      envOverlay: resolved.envOverlay
    };
  }

  let activeConnector = activeConnectorId
    ? available.connectors.find((candidate) => candidate.id === activeConnectorId)
    : undefined;
  const staleEnvBackedActiveConnector =
    Boolean(activeConnectorId) && !activeConnector && isEnvBackedConnectorId(activeConnectorId as string);

  if (activeConnectorId && !activeConnector) {
    if (staleEnvBackedActiveConnector && input.executionMode === "auto") {
      activeConnector = undefined;
    } else if (isEnvBackedConnectorId(activeConnectorId)) {
      throw new Error(
        `Active connector "${activeConnectorId}" is not available. ${getEnvConnectorRemediation(
          activeConnectorId
        )}`
      );
    } else {
      throw new Error(`Active connector "${activeConnectorId}" is not available.`);
    }
  }

  if (activeConnector && !isConnectorBlocked(activeConnector)) {
    const resolved = await materializeConnector(activeConnector, input);
    return {
      requestedExecutionMode: input.executionMode,
      resolvedExecutionMode: "live",
      catalog: available.catalog,
      activeConnectorId,
      availableConnectors: available.connectors,
      connector: resolved.connector,
      envOverlay: resolved.envOverlay
    };
  }

  if (activeConnector && isConnectorBlocked(activeConnector) && input.executionMode === "live") {
    throw new Error(formatBlockedConnectorMessage(activeConnector));
  }

  if (!activeConnector && staleEnvBackedActiveConnector && input.executionMode === "auto") {
    const storedReadyConnectors = available.connectors.filter(
      (connector) => !connector.ephemeral && !isConnectorBlocked(connector)
    );

    if (storedReadyConnectors.length === 1) {
      const resolved = await materializeConnector(storedReadyConnectors[0] as AvailableConnector, input);
      return {
        requestedExecutionMode: "auto",
        resolvedExecutionMode: "live",
        catalog: available.catalog,
        activeConnectorId,
        availableConnectors: available.connectors,
        connector: resolved.connector,
        envOverlay: resolved.envOverlay
      };
    }

    if (storedReadyConnectors.length > 1) {
      throw new Error(
        "Multiple live connectors are available. Select one explicitly with --connector or connector use."
      );
    }
  }

  if (envConnectors.length === 1) {
    const resolved = await materializeConnector(envConnectors[0] as AvailableConnector, input);
    return {
      requestedExecutionMode: input.executionMode,
      resolvedExecutionMode: "live",
      catalog: available.catalog,
      activeConnectorId,
      availableConnectors: available.connectors,
      connector: resolved.connector,
      envOverlay: resolved.envOverlay
    };
  }

  if (envConnectors.length > 1) {
    throw new Error(
      "Multiple live connectors are available. Select one explicitly with --connector or connector use."
    );
  }

  if (input.executionMode === "live") {
    throw new Error("No live connector is configured. Use auth login or export a single provider API key.");
  }

  return {
    requestedExecutionMode: "auto",
    resolvedExecutionMode: "mock",
    catalog: available.catalog,
    activeConnectorId,
    availableConnectors: available.connectors,
    envOverlay: {}
  };
}
