import { resolve } from "node:path";

type ProviderId = "gemini" | "openai" | "kimi";
type ProviderStatus = "passed" | "failed" | "skipped";

const PROVIDER_TESTS: Record<ProviderId, string> = {
  gemini: "tests/integration/provider-gemini-live.integration.test.ts",
  openai: "tests/integration/provider-openai-live.integration.test.ts",
  kimi: "tests/integration/provider-kimi-live.integration.test.ts"
};

function projectRoot(): string {
  return resolve(import.meta.dir, "..");
}

function normalizeRequestedProviders(argv: string[]): ProviderId[] {
  if (argv.length === 0) {
    return ["gemini", "openai", "kimi"];
  }

  const providers = argv.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const invalid = providers.filter((value) => !(value in PROVIDER_TESTS));

  if (invalid.length > 0) {
    throw new Error(
      `Unknown provider selection: ${invalid.join(", ")}. Expected one or more of gemini, openai, kimi.`
    );
  }

  return providers as ProviderId[];
}

function classifyProviderStatus(exitCode: number, combinedOutput: string): ProviderStatus {
  if (exitCode !== 0) {
    return "failed";
  }

  if (/\b\d+\s+skip\b/u.test(combinedOutput) && !/\b\d+\s+pass\b/u.test(combinedOutput)) {
    return "skipped";
  }

  return "passed";
}

async function main(): Promise<void> {
  if (process.env.RUN_LIVE_PROVIDER_TESTS !== "1") {
    throw new Error(
      "verify:live requires RUN_LIVE_PROVIDER_TESTS=1. Example: RUN_LIVE_PROVIDER_TESTS=1 bun run verify:live"
    );
  }

  const requestedProviders = normalizeRequestedProviders(process.argv.slice(2));
  const summary = new Map<ProviderId, ProviderStatus>();

  console.log("=== Live Provider Verification ===");
  console.log(`Project: ${projectRoot()}`);
  console.log(`Providers: ${requestedProviders.join(", ")}`);

  for (const providerId of requestedProviders) {
    const testPath = PROVIDER_TESTS[providerId];
    console.log("");
    console.log(`--- ${providerId} ---`);

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", testPath],
      cwd: projectRoot(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe"
    });

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const combinedOutput = `${stdout}\n${stderr}`;
    const status = classifyProviderStatus(result.exitCode, combinedOutput);

    if (stdout.trim().length > 0) {
      process.stdout.write(stdout);
      if (!stdout.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }

    if (stderr.trim().length > 0) {
      process.stderr.write(stderr);
      if (!stderr.endsWith("\n")) {
        process.stderr.write("\n");
      }
    }

    console.log(`Result: ${providerId} ${status}`);
    summary.set(providerId, status);
  }

  console.log("");
  console.log("=== Live Verification Summary ===");
  for (const providerId of requestedProviders) {
    console.log(`- ${providerId}: ${summary.get(providerId) ?? "skipped"}`);
  }

  const hasFailure = [...summary.values()].includes("failed");
  process.exit(hasFailure ? 1 : 0);
}

await main();
