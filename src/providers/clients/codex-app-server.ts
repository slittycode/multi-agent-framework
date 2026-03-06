import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

interface JsonRpcRequestMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface NotificationWaiter {
  method: string;
  predicate: (params: Record<string, unknown>) => boolean;
  resolve: (params: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface NotificationRecord {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  requestTimeoutMs?: number;
}

export interface CodexAccount {
  type: "apiKey" | "chatgpt";
  email?: string;
  planType?: string;
}

export interface GetAccountResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface GetAccountRateLimitsResponse {
  rateLimits: Record<string, unknown>;
  rateLimitsByLimitId?: Record<string, Record<string, unknown>> | null;
}

export interface CodexAppServerModel {
  id: string;
  model: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
}

export interface ChatGptLoginResult {
  loginId: string;
  authUrl: string;
}

export interface RunTextTurnInput {
  model: string;
  prompt: string;
  developerInstructions?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunTextTurnResult {
  content: string;
  threadId: string;
  turnId: string;
  itemId?: string;
  model: string;
  raw: {
    threadStart: unknown;
    turnStart: unknown;
    turnCompleted: Record<string, unknown>;
    itemCompleted: Record<string, unknown>;
  };
}

export class CodexAppServerTurnError extends Error {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly codexErrorInfo?: string;
  readonly additionalDetails?: unknown;

  constructor(input: {
    message: string;
    threadId?: string;
    turnId?: string;
    codexErrorInfo?: string;
    additionalDetails?: unknown;
  }) {
    super(input.message);
    this.name = "CodexAppServerTurnError";
    this.threadId = input.threadId;
    this.turnId = input.turnId;
    this.codexErrorInfo = input.codexErrorInfo;
    this.additionalDetails = input.additionalDetails;
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown, key: string): string | undefined {
  if (!isObjectLike(value) || typeof value[key] !== "string") {
    return undefined;
  }

  const candidate = (value[key] as string).trim();
  return candidate ? candidate : undefined;
}

function getObject(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isObjectLike(value) || !isObjectLike(value[key])) {
    return undefined;
  }

  return value[key] as Record<string, unknown>;
}

function getBoolean(value: unknown, key: string): boolean | undefined {
  if (!isObjectLike(value) || typeof value[key] !== "boolean") {
    return undefined;
  }

  return value[key] as boolean;
}

function buildTurnError(input: {
  threadId?: string;
  turnId?: string;
  payload?: unknown;
  fallbackMessage: string;
}): CodexAppServerTurnError {
  const payload = isObjectLike(input.payload) ? input.payload : undefined;
  return new CodexAppServerTurnError({
    message: getString(payload, "message") ?? input.fallbackMessage,
    threadId: input.threadId,
    turnId: input.turnId,
    codexErrorInfo: getString(payload, "codexErrorInfo"),
    additionalDetails: payload?.additionalDetails
  });
}

function normalizeCommandEnv(
  env: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined)
  ) as NodeJS.ProcessEnv;
}

function parseConfiguredArgs(env: Record<string, string | undefined>): string[] | undefined {
  const raw = env.MAF_CODEX_APP_SERVER_ARGS?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("MAF_CODEX_APP_SERVER_ARGS must be a JSON array of strings.");
  }

  return [...parsed];
}

