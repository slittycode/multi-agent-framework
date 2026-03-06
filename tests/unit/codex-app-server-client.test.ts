import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { CodexAppServerClient } from "../../src/providers/clients/codex-app-server";

const activeClients = new Set<CodexAppServerClient>();

function createClient(scenario = "success"): CodexAppServerClient {
  const client = new CodexAppServerClient({
    command: process.execPath,
    args: ["run", resolve(import.meta.dir, "..", "fixtures", "mock-codex-app-server.ts")],
    env: {
      ...process.env,
      MOCK_CODEX_APP_SERVER_SCENARIO: scenario,
      MAF_DISABLE_BROWSER_OPEN: "1"
    }
  });

  activeClients.add(client);
  return client;
}

afterEach(async () => {
  await Promise.all(
    [...activeClients].map(async (client) => {
      await client.disconnect();
      activeClients.delete(client);
    })
  );
});

describe("CodexAppServerClient", () => {
  test("reads the current account and ChatGPT rate limits", async () => {
    const client = createClient();

    const account = await client.getAccount();
    const rateLimits = await client.getRateLimits();
    const models = await client.listModels();
    const defaultModel = await client.getDefaultModel();

    expect(account.account).toMatchObject({
      type: "chatgpt",
      email: "codex-test@example.com"
    });
    expect(rateLimits.rateLimits).toMatchObject({
      limit: 1000
    });
    expect(models).toContainEqual(
      expect.objectContaining({
        id: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        isDefault: true
      })
    );
    expect(defaultModel.model).toBe("gpt-5.3-codex");
  });

  test("completes the ChatGPT browser login flow", async () => {
    const client = createClient("login-required");

    const login = await client.loginWithChatGpt();
    const account = await client.getAccount();

    expect(login.authUrl).toContain("chatgpt.com/mock-login");
    expect(login.loginId).toContain("login-");
    expect(account.account).toMatchObject({
      type: "chatgpt"
    });
  });

  test("surfaces failed ChatGPT login attempts", async () => {
    const client = createClient("login-failure");

    await expect(client.loginWithChatGpt()).rejects.toThrow("Mock login failed");
  });

  test("runs a one-shot text turn and returns the completed agent message", async () => {
    const client = createClient();

    const response = await client.runTextTurn({
      model: "gpt-5.3-codex",
      prompt: "Reply in one short sentence about debate quality.",
      developerInstructions: "Be concise and factual."
    });

    expect(response.content).toContain("Recommendation:");
    expect(response.threadId).toContain("thread-");
    expect(response.turnId).toContain("turn-");
  });

  test("surfaces failed turns instead of hanging until timeout", async () => {
    const client = createClient("turn-failure");

    await expect(
      client.runTextTurn({
        model: "gpt-5.3-codex",
        prompt: "Reply in one short sentence about debate quality.",
        developerInstructions: "Be concise and factual."
      })
    ).rejects.toThrow("temporarily unavailable");
  });
});
