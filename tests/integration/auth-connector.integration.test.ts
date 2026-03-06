import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function projectRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

function runCli(
  args: string[],
  input = "",
  envOverrides: Record<string, string | undefined> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const name of [
    "GEMINI_API_KEY",
    "KIMI_API_KEY",
    "KIMI_BASE_URL",
    "OPENAI_API_KEY",
    "MAF_STATE_DIR",
    "MAF_CREDENTIAL_STORE_BACKEND",
    "MAF_CREDENTIAL_STORE_FILE"
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

describe("integration/auth-connector", () => {
  test("auth login stores a connector, auth status reports it, connector list includes it, and auth logout removes it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-auth-state-"));
    const credentialFile = join(stateDir, "credentials.json");
    const env = {
      MAF_STATE_DIR: stateDir,
      MAF_CREDENTIAL_STORE_BACKEND: "file",
      MAF_CREDENTIAL_STORE_FILE: credentialFile
    };

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
          "--model",
          "gpt-4.1-mini",
          "--use",
          "--no-certify"
        ],
        "sk-test-openai\n",
        env
      );

      expect(loginResult.exitCode).toBe(0);
      expect(loginResult.stdout).toContain("openai-main");

      const catalogRaw = await readFile(join(stateDir, "connectors.json"), "utf8");
      const catalog = JSON.parse(catalogRaw) as {
        activeConnectorId?: string;
        connectors: Array<{ id: string; providerId: string; defaultModel: string; runtimeStatus: string }>;
      };

      expect(catalog.activeConnectorId).toBe("openai-main");
      expect(catalog.connectors).toContainEqual(
        expect.objectContaining({
          id: "openai-main",
          providerId: "openai",
          defaultModel: "gpt-4.1-mini",
          runtimeStatus: "ready"
        })
      );

      const statusResult = runCli(["auth", "status", "--connector", "openai-main"], "", env);
      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.stdout).toContain("openai-main");
      expect(statusResult.stdout).toContain("Credential available: yes");

      const listResult = runCli(["connector", "list"], "", env);
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain("openai-main");
      expect(listResult.stdout).toContain("active");

      const logoutResult = runCli(["auth", "logout", "--connector", "openai-main"], "", env);
      expect(logoutResult.exitCode).toBe(0);

      const reloadedCatalogRaw = await readFile(join(stateDir, "connectors.json"), "utf8");
      const reloadedCatalog = JSON.parse(reloadedCatalogRaw) as {
        activeConnectorId?: string;
        connectors: Array<{ id: string }>;
      };

      expect(reloadedCatalog.activeConnectorId).toBeUndefined();
      expect(reloadedCatalog.connectors).toHaveLength(0);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("connector use switches the active connector", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-connector-use-"));
    const credentialFile = join(stateDir, "credentials.json");
    const env = {
      MAF_STATE_DIR: stateDir,
      MAF_CREDENTIAL_STORE_BACKEND: "file",
      MAF_CREDENTIAL_STORE_FILE: credentialFile
    };

    try {
      runCli(
        [
          "auth",
          "login",
          "--provider",
          "openai",
          "--method",
          "api-key",
          "--connector-id",
          "openai-main",
          "--no-certify"
        ],
        "sk-test-openai\n",
        env
      );
      runCli(
        [
          "auth",
          "login",
          "--provider",
          "gemini",
          "--method",
          "api-key",
          "--connector-id",
          "gemini-main",
          "--no-certify"
        ],
        "sk-test-gemini\n",
        env
      );

      const useResult = runCli(["connector", "use", "--connector", "gemini-main"], "", env);

      expect(useResult.exitCode).toBe(0);
      expect(useResult.stdout).toContain("gemini-main");

      const catalogRaw = await readFile(join(stateDir, "connectors.json"), "utf8");
      const catalog = JSON.parse(catalogRaw) as {
        activeConnectorId?: string;
      };

      expect(catalog.activeConnectorId).toBe("gemini-main");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("auth certify writes an auth artifact and updates stored certification status", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-auth-certify-"));
    const credentialFile = join(stateDir, "credentials.json");
    const outputDir = join(stateDir, "auth-artifacts");
    const env = {
      MAF_STATE_DIR: stateDir,
      MAF_CREDENTIAL_STORE_BACKEND: "file",
      MAF_CREDENTIAL_STORE_FILE: credentialFile
    };

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
        "sk-test-openai\n",
        env
      );

      expect(loginResult.exitCode).toBe(0);

      const certifyResult = runCli(
        ["auth", "certify", "--connector", "openai-main", "--output-dir", outputDir],
        "",
        env
      );

      expect(certifyResult.exitCode).toBe(1);
      expect(certifyResult.stdout).toContain("Connector: openai-main");
      expect(certifyResult.stdout).toContain("Certification: failed");
      expect(certifyResult.stdout).toContain("Auth artifact:");

      const artifactNames = await readdir(outputDir);
      expect(artifactNames.some((name) => name.endsWith(".auth-cert.json"))).toBe(true);

      const catalogRaw = await readFile(join(stateDir, "connectors.json"), "utf8");
      const catalog = JSON.parse(catalogRaw) as {
        connectors: Array<{ id: string; lastCertificationStatus: string; lastCertifiedAt?: string }>;
      };

      expect(catalog.connectors).toContainEqual(
        expect.objectContaining({
          id: "openai-main",
          lastCertificationStatus: "failed"
        })
      );
      expect(
        catalog.connectors.find((connector) => connector.id === "openai-main")?.lastCertifiedAt
      ).toEqual(expect.any(String));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("openai chatgpt-oauth login writes a blocked connector placeholder with tracking", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "maf-auth-openai-oauth-"));
    const credentialFile = join(stateDir, "credentials.json");
    const env = {
      MAF_STATE_DIR: stateDir,
      MAF_CREDENTIAL_STORE_BACKEND: "file",
      MAF_CREDENTIAL_STORE_FILE: credentialFile
    };

    try {
      const loginResult = runCli(
        [
          "auth",
          "login",
          "--provider",
          "openai",
          "--method",
          "chatgpt-oauth",
          "--connector-id",
          "openai-oauth"
        ],
        "",
        env
      );

      expect(loginResult.exitCode).toBe(1);
      expect(loginResult.stdout).toContain("Stored blocked connector placeholder: openai-oauth");
      expect(loginResult.stdout).toContain("Runtime status: blocked (oauth_not_implemented)");
      expect(loginResult.stdout).toContain("https://github.com/slittycode/multi-agent-framework/issues/1");

      const catalogRaw = await readFile(join(stateDir, "connectors.json"), "utf8");
      const catalog = JSON.parse(catalogRaw) as {
        activeConnectorId?: string;
        connectors: Array<{
          id: string;
          authMethod: string;
          lastCertificationStatus: string;
          runtimeStatus: string;
          runtimeStatusReason?: string;
          trackedIssueUrl?: string;
        }>;
      };

      expect(catalog.activeConnectorId).toBeUndefined();
      expect(catalog.connectors).toContainEqual(
        expect.objectContaining({
          id: "openai-oauth",
          authMethod: "chatgpt-oauth",
          lastCertificationStatus: "blocked",
          runtimeStatus: "blocked",
          runtimeStatusReason: "oauth_not_implemented",
          trackedIssueUrl: "https://github.com/slittycode/multi-agent-framework/issues/1"
        })
      );

      const statusResult = runCli(["auth", "status", "--connector", "openai-oauth"], "", env);
      expect(statusResult.exitCode).toBe(1);
      expect(statusResult.stdout).toContain("Runtime status: blocked");
      expect(statusResult.stdout).toContain("Tracking: https://github.com/slittycode/multi-agent-framework/issues/1");

      const listResult = runCli(["connector", "list"], "", env);
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain("openai-oauth");
      expect(listResult.stdout).toContain("status=blocked(oauth_not_implemented)");

      const useResult = runCli(["connector", "use", "--connector", "openai-oauth"], "", env);
      expect(useResult.exitCode).toBe(1);
      expect(useResult.stderr).toContain("cannot be activated");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