function maybeOpenBrowser(
  url: string,
  env: Record<string, string | undefined>
): boolean {
  if (!url || env.MAF_DISABLE_BROWSER_OPEN === "1") {
    return false;
  }

  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      return true;
    }

    if (process.platform === "linux") {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
      return true;
    }

    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export class CodexAppServerClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;

  private process?: ChildProcessWithoutNullStreams;
  private stdout?: Interface;
  private connectPromise?: Promise<void>;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationWaiters = new Set<NotificationWaiter>();
  private notificationHistory: NotificationRecord[] = [];
  private stderrTail: string[] = [];
  private nextRequestId = 1;
  private closed = false;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.env = options.env ?? (process.env as Record<string, string | undefined>);
    this.command = options.command ?? this.env.MAF_CODEX_APP_SERVER_COMMAND?.trim() ?? "codex";
    this.args = options.args ?? parseConfiguredArgs(this.env) ?? ["app-server"];
    this.cwd = options.cwd;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.start();
    try {
      await this.connectPromise;
    } catch (error) {
      this.connectPromise = undefined;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server client disconnected."));
    }
    this.pendingRequests.clear();

    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Codex app-server client disconnected."));
    }
    this.notificationWaiters.clear();

    this.stdout?.close();
    this.stdout = undefined;

    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    this.process = undefined;
    this.connectPromise = undefined;
  }

  async getAccount(input: { refresh?: boolean } = {}): Promise<GetAccountResponse> {
    const result = await this.request("account/read", {
      refresh: input.refresh ?? false
    });

    return result as GetAccountResponse;
  }

  async getRateLimits(): Promise<GetAccountRateLimitsResponse> {
    const result = await this.request("account/rateLimits/read");
    return result as GetAccountRateLimitsResponse;
  }

  async listModels(input: { limit?: number; includeHidden?: boolean } = {}): Promise<CodexAppServerModel[]> {
    const result = await this.request("model/list", {
      limit: input.limit ?? 20,
      includeHidden: input.includeHidden ?? false
    });

    const rawModels =
      isObjectLike(result) && Array.isArray(result.data)
        ? result.data
        : isObjectLike(result) && Array.isArray(result.models)
          ? result.models
          : [];

    return rawModels.flatMap((candidate) => {
      if (!isObjectLike(candidate)) {
        return [];
      }

      const model = getString(candidate, "model") ?? getString(candidate, "id");
      const id = getString(candidate, "id") ?? model;
      if (!id || !model) {
        return [];
      }

      return [
        {
          id,
          model,
          displayName: getString(candidate, "displayName"),
          hidden: getBoolean(candidate, "hidden"),
          isDefault: getBoolean(candidate, "isDefault")
        }
      ];
    });
  }

  async getDefaultModel(): Promise<CodexAppServerModel> {
    const models = await this.listModels({ limit: 50, includeHidden: false });
    const preferred = models.find((candidate) => candidate.isDefault) ?? models[0];
    if (!preferred) {
      throw new Error("Codex app-server did not return any runnable models.");
    }

    return preferred;
  }

  async logout(): Promise<void> {
    await this.request("account/logout");
  }

  async loginWithChatGpt(
    input: { timeoutMs?: number } = {}
  ): Promise<ChatGptLoginResult & { browserOpened: boolean }> {
    const timeoutMs = input.timeoutMs ?? 120_000;
    const result = await this.request("account/login/start", { type: "chatgpt" }, timeoutMs);
    const type = getString(result, "type");
    const loginId = getString(result, "loginId");
    const authUrl = getString(result, "authUrl");

    if (type !== "chatgpt" || !loginId || !authUrl) {
      throw new Error("Codex app-server returned an invalid ChatGPT login response.");
    }

    const browserOpened = maybeOpenBrowser(authUrl, this.env);

    const completed = await this.waitForNotification(
      "account/login/completed",
      (params) => getString(params, "loginId") === loginId,
      timeoutMs
    );

    if (completed.success !== true) {
      throw new Error(getString(completed, "error") ?? "ChatGPT login failed.");
    }

    await this.waitForNotification(
      "account/updated",
      (params) => getString(params, "authMode") === "chatgpt",
      10_000
    );

    return {
      loginId,
      authUrl,
      browserOpened
    };
  }

  async runTextTurn(input: RunTextTurnInput): Promise<RunTextTurnResult> {
    const account = await this.getAccount();
    if (!account.account || account.account.type !== "chatgpt") {
      throw new Error("AUTH_REQUIRED");
    }

    const threadStart = await this.request("thread/start", {
      model: input.model,
      modelProvider: "openai",
      cwd: input.cwd ?? process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: input.developerInstructions ?? null,
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    }, input.timeoutMs);

    const thread = isObjectLike(threadStart) && isObjectLike(threadStart.thread)
      ? threadStart.thread
      : undefined;
    const threadId = getString(thread, "id");

    if (!threadId) {
      throw new Error("Codex app-server thread/start response did not include a thread id.");
    }

    const turnStart = await this.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: input.prompt,
          text_elements: []
        }
      ],
      model: input.model,
      cwd: input.cwd ?? process.cwd()
    }, input.timeoutMs);

    const turn = isObjectLike(turnStart) && isObjectLike(turnStart.turn)
      ? turnStart.turn
      : undefined;
    const turnId = getString(turn, "id");
    if (!turnId) {
      throw new Error("Codex app-server turn/start response did not include a turn id.");
    }

    const turnCompleted = await this.waitForNotification(
      "turn/completed",
      (params) =>
        isObjectLike(params.turn) && getString(params.turn, "id") === turnId,
      input.timeoutMs
    );

    const completedTurn = getObject(turnCompleted, "turn");
    const completedTurnStatus = getString(completedTurn, "status");
    const completedTurnError = getObject(completedTurn, "error");

    if (completedTurnStatus && completedTurnStatus !== "completed") {
      const recordedError = this.findNotification(
        "error",
        (params) => getString(params, "turnId") === turnId
      );
      throw buildTurnError({
        threadId,
        turnId,
        payload: completedTurnError ?? getObject(recordedError, "error"),
        fallbackMessage: `Codex app-server turn ${turnId} finished with status "${completedTurnStatus}".`
      });
    }

    const itemCompleted = await this.waitForNotification(
      "item/completed",
      (params) =>
        getString(params, "turnId") === turnId &&
        isObjectLike(params.item) &&
        getString(params.item, "type") === "agentMessage",
      input.timeoutMs
    );

    const item = isObjectLike(itemCompleted.item) ? itemCompleted.item : undefined;
    const content = getString(item, "text");
    if (!content) {
      throw new Error("Codex app-server turn completed without an agent message.");
    }

    return {
      content,
      threadId,
      turnId,
      itemId: getString(item, "id"),
      model: getString(threadStart, "model") ?? input.model,
      raw: {
        threadStart,
        turnStart,
        turnCompleted,
        itemCompleted
      }
    };
  }

  private async start(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: normalizeCommandEnv(this.env),
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.stdout = createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    });

    this.stdout.on("line", (line) => {
      this.handleLine(line);
    });

    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (!text) {
        return;
      }

      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) {
        this.stderrTail.shift();
      }
    });

    this.process.on("exit", (code) => {
      const error = new Error(
        `Codex app-server exited unexpectedly${code !== null ? ` (code ${code})` : ""}.${this.formatStderrTail()}`
      );
      this.failAllPending(error);
    });

    await this.requestInternal("initialize", {
      clientInfo: {
        name: "multi-agent-framework",
        title: "Multi-Agent Framework",
        version: "0.1.0"
      },
      capabilities: null
    });
    this.notify("initialized", {});
  }

  private formatStderrTail(): string {
    return this.stderrTail.length > 0 ? ` ${this.stderrTail.at(-1)}` : "";
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }

  private handleLine(line: string): void {
    let message: JsonRpcRequestMessage;
    try {
      message = JSON.parse(line) as JsonRpcRequestMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      this.handleResponse(message);
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      const params = isObjectLike(message.params) ? message.params : {};
      this.recordNotification(message.method, params);
    }
  }

  private handleResponse(message: JsonRpcRequestMessage): void {
    const pending = this.pendingRequests.get(message.id as number);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id as number);

    if ("error" in message && message.error !== undefined) {
      const errorMessage =
        isObjectLike(message.error) && typeof message.error.message === "string"
          ? message.error.message
          : typeof message.error === "string"
            ? message.error
            : "Codex app-server request failed.";
      pending.reject(new Error(errorMessage));
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: JsonRpcRequestMessage): void {
    const requestId = message.id as number;
    const method = message.method ?? "unknown";
    this.send({
      id: requestId,
      error: {
        message: `Unsupported Codex app-server request: ${method}`
      }
    });
  }

  private recordNotification(method: string, params: Record<string, unknown>): void {
    const record: NotificationRecord = { method, params };
    this.notificationHistory.push(record);
    if (this.notificationHistory.length > 200) {
      this.notificationHistory.shift();
    }

    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.method !== method || !waiter.predicate(params)) {
        continue;
      }

      clearTimeout(waiter.timeout);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(params);
    }
  }

  private async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    await this.connect();
    return this.requestInternal(method, params, timeoutMs);
  }

  private requestInternal(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<unknown> {
    if (!this.process || !this.process.stdin.writable || this.closed) {
      throw new Error("Codex app-server is not connected.");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out (${method}).`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout
      });

      this.send({
        method,
        id,
        ...(params ? { params } : {})
      });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.send({
      method,
      ...(params ? { params } : {})
    });
  }

  private findNotification(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean
  ): Record<string, unknown> | undefined {
    for (let index = this.notificationHistory.length - 1; index >= 0; index -= 1) {
      const record = this.notificationHistory[index];
      if (record?.method === method && predicate(record.params)) {
        return record.params;
      }
    }

    return undefined;
  }

  private waitForNotification(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs = this.requestTimeoutMs
  ): Promise<Record<string, unknown>> {
    const record = this.findNotification(method, predicate);
    if (record) {
      return Promise.resolve(record);
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error(`Timed out waiting for Codex app-server notification: ${method}`));
        }, timeoutMs)
      };

      this.notificationWaiters.add(waiter);
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
