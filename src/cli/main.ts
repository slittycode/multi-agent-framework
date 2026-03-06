import { authCommand } from "./commands/auth";
import { benchmarkCommand } from "./commands/benchmark";
import { connectorCommand } from "./commands/connector";
import { listAdaptersCommand } from "./commands/list-adapters";
import { runCommand } from "./commands/run";

function printUsage(): void {
  console.log([
    "Usage:",
    "  bun run start -- auth <login|status|logout|certify> [...]",
    "  bun run start -- connector <list|use> [...]",
    "  bun run start -- list-adapters",
    "  bun run start -- benchmark [--execution-mode mock|live|auto] [--connector <id>] [--all-connectors] [--output-dir <dir>]",
    "  bun run start -- run --adapter-id <id> --topic <text>",
    "  bun run start -- run --adapter-file <path> --topic <text>"
  ].join("\n"));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;

  if (!command) {
    printUsage();
    return 1;
  }

  switch (command) {
    case "auth":
      return authCommand(args);
    case "connector":
      return connectorCommand(args);
    case "list-adapters":
      return listAdaptersCommand();
    case "benchmark":
      return benchmarkCommand(args);
    case "run":
      return runCommand(args);
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      return 1;
  }
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Unhandled CLI failure.");
      process.exit(1);
    });
}
