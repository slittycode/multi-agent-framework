import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function projectRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

function mockCodexAppServerEnv(scenario = "success"): Record<string, string | undefined> {
  return {
    MAF_CODEX_APP_SERVER_COMMAND: process.execPath,
    MAF_CODEX_APP_SERVER_ARGS: JSON.stringify([
      "run",
      join(projectRoot(), "tests", "fixtures", "mock-codex-app-server.ts")
    ]),
    MAF_DISABLE_BROWSER_OPEN: "1",
    MOCK_CODEX_APP_SERVER_SCENARIO: scenario
  };
}

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
  input = ""
): { exitCode: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const name of [
    "GEMINI_API_KEY",
    "KIMI_API_KEY",
    "KIMI_BASE_URL",
    "OPENAI_API_KEY",
    "MAF_STATE_DIR",
    "MAF_CREDENTIAL_STORE_BACKEND",
    "MAF_CREDENTIAL_STORE_FILE",
    "MAF_CODEX_APP_SERVER_COMMAND",
    "MAF_CODEX_APP_SERVER_ARGS",
    "MAF_DISABLE_BROWSER_OPEN",
    "MOCK_CODEX_APP_SERVER_SCENARIO"
  ]) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[name];
      continue;
    }
    env[name] = value;
  }

  const processResult = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli/main.ts", ...args],
    cwd: projectRoot(),
    env,
    stdin: input ? new Response(input) : "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: processResult.exitCode,
    stdout: processResult.stdout.toString(),
    stderr: processResult.stderr.toString()
  };
}

