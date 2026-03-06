import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function projectRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const env = { ...process.env };
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
      expect(result.stdout).toContain("Provider Mode: mock");
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

  test("fails in live mode when credentials are missing for a known provider", () => {
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
    expect(result.stderr).toContain("PROVIDER_CREDENTIALS_MISSING");
    expect(result.stderr).toContain("GEMINI_API_KEY");
  });

  test("fails in live mode when provider is not implemented after credentials are supplied", () => {
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
    expect(result.stderr).toContain("PROVIDER_NOT_IMPLEMENTED");
  });

  test("fails in auto mode with missing credentials for known provider", () => {
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

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PROVIDER_CREDENTIALS_MISSING");
  });

  test("fails in auto mode when provider is not implemented after credentials are supplied", () => {
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
    expect(result.stderr).toContain("PROVIDER_NOT_IMPLEMENTED");
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
        providerIds: string[];
        rubricVersion: string;
        entries: Array<{
          adapterId: string;
          topic: string;
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
      expect(report.providerMode).toBe("mock");
      expect(report.providerIds).toContain("gemini");
      expect(report.rubricVersion).toEqual(expect.any(String));
      expect(report.entries).toHaveLength(9);
      expect(report.entries.every((entry) => entry.transcriptPath)).toBe(true);
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
});
