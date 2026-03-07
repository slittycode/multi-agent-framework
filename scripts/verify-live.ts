import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type ProviderId = "gemini" | "openai" | "kimi";
type ProviderStatus = "passed" | "failed" | "skipped" | "stale";
type CertificationProfile = "smoke" | "full";

interface VerifyLiveOptions {
  outputDir: string;
  profile: CertificationProfile;
  providers: ProviderId[];
}

interface VerificationSummaryEntry {
  providerId: ProviderId;
  status: ProviderStatus;
  manifestPath?: string;
  reason?: string;
}

function projectRoot(): string {
  return resolve(import.meta.dir, "..");
}

function parseArgs(argv: string[]): VerifyLiveOptions {
  const options: VerifyLiveOptions = {
    outputDir: resolve(projectRoot(), "runs", "verify-live"),
    profile: "full",
    providers: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case "--profile": {
        const value = argv[index + 1];
        if (value !== "smoke" && value !== "full") {
          throw new Error(`Invalid --profile value: ${value}. Expected smoke|full.`);
        }
        options.profile = value;
        index += 1;
        break;
      }
      case "--output-dir": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --output-dir.");
        }
        options.outputDir = resolve(projectRoot(), value);
        index += 1;
        break;
      }
      default: {
        const normalized = (token ?? "").trim().toLowerCase();
        if (normalized !== "gemini" && normalized !== "openai" && normalized !== "kimi") {
          throw new Error(
            `Unknown provider selection: ${token}. Expected one or more of gemini, openai, kimi.`
          );
        }
        options.providers.push(normalized);
      }
    }
  }

  if (options.providers.length === 0) {
    options.providers = ["gemini", "openai", "kimi"];
  }

  return options;
}

function providerConnectorId(providerId: ProviderId): string {
  return providerId === "openai" ? "openai-oauth" : `${providerId}-main`;
}

function providerLoginArgs(providerId: ProviderId): string[] {
  switch (providerId) {
    case "gemini":
      return ["auth", "login", "--provider", "gemini", "--method", "api-key", "--connector-id", "gemini-main", "--use", "--no-certify"];
    case "kimi":
      return ["auth", "login", "--provider", "kimi", "--method", "api-key", "--connector-id", "kimi-main", "--use", "--no-certify"];
    case "openai":
      return ["auth", "login", "--provider", "openai", "--method", "chatgpt-oauth", "--connector-id", "openai-oauth", "--use", "--no-certify"];
  }
}

function providerInput(providerId: ProviderId, env: Record<string, string | undefined>): string | undefined {
  switch (providerId) {
    case "gemini":
      return env.GEMINI_API_KEY ? `${env.GEMINI_API_KEY}\n` : undefined;
    case "kimi":
      return env.KIMI_API_KEY ? `${env.KIMI_API_KEY}\n` : undefined;
    case "openai":
      return undefined;
  }
}

function providerPrereq(providerId: ProviderId, env: Record<string, string | undefined>): string | undefined {
  switch (providerId) {
    case "gemini":
      return env.GEMINI_API_KEY?.trim() ? undefined : "GEMINI_API_KEY is not configured.";
    case "kimi":
      return env.KIMI_API_KEY?.trim()
        ? undefined
        : "KIMI_API_KEY is not configured. Use a Moonshot platform key from platform.moonshot.cn.";
    case "openai":
      return undefined;
  }
}

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  input?: string
): { exitCode: number; stdout: string; stderr: string } {
  const spawnEnv = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete spawnEnv[name];
      continue;
    }
    spawnEnv[name] = value;
  }

  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli/main.ts", ...args],
    cwd: projectRoot(),
    env: spawnEnv,
    stdin: input ? new Response(input) : "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  };
}

async function readLatestManifest(outputDir: string): Promise<{
  path: string;
  overallStatus: string;
} | null> {
  const names = await readdir(outputDir);
  const manifestNames = names
    .filter((name) => name.endsWith(".certification-manifest.json"))
    .sort((left, right) => left.localeCompare(right));
  const latest = manifestNames.at(-1);
  if (!latest) {
    return null;
  }

  const path = join(outputDir, latest);
  const manifestRaw = await readFile(path, "utf8");
  const manifest = JSON.parse(manifestRaw) as { overallStatus?: string };
  return {
    path,
    overallStatus: manifest.overallStatus ?? "failed"
  };
}

