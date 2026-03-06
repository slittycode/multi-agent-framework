import { benchmarkCommand } from "./commands/benchmark";
import { listAdaptersCommand } from "./commands/list-adapters";
import { runCommand } from "./commands/run";

function printUsage(): void {
  console.log([
    "Usage:",
    "  bun run start -- list-adapters",
    "  bun run start -- benchmark [--provider-mode mock|live|auto] [--output-dir <dir>]",
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
