import { startApiServer } from "./app";

function parsePort(argv: string[]): number {
  let port = 3001;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--port") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --port");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new Error(`Invalid --port value: ${value}`);
      }
      port = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return port;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const port = parsePort(argv);
  const server = await startApiServer({
    cwd: process.cwd(),
    port
  });

  console.log(`API server listening on ${server.url}`);
  return 0;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Server failed to start.");
    process.exit(1);
  });
}
