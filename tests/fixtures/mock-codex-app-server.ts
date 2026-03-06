#!/usr/bin/env bun

import { createInterface } from "node:readline";

type Scenario =
  | "success"
  | "login-required"
  | "login-failure"
  | "account-missing"
  | "turn-timeout"
  | "turn-failure";

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

const DEFAULT_MODEL = "gpt-5.3-codex";
const scenario = (process.env.MOCK_CODEX_APP_SERVER_SCENARIO ?? "success") as Scenario;
let loggedIn = scenario !== "login-required" && scenario !== "account-missing";
let threadCounter = 0;
let turnCounter = 0;
let loginCounter = 0;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: number | string | undefined, result: unknown): void {
  if (id !== undefined) {
    send({ id, result });
  }
}

function sendError(id: number | string | undefined, message: string): void {
  if (id !== undefined) {
    send({ id, error: { message } });
  }
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  send({ method, params });
}

function getAccount(): Record<string, unknown> | null {
  if (!loggedIn) {
    return null;
  }

  return {
    type: "chatgpt",
    email: "codex-test@example.com",
    planType: "plus"
  };
}

function buildSynthesisResponse(): string {
  return JSON.stringify({
    summary:
      "The discussion surfaced the core trade-offs around the topic, narrowed the main risk, and converged on a practical operating path.",
    verdict: "Proceed with a limited rollout tied to an explicit verification checkpoint.",
    recommendations: [
      {
        text: "Implement a small pilot on the debated topic and measure one concrete outcome within seven days.",
        priority: "high"
      },
      {
        text: "Document the strongest risk raised in the discussion and assign a single owner to verify it before wider rollout.",
        priority: "high"
      },
      {
        text: "Review the pilot results with the team and update the working guidance for this topic based on what changed.",
        priority: "medium"
      }
    ]
  });
}

function buildTurnText(prompt: string): string {
  if (prompt.includes("Return output as strict JSON using this schema")) {
    return buildSynthesisResponse();
  }

  const promptWords = prompt
    .split(/\s+/u)
    .map((word) => word.replace(/[^a-z0-9-]/giu, "").toLowerCase())
    .filter((word) => word.length > 3)
    .slice(0, 6);
  const promptSignature = promptWords.join(" ") || "the current topic";

  return [
    `The strongest point in this turn is that ${promptSignature} benefits from a measured rollout rather than an all-at-once shift.`,
    `Recommendation: define one success metric for ${promptSignature} before changing the workflow.`,
    `Recommendation: test ${promptSignature} with a small group before broad adoption.`,
    `Recommendation: review ${promptSignature} after one short cycle and adjust based on evidence.`
  ].join("\n");
}

function extractPrompt(params: Record<string, unknown> | undefined): string {
  const input = params?.input;
  if (!Array.isArray(input)) {
    return "";
  }

  return input
    .filter((item) => typeof item === "object" && item !== null)
    .map((item) => {
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function handleTurnStart(message: JsonRpcMessage): void {
  if (!loggedIn) {
    sendError(message.id, "AUTH_REQUIRED");
    return;
  }

  const turnId = `turn-${++turnCounter}`;
  const threadId = typeof message.params?.threadId === "string" ? message.params.threadId : "thread-unknown";
  sendResult(message.id, {
    turn: {
      id: turnId,
      items: [],
      status: "in_progress",
      error: null
    }
  });

  if (scenario === "turn-timeout") {
    return;
  }

  if (scenario === "turn-failure") {
    queueMicrotask(() => {
      sendNotification("error", {
        threadId,
        turnId,
        error: {
          message: `The '${DEFAULT_MODEL}' model is temporarily unavailable.`,
          codexErrorInfo: "other",
          additionalDetails: null
        },
        willRetry: false
      });
      sendNotification("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          items: [],
          status: "failed",
          error: {
            message: `The '${DEFAULT_MODEL}' model is temporarily unavailable.`,
            codexErrorInfo: "other",
            additionalDetails: null
          }
        }
      });
    });
    return;
  }

  const text = buildTurnText(extractPrompt(message.params));
  queueMicrotask(() => {
    sendNotification("item/started", {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: `item-${turnId}`,
        text: "",
        phase: null
      }
    });
    sendNotification("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: `item-${turnId}`,
      delta: text
    });
    sendNotification("item/completed", {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: `item-${turnId}`,
        text,
        phase: null
      }
    });
    sendNotification("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        items: [],
        status: "completed",
        error: null
      }
    });
  });
}

function handleMessage(message: JsonRpcMessage): void {
  switch (message.method) {
    case "initialize":
      sendResult(message.id, { userAgent: "mock-codex-app-server" });
      return;
    case "initialized":
      return;
    case "account/read":
      sendResult(message.id, {
        account: getAccount(),
        requiresOpenaiAuth: !loggedIn
      });
      return;
    case "account/login/start": {
      const type = message.params?.type;
      if (type !== "chatgpt") {
        sendError(message.id, `Unsupported mock login type: ${String(type)}`);
        return;
      }

      const loginId = `login-${++loginCounter}`;
      sendResult(message.id, {
        type: "chatgpt",
        loginId,
        authUrl: `https://chatgpt.com/mock-login/${loginId}`
      });

      queueMicrotask(() => {
        if (scenario === "login-failure") {
          sendNotification("account/login/completed", {
            loginId,
            success: false,
            error: "Mock login failed"
          });
          return;
        }

        loggedIn = true;
        sendNotification("account/login/completed", {
          loginId,
          success: true,
          error: null
        });
        sendNotification("account/updated", {
          authMode: "chatgpt"
        });
      });
      return;
    }
    case "account/login/cancel":
      sendResult(message.id, {});
      sendNotification("account/login/completed", {
        loginId: message.params?.loginId ?? null,
        success: false,
        error: "cancelled"
      });
      return;
    case "account/logout":
      loggedIn = false;
      sendResult(message.id, {});
      sendNotification("account/updated", {
        authMode: null
      });
      return;
    case "account/rateLimits/read":
      sendResult(message.id, {
        rateLimits: {
          limit: 1000,
          remaining: loggedIn ? 999 : 0,
          resetAt: new Date(Date.now() + 60_000).toISOString()
        },
        rateLimitsByLimitId: {
          codex: {
            limit: 1000,
            remaining: loggedIn ? 999 : 0,
            resetAt: new Date(Date.now() + 60_000).toISOString()
          }
        }
      });
      return;
    case "model/list":
      sendResult(message.id, {
        data: [
          {
            id: DEFAULT_MODEL,
            model: DEFAULT_MODEL,
            displayName: DEFAULT_MODEL,
            hidden: false,
            isDefault: true
          }
        ],
        nextCursor: null
      });
      return;
    case "thread/start":
      if (!loggedIn) {
        sendError(message.id, "AUTH_REQUIRED");
        return;
      }
      sendResult(message.id, {
        thread: {
          id: `thread-${++threadCounter}`,
          turns: []
        },
        model: typeof message.params?.model === "string" ? message.params.model : DEFAULT_MODEL,
        modelProvider: "openai",
        cwd: typeof message.params?.cwd === "string" ? message.params.cwd : process.cwd(),
        approvalPolicy: "never",
        sandbox: { mode: "danger-full-access" },
        reasoningEffort: null
      });
      return;
    case "turn/start":
      handleTurnStart(message);
      return;
    default:
      sendResult(message.id, {});
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  handleMessage(JSON.parse(trimmed) as JsonRpcMessage);
});