function classifyManifestStatus(overallStatus: string, certifyExitCode: number): ProviderStatus {
  if (certifyExitCode !== 0) {
    return "failed";
  }

  if (overallStatus === "passed") {
    return "passed";
  }

  if (overallStatus === "never" || overallStatus === "stale") {
    return "stale";
  }

  return "failed";
}

async function verifyProvider(
  providerId: ProviderId,
  options: VerifyLiveOptions,
  parentEnv: Record<string, string | undefined>
): Promise<VerificationSummaryEntry> {
  const prereq = providerPrereq(providerId, parentEnv);
  if (prereq) {
    return {
      providerId,
      status: "skipped",
      reason: prereq
    };
  }

  const providerOutputDir = join(options.outputDir, providerId);
  const providerStateDir = join(options.outputDir, `${providerId}-state`);
  await mkdir(providerOutputDir, { recursive: true });
  await mkdir(providerStateDir, { recursive: true });

  const env: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
    ...parentEnv,
    MAF_STATE_DIR: providerStateDir,
    MAF_CREDENTIAL_STORE_BACKEND: "file",
    MAF_CREDENTIAL_STORE_FILE: join(providerStateDir, "credentials.json")
  };

  console.log("");
  console.log(`--- ${providerId} (${options.profile}) ---`);

  const login = runCli(providerLoginArgs(providerId), env, providerInput(providerId, env));
  if (login.stdout.trim()) {
    process.stdout.write(login.stdout.endsWith("\n") ? login.stdout : `${login.stdout}\n`);
  }
  if (login.stderr.trim()) {
    process.stderr.write(login.stderr.endsWith("\n") ? login.stderr : `${login.stderr}\n`);
  }
  if (login.exitCode !== 0) {
    return {
      providerId,
      status: "failed",
      reason: "auth login failed."
    };
  }

  const certify = runCli(
    [
      "auth",
      "certify",
      "--connector",
      providerConnectorId(providerId),
      "--profile",
      options.profile,
      "--output-dir",
      providerOutputDir
    ],
    env
  );
  if (certify.stdout.trim()) {
    process.stdout.write(certify.stdout.endsWith("\n") ? certify.stdout : `${certify.stdout}\n`);
  }
  if (certify.stderr.trim()) {
    process.stderr.write(certify.stderr.endsWith("\n") ? certify.stderr : `${certify.stderr}\n`);
  }

  const manifest = await readLatestManifest(providerOutputDir);
  if (!manifest) {
    return {
      providerId,
      status: "failed",
      reason: "No certification manifest was produced."
    };
  }

  return {
    providerId,
    status: classifyManifestStatus(manifest.overallStatus, certify.exitCode),
    manifestPath: manifest.path
  };
}

async function main(): Promise<void> {
  if (process.env.RUN_LIVE_PROVIDER_TESTS !== "1") {
    throw new Error(
      "verify:live requires RUN_LIVE_PROVIDER_TESTS=1. Example: RUN_LIVE_PROVIDER_TESTS=1 bun run verify:live -- --profile smoke gemini"
    );
  }

  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outputDir, { recursive: true });
  const env = process.env as Record<string, string | undefined>;
  const summary: VerificationSummaryEntry[] = [];

  console.log("=== Live Certification Verification ===");
  console.log(`Project: ${projectRoot()}`);
  console.log(`Profile: ${options.profile}`);
  console.log(`Providers: ${options.providers.join(", ")}`);
  console.log(`Output: ${options.outputDir}`);

  for (const providerId of options.providers) {
    summary.push(await verifyProvider(providerId, options, env));
  }

  console.log("");
  console.log("=== Live Certification Summary ===");
  for (const entry of summary) {
    console.log(
      `- ${entry.providerId}: ${entry.status}${
        entry.manifestPath ? ` (${entry.manifestPath})` : entry.reason ? ` (${entry.reason})` : ""
      }`
    );
  }

  const hasFailure = summary.some((entry) => entry.status === "failed");
  process.exit(hasFailure ? 1 : 0);
}

await main();