describe("integration/cli-run", () => {
  test("runs with --adapter-id and writes transcript", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "maf-step6-cli-id-"));

    try {
      const result = runCli([
        "run",
        "--adapter-id",
        "general-debate",
        "--topic",
        "CLI topic",
        "--run-id",
        "cli-run-1",
        "--output-dir",
        outputDir
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Execution Mode: auto");
      expect(result.stdout).toContain("Resolved Execution Mode: mock");
      expect(result.stdout).toContain("Evaluation Tier: baseline");
      expect(result.stdout).toContain("=== Synthesis ===");
      expect(result.stdout).toContain("Summary:");
      expect(result.stdout).toContain("Actionability Score:");
      expect(result.stdout).toContain("Run Summary");
      expect(result.stdout).toContain("cli-run-1.transcript.json");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("runs with --adapter-file", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "maf-step6-cli-file-"));
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/valid-adapter.ts");

    try {
      const result = runCli([
        "run",
        "--adapter-file",
        adapterFile,
        "--topic",
        "CLI topic",
        "--run-id",
        "cli-run-2",
        "--output-dir",
        outputDir,
        "--format",
        "jsonl"
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("=== Synthesis ===");
      expect(result.stdout).toContain("Summary:");
      expect(result.stdout).toContain("Run Summary");
      expect(result.stdout).toContain("cli-run-2.transcript.jsonl");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("applies --model override to generated transcript messages", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "maf-step-provider-model-override-"));

    try {
      const result = runCli([
        "run",
        "--adapter-id",
        "general-debate",
        "--topic",
        "CLI topic",
        "--run-id",
        "cli-run-model-override",
        "--output-dir",
        outputDir,
        "--model",
        "gemini-2.5-flash"
      ]);

      expect(result.exitCode).toBe(0);

      const transcriptPath = join(outputDir, "cli-run-model-override.transcript.json");
      const transcriptRaw = await readFile(transcriptPath, "utf8");
      const transcript = JSON.parse(transcriptRaw) as {
        messages: Array<{ model?: string; kind: string }>;
      };
      const nonErrorMessages = transcript.messages.filter((message) => message.kind !== "error");

      expect(nonErrorMessages.length).toBeGreaterThan(0);
      expect(nonErrorMessages.every((message) => message.model === "gemini-2.5-flash")).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("accepts v0.2 override flags and completes run", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "maf-step-v02-cli-overrides-"));
    try {
      const result = runCli([
        "run",
        "--adapter-id",
        "general-debate",
        "--topic",
        "CLI topic",
        "--run-id",
        "cli-run-v02-overrides",
        "--output-dir",
        outputDir,
        "--phase-judge",
        "off",
        "--quality-threshold",
        "70",
        "--citation-mode",
        "transcript",
        "--context-policy",
        "round-plus-recent",
        "--recent-context-count",
        "3"
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run Summary");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("fails when both adapter source flags are supplied", () => {
    const result = runCli([
      "run",
      "--adapter-id",
      "general-debate",
      "--adapter-file",
      "tests/fixtures/adapters/valid-adapter.ts",
      "--topic",
      "CLI topic"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Exactly one of --adapter-id or --adapter-file must be provided.");
  });

  test("fails when adapter source flags are missing", () => {
    const result = runCli(["run", "--topic", "CLI topic"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Exactly one of --adapter-id or --adapter-file must be provided.");
  });

  test("fails when --topic is missing", () => {
    const result = runCli(["run", "--adapter-id", "general-debate"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--topic is required and must be non-empty.");
  });

  test("fails when --topic is blank", () => {
    const result = runCli(["run", "--adapter-id", "general-debate", "--topic", "   "]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--topic is required and must be non-empty.");
  });

  test("fails when --provider-mode has an invalid value", () => {
    const result = runCli([
      "run",
      "--adapter-id",
      "general-debate",
      "--topic",
      "CLI topic",
      "--provider-mode",
      "invalid"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --provider-mode value: invalid. Expected mock|live|auto.");
  });

  test("fails when --phase-judge has an invalid value", () => {
    const result = runCli([
      "run",
      "--adapter-id",
      "general-debate",
      "--topic",
      "CLI topic",
      "--phase-judge",
      "maybe"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --phase-judge value");
  });

  test("fails when --citation-mode has an invalid value", () => {
    const result = runCli([
      "run",
      "--adapter-id",
      "general-debate",
      "--topic",
      "CLI topic",
      "--citation-mode",
      "web-only"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --citation-mode value");
  });

  test("fails when --context-policy has an invalid value", () => {
    const result = runCli([
      "run",
      "--adapter-id",
      "general-debate",
      "--topic",
      "CLI topic",
      "--context-policy",
      "recent"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --context-policy value");
  });

  test("fails when --quality-threshold is out of range", () => {
    const result = runCli([
      "run",
      "--adapter-id",
      "general-debate",
      "--topic",
      "CLI topic",
      "--quality-threshold",
      "120"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --quality-threshold value");
  });

  test("fails in live mode when no live connector is configured", () => {
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/live-gemini-adapter.ts");
    const result = runCli(
      [
        "run",
        "--adapter-file",
        adapterFile,
        "--topic",
        "CLI topic",
        "--provider-mode",
        "live"
      ],
      { GEMINI_API_KEY: undefined }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No live connector is configured");
  });

  test("fails in live mode when connector credentials are rejected by the provider", () => {
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/live-openai-adapter.ts");
    const result = runCli(
      [
        "run",
        "--adapter-file",
        adapterFile,
        "--topic",
        "CLI topic",
        "--provider-mode",
        "live"
      ],
      { OPENAI_API_KEY: "test-key" }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Provider Support:");
    expect(result.stdout).toContain("openai");
    expect(result.stderr).toContain("PROVIDER_AUTH_FAILED");
  });

  test("falls back to mock in auto mode when no live connector is configured", () => {
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/live-gemini-adapter.ts");
    const result = runCli(
      [
        "run",
        "--adapter-file",
        adapterFile,
        "--topic",
        "CLI topic",
        "--provider-mode",
        "auto"
      ],
      { GEMINI_API_KEY: undefined }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Resolved Execution Mode: mock");
    expect(result.stdout).toContain("Evaluation Tier: baseline");
  });

  test("uses the env connector in auto mode and surfaces auth failure when credentials are rejected", () => {
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/live-openai-adapter.ts");
    const result = runCli(
      [
        "run",
        "--adapter-file",
        adapterFile,
        "--topic",
        "CLI topic",
        "--provider-mode",
        "auto"
      ],
      { OPENAI_API_KEY: "test-key" }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Resolved Execution Mode: live");
    expect(result.stderr).toContain("PROVIDER_AUTH_FAILED");
  });

  test("uses the active stored connector in auto mode until changed", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-cli-active-connector-"));
    const credentialFile = join(stateDir, "credentials.json");
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/live-openai-adapter.ts");

    try {
      const loginResult = runCli(
        [
          "auth",
          "login",
          "--provider",
          "openai",
          "--method",
          "api-key",
          "--connector-id",
          "openai-main",
          "--use",
          "--no-certify"
        ],
        {
          MAF_STATE_DIR: stateDir,
          MAF_CREDENTIAL_STORE_BACKEND: "file",
          MAF_CREDENTIAL_STORE_FILE: credentialFile
        },
        "sk-test-openai\n"
      );

      expect(loginResult.exitCode).toBe(0);

      const result = runCli(
        ["run", "--adapter-file", adapterFile, "--topic", "CLI topic"],
        {
          MAF_STATE_DIR: stateDir,
          MAF_CREDENTIAL_STORE_BACKEND: "file",
          MAF_CREDENTIAL_STORE_FILE: credentialFile
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Execution Mode: auto");
      expect(result.stdout).toContain("Resolved Execution Mode: live");
      expect(result.stdout).toContain("Selected Connector: openai-main (openai/keychain)");
      expect(result.stdout).toContain("Active Connector: openai-main");
      expect(result.stderr).toContain("PROVIDER_AUTH_FAILED");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("ignores a blocked active connector in auto mode and falls back to mock", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-cli-blocked-active-"));
    const outputDir = await mkdtemp(join(tmpdir(), "maf-cli-blocked-active-output-"));

    try {
      await Bun.write(
        join(stateDir, "connectors.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            activeConnectorId: "openai-oauth",
            connectors: [
              {
                id: "openai-oauth",
                providerId: "openai",
                authMethod: "chatgpt-oauth",
                defaultModel: "gpt-4.1-mini",
                credentialSource: "keychain",
                credentialRef: "openai-oauth",
                lastCertificationStatus: "blocked",
                runtimeStatus: "blocked",
                runtimeStatusReason: "oauth_not_implemented",
                trackedIssueUrl: "https://github.com/slittycode/multi-agent-framework/issues/1"
              }
            ]
          },
          null,
          2
        )}\n`
      );

      const result = runCli(
        [
          "run",
          "--adapter-id",
          "general-debate",
          "--topic",
          "CLI topic",
          "--output-dir",
          outputDir
        ],
        {
          MAF_STATE_DIR: stateDir
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Execution Mode: auto");
      expect(result.stdout).toContain("Resolved Execution Mode: mock");
      expect(result.stdout).toContain("Active Connector: openai-oauth");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("fails when a blocked connector is selected explicitly", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-cli-blocked-explicit-"));
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/live-openai-adapter.ts");

    try {
      await Bun.write(
        join(stateDir, "connectors.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            connectors: [
              {
                id: "openai-oauth",
                providerId: "openai",
                authMethod: "chatgpt-oauth",
                defaultModel: "gpt-4.1-mini",
                credentialSource: "keychain",
                credentialRef: "openai-oauth",
                lastCertificationStatus: "blocked",
                runtimeStatus: "blocked",
                runtimeStatusReason: "oauth_not_implemented",
                trackedIssueUrl: "https://github.com/slittycode/multi-agent-framework/issues/1"
              }
            ]
          },
          null,
          2
        )}\n`
      );

      const result = runCli(
        [
          "run",
          "--adapter-file",
          adapterFile,
          "--topic",
          "CLI topic",
          "--execution-mode",
          "live",
          "--connector",
          "openai-oauth"
        ],
        {
          MAF_STATE_DIR: stateDir
        }
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("oauth_not_implemented");
      expect(result.stderr).toContain("issues/1");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("prints synthesis unavailable notice on graceful synthesis fallback", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "maf-step7-cli-synth-fallback-"));
    const adapterFile = resolve(projectRoot(), "tests/fixtures/adapters/synthesis-failure-adapter.ts");

    try {
      const result = runCli([
        "run",
        "--adapter-file",
        adapterFile,
        "--topic",
        "CLI synthesis fallback topic",
        "--run-id",
        "cli-run-synth-fallback",
        "--output-dir",
        outputDir
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("=== Synthesis ===");
      expect(result.stdout).toContain("Synthesis unavailable for this run.");
      expect(result.stdout).toContain("Run Summary");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("benchmark command writes report, prints table, and exits non-zero when quality threshold fails", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "maf-benchmark-cli-"));

    try {
      const result = runCli(["benchmark", "--output-dir", outputDir]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Benchmark Summary");
      expect(result.stdout).toContain("Evaluation Tier: baseline");
      expect(result.stdout).toContain("adapter");
      expect(result.stdout).toContain("topic");
      expect(result.stdout).toContain("actionability");
      expect(result.stdout).toContain("general-debate");

      const files = await readdir(outputDir);
      const reportName = files.find((name) => /^v02-benchmark-\d+\.json$/.test(name));
      expect(reportName).toBeDefined();

      const reportPath = join(outputDir, reportName as string);
      const reportRaw = await readFile(reportPath, "utf8");
      const report = JSON.parse(reportRaw) as {
        evaluationTier: string;
        providerMode: string;
        executionMode: string;
        resolvedExecutionMode: string;
        certificationScope: string;
        activeConnectorId?: string;
        providerIds: string[];
        rubricVersion: string;
        entries: Array<{
          adapterId: string;
          topic: string;
          connectorId?: string;
          debugArtifactPath?: string;
          actionability: {
            score: number;
            passed: boolean;
            subscores: Record<string, number>;
          };
          failureReasons: string[];
          transcriptPath?: string;
        }>;
      };

      expect(report.evaluationTier).toBe("baseline");
      expect(report.providerMode).toBe("auto");
      expect(report.executionMode).toBe("auto");
      expect(report.resolvedExecutionMode).toBe("mock");
      expect(report.certificationScope).toBe("baseline");
      expect(report.activeConnectorId).toBeUndefined();
      expect(report.providerIds).toContain("gemini");
      expect(report.rubricVersion).toEqual(expect.any(String));
      expect(report.entries).toHaveLength(9);
      expect(report.entries.every((entry) => entry.transcriptPath)).toBe(true);
      expect(report.entries.every((entry) => entry.connectorId === undefined)).toBe(true);
      expect(report.entries.some((entry) => entry.debugArtifactPath)).toBe(true);
      expect(report.entries.some((entry) => entry.actionability.passed === false)).toBe(true);
      expect(report.entries.some((entry) => entry.failureReasons.length > 0)).toBe(true);

      const debugEntries = await readdir(join(outputDir, "debug"));
      expect(debugEntries.length).toBeGreaterThan(0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("benchmark command validates provider mode values", () => {
    const result = runCli(["benchmark", "--provider-mode", "invalid"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid --provider-mode value: invalid. Expected mock|live|auto.");
  });

  test("benchmark command accepts --all-connectors with subsequent flags", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "maf-benchmark-all-connectors-"));

    try {
      const result = runCli([
        "benchmark",
        "--execution-mode",
        "mock",
        "--all-connectors",
        "--output-dir",
        outputDir
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Benchmark Summary");

      const files = await readdir(outputDir);
      expect(files.some((name) => /^v02-benchmark-\d+\.json$/.test(name))).toBe(true);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("benchmark ignores a blocked active connector in auto mode and stays baseline", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-benchmark-blocked-active-"));
    const outputDir = await mkdtemp(join(tmpdir(), "maf-benchmark-blocked-active-output-"));

    try {
      await Bun.write(
        join(stateDir, "connectors.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            activeConnectorId: "openai-oauth",
            connectors: [
              {
                id: "openai-oauth",
                providerId: "openai",
                authMethod: "chatgpt-oauth",
                defaultModel: "gpt-4.1-mini",
                credentialSource: "keychain",
                credentialRef: "openai-oauth",
                lastCertificationStatus: "blocked",
                runtimeStatus: "blocked",
                runtimeStatusReason: "oauth_not_implemented",
                trackedIssueUrl: "https://github.com/slittycode/multi-agent-framework/issues/1"
              }
            ]
          },
          null,
          2
        )}\n`
      );

      const result = runCli(["benchmark", "--output-dir", outputDir], {
        MAF_STATE_DIR: stateDir
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Evaluation Tier: baseline");

      const files = await readdir(outputDir);
      const reportName = files.find((name) => /^v02-benchmark-\d+\.json$/.test(name));
      expect(reportName).toBeDefined();

      const reportRaw = await readFile(join(outputDir, reportName as string), "utf8");
      const report = JSON.parse(reportRaw) as {
        resolvedExecutionMode: string;
        certificationScope: string;
        activeConnectorId?: string;
      };

      expect(report.resolvedExecutionMode).toBe("mock");
      expect(report.certificationScope).toBe("baseline");
      expect(report.activeConnectorId).toBe("openai-oauth");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("benchmark --all-connectors skips blocked connectors and records skip metadata", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-benchmark-all-connectors-live-state-"));
    const outputDir = await mkdtemp(join(tmpdir(), "maf-benchmark-all-connectors-live-output-"));

    try {
      await Bun.write(
        join(stateDir, "connectors.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            activeConnectorId: "openai-oauth",
            connectors: [
              {
                id: "openai-blocked",
                providerId: "openai",
                authMethod: "chatgpt-oauth",
                defaultModel: "gpt-4.1-mini",
                credentialSource: "codex-app-server",
                credentialRef: "openai-chatgpt",
                lastCertificationStatus: "failed",
                runtimeStatus: "blocked",
                runtimeStatusReason: "auth_method_not_supported"
              },
              {
                id: "openai-oauth",
                providerId: "openai",
                authMethod: "chatgpt-oauth",
                defaultModel: "gpt-4.1-mini",
                credentialSource: "codex-app-server",
                credentialRef: "openai-chatgpt",
                lastCertificationStatus: "never",
                runtimeStatus: "ready"
              }
            ]
          },
          null,
          2
        )}\n`
      );

      const result = runCli(
        [
          "benchmark",
          "--execution-mode",
          "live",
          "--all-connectors",
          "--output-dir",
          outputDir
        ],
        {
          MAF_STATE_DIR: stateDir,
          ...mockCodexAppServerEnv()
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Evaluation Tier: live_certification");

      const files = await readdir(outputDir);
      const reportName = files.find((name) => /^v02-benchmark-\d+\.json$/.test(name));
      expect(reportName).toBeDefined();

      const reportRaw = await readFile(join(outputDir, reportName as string), "utf8");
      const report = JSON.parse(reportRaw) as {
        resolvedExecutionMode: string;
        certificationScope: string;
        providerIds: string[];
        skippedConnectorIds?: string[];
        skippedConnectorReasons?: Record<string, string>;
      };

      expect(report.resolvedExecutionMode).toBe("live");
      expect(report.certificationScope).toBe("all_connectors");
      expect(report.providerIds).toEqual(["openai"]);
      expect(report.skippedConnectorIds).toContain("openai-blocked");
      expect(report.skippedConnectorReasons?.["openai-blocked"]).toContain("auth_method_not_supported");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
