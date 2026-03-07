import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import generalDebate from "../../src/adapters/builtins/general-debate";
import { applyConnectorToAdapter } from "../../src/connectors/adapter-override";
import {
  loadConnectorCatalog,
  resolveConnectorCatalogPath,
  saveConnectorCatalog
} from "../../src/connectors/catalog";
import { MemoryCredentialStore } from "../../src/connectors/credential-store";
import { discoverEnvConnectors } from "../../src/connectors/env-connectors";
import { resolveExecutionContext } from "../../src/connectors/connector-resolution";

describe("connectors", () => {
  test("saves and loads connector catalog state in the repo-local state directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-catalog-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "openai-main",
          connectors: [
            {
              id: "openai-main",
              providerId: "openai",
              authMethod: "api-key",
              defaultModel: "gpt-4.1-mini",
              credentialSource: "keychain",
              credentialRef: "openai-main",
              lastCertificationStatus: "passed",
              runtimeStatus: "ready",
              lastCertifiedAt: "2026-03-06T00:00:00.000Z"
            }
          ]
        },
        { cwd }
      );

      const reloaded = await loadConnectorCatalog({ cwd });

      expect(resolveConnectorCatalogPath({ cwd })).toBe(join(cwd, ".multi-agent-framework", "connectors.json"));
      expect(reloaded.activeConnectorId).toBe("openai-main");
      expect(reloaded.connectors).toHaveLength(1);
      expect(reloaded.connectors[0]?.providerId).toBe("openai");
      expect(reloaded.connectors[0]?.runtimeStatus).toBe("ready");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("discovers ephemeral env connectors with provider defaults", () => {
    const connectors = discoverEnvConnectors({
      GEMINI_API_KEY: "gemini-key",
      OPENAI_API_KEY: "openai-key",
      KIMI_API_KEY: "moonshot-key"
    });

    expect(connectors.map((connector) => connector.id).sort()).toEqual([
      "gemini-env",
      "kimi-env",
      "openai-env"
    ]);
    expect(connectors.find((connector) => connector.id === "gemini-env")).toMatchObject({
      providerId: "gemini",
      credentialSource: "env",
      credentialRef: "GEMINI_API_KEY",
      defaultModel: "gemini-2.5-flash",
      runtimeStatus: "ready"
    });
    expect(connectors.find((connector) => connector.id === "kimi-env")).toMatchObject({
      providerId: "kimi",
      credentialSource: "env",
      credentialRef: "KIMI_API_KEY",
      defaultModel: "moonshot-v1-8k",
      runtimeStatus: "ready"
    });
    expect(connectors.find((connector) => connector.id === "kimi-env")?.providerNote).toContain(
      "platform.moonshot.cn"
    );
    expect(connectors.find((connector) => connector.id === "openai-env")).toMatchObject({
      providerId: "openai",
      credentialSource: "env",
      credentialRef: "OPENAI_API_KEY",
      defaultModel: "gpt-4.1-mini",
      runtimeStatus: "ready"
    });
  });

  test("loadConnectorCatalog backfills provider notes for kimi connectors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-kimi-note-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          connectors: [
            {
              id: "kimi-main",
              providerId: "kimi",
              authMethod: "api-key",
              defaultModel: "moonshot-v1-8k",
              credentialSource: "keychain",
              credentialRef: "kimi-main",
              lastCertificationStatus: "never",
              runtimeStatus: "ready"
            }
          ]
        },
        { cwd }
      );

      const reloaded = await loadConnectorCatalog({ cwd });

      expect(reloaded.connectors[0]?.providerNote).toContain("platform.moonshot.cn");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("auto execution falls back to mock when no live connector is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-auto-mock-"));

    try {
      const resolution = await resolveExecutionContext({
        cwd,
        executionMode: "auto",
        env: {},
        credentialStore: new MemoryCredentialStore()
      });

      expect(resolution.requestedExecutionMode).toBe("auto");
      expect(resolution.resolvedExecutionMode).toBe("mock");
      expect(resolution.connector).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("auto execution resolves the active stored connector and materializes credentials", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-auto-active-"));
    const credentialStore = new MemoryCredentialStore();
    credentialStore.set("openai-main", "stored-openai-key");

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "openai-main",
          connectors: [
            {
              id: "openai-main",
              providerId: "openai",
              authMethod: "api-key",
              defaultModel: "gpt-4.1-mini",
              credentialSource: "keychain",
              credentialRef: "openai-main",
              lastCertificationStatus: "never",
              runtimeStatus: "ready"
            }
          ]
        },
        { cwd }
      );

      const resolution = await resolveExecutionContext({
        cwd,
        executionMode: "auto",
        env: {},
        credentialStore
      });

      expect(resolution.resolvedExecutionMode).toBe("live");
      expect(resolution.connector).toMatchObject({
        id: "openai-main",
        providerId: "openai",
        credentialSource: "keychain",
        defaultModel: "gpt-4.1-mini"
      });
      expect(resolution.envOverlay).toMatchObject({
        OPENAI_API_KEY: "stored-openai-key"
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("auto execution fails when multiple env connectors are available without a selection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-auto-ambiguous-"));

    try {
      await expect(
        resolveExecutionContext({
          cwd,
          executionMode: "auto",
          env: {
            GEMINI_API_KEY: "gemini-key",
            OPENAI_API_KEY: "openai-key"
          },
          credentialStore: new MemoryCredentialStore()
        })
      ).rejects.toThrow("Multiple live connectors are available");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("auto execution fails when the active connector is stale", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-stale-active-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "openai-main",
          connectors: []
        },
        { cwd }
      );

      await expect(
        resolveExecutionContext({
          cwd,
          executionMode: "auto",
          env: {},
          credentialStore: new MemoryCredentialStore()
        })
      ).rejects.toThrow('Active connector "openai-main" is not available.');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("auto execution ignores stale env-backed active connector ids and falls back to mock", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-stale-env-auto-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "gemini-env",
          connectors: []
        },
        { cwd }
      );

      const resolution = await resolveExecutionContext({
        cwd,
        executionMode: "auto",
        env: {},
        credentialStore: new MemoryCredentialStore()
      });

      expect(resolution.resolvedExecutionMode).toBe("mock");
      expect(resolution.connector).toBeUndefined();
      expect(resolution.activeConnectorId).toBe("gemini-env");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("live execution rejects stale env-backed active connector ids with remediation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-stale-env-live-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "gemini-env",
          connectors: []
        },
        { cwd }
      );

      await expect(
        resolveExecutionContext({
          cwd,
          executionMode: "live",
          env: {},
          credentialStore: new MemoryCredentialStore()
        })
      ).rejects.toThrow("export GEMINI_API_KEY again");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("auto execution falls back from a stale env-backed active connector to the only stored ready connector", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-stale-env-stored-fallback-"));
    const credentialStore = new MemoryCredentialStore();
    await credentialStore.set("openai-main", "stored-openai-key");

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "gemini-env",
          connectors: [
            {
              id: "openai-main",
              providerId: "openai",
              authMethod: "api-key",
              defaultModel: "gpt-4.1-mini",
              credentialSource: "keychain",
              credentialRef: "openai-main",
              lastCertificationStatus: "never",
              runtimeStatus: "ready"
            }
          ]
        },
        { cwd }
      );

      const resolution = await resolveExecutionContext({
        cwd,
        executionMode: "auto",
        env: {},
        credentialStore
      });

      expect(resolution.resolvedExecutionMode).toBe("live");
      expect(resolution.connector).toMatchObject({
        id: "openai-main",
        providerId: "openai"
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("live execution fails when the stored connector credential is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-missing-credential-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "openai-main",
          connectors: [
            {
              id: "openai-main",
              providerId: "openai",
              authMethod: "api-key",
              defaultModel: "gpt-4.1-mini",
              credentialSource: "keychain",
              credentialRef: "openai-main",
              lastCertificationStatus: "never",
              runtimeStatus: "ready"
            }
          ]
        },
        { cwd }
      );

      await expect(
        resolveExecutionContext({
          cwd,
          executionMode: "live",
          env: {},
          credentialStore: new MemoryCredentialStore()
        })
      ).rejects.toThrow('Connector "openai-main" is configured but its stored credential is unavailable.');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("auto execution ignores a blocked active connector and falls back to mock", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-blocked-active-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
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
        { cwd }
      );

      const resolution = await resolveExecutionContext({
        cwd,
        executionMode: "auto",
        env: {},
        credentialStore: new MemoryCredentialStore()
      });

      expect(resolution.resolvedExecutionMode).toBe("mock");
      expect(resolution.connector).toBeUndefined();
      expect(resolution.activeConnectorId).toBe("openai-oauth");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("explicitly selecting a blocked connector fails with a tracking reference", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-connectors-blocked-explicit-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
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
        { cwd }
      );

      await expect(
        resolveExecutionContext({
          cwd,
          executionMode: "live",
          explicitConnectorId: "openai-oauth",
          env: {},
          credentialStore: new MemoryCredentialStore()
        })
      ).rejects.toThrow("oauth_not_implemented");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("applyConnectorToAdapter rewrites all llm providers and swaps the default model", () => {
    const overridden = applyConnectorToAdapter(generalDebate, {
      providerId: "openai",
      defaultModel: "gpt-4.1-mini",
    });

    expect(overridden.agents.every((agent) => agent.llm?.provider === "openai")).toBe(true);
    expect(overridden.agents.every((agent) => agent.llm?.model === "gpt-4.1-mini")).toBe(true);
    expect(overridden.prompts).toEqual(generalDebate.prompts);
  });
});
