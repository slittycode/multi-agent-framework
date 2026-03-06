import { loadConnectorCatalog, saveConnectorCatalog } from "../../connectors/catalog";
import { listAvailableConnectors } from "../../connectors/connector-resolution";
import { isConnectorBlocked } from "../../connectors/types";

type ConnectorSubcommand = "list" | "use";

function getConnectorUsage(): string {
  return [
    "Usage:",
    "  connector list",
    "  connector use --connector <id>"
  ].join("\n");
}

export async function connectorCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  try {
    switch (subcommand as ConnectorSubcommand) {
      case "list": {
        const available = await listAvailableConnectors({
          env: process.env as Record<string, string | undefined>
        });

        if (available.connectors.length === 0) {
          console.log("No connectors are configured.");
          return 0;
        }

        console.log("Connectors:");
        for (const connector of available.connectors.sort((left, right) => left.id.localeCompare(right.id))) {
          const active = available.activeConnectorId === connector.id ? " (active)" : "";
          const ephemeral = connector.ephemeral ? " [env]" : "";
          const status =
            connector.runtimeStatus === "blocked"
              ? `, status=blocked(${connector.runtimeStatusReason ?? "unknown"})`
              : ", status=ready";
          const tracking = connector.trackedIssueUrl ? `, tracking=${connector.trackedIssueUrl}` : "";
          console.log(
            `- ${connector.id}${active}: provider=${connector.providerId}, auth=${connector.authMethod}, source=${connector.credentialSource}${ephemeral}, model=${connector.defaultModel}${status}${tracking}`
          );
        }
        return 0;
      }
      case "use": {
        let connectorId: string | undefined;

        for (let index = 0; index < rest.length; index += 1) {
          const token = rest[index];
          if (token === "--connector") {
            connectorId = rest[index + 1];
            index += 1;
            continue;
          }

          throw new Error(`Unknown argument: ${token}`);
        }

        if (!connectorId?.trim()) {
          throw new Error("connector use requires --connector <id>");
        }

        const available = await listAvailableConnectors({
          env: process.env as Record<string, string | undefined>
        });
        const connector = available.connectors.find((candidate) => candidate.id === connectorId);
        if (!connector) {
          throw new Error(`Connector "${connectorId}" is not available.`);
        }
        if (isConnectorBlocked(connector)) {
          throw new Error(
            `Connector "${connectorId}" is blocked (${connector.runtimeStatusReason}) and cannot be activated.`
          );
        }

        const catalog = await loadConnectorCatalog();
        await saveConnectorCatalog({
          ...catalog,
          activeConnectorId: connectorId
        });

        console.log(`Active connector: ${connectorId}`);
        return 0;
      }
      default:
        console.error(getConnectorUsage());
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Connector command failed.");
    return 1;
  }
}
