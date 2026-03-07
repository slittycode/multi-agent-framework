import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { listAvailableConnectors } from "../connectors/connector-resolution";
import {
  assertExecutionReady,
  executePreparedRun,
  prepareRunExecution,
  type PreparedRunExecution
} from "../run/prepare-run";
import type { Message, Transcript } from "../types";
import { formatConnectorListResponse } from "./connectors-response";
import {
  filterRunListEntries,
  readPersistedRunEntries,
  readPersistedTranscript,
  mergeRunListEntries
} from "./run-history";
import { ServerRunManager } from "./run-manager";
import type {
  ApiConnectorListEntry,
  ApiRunCompleteEventMessage,
  ApiRunListEntry,
  ApiRunStartRequest
} from "./types";

const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const LOCALHOST_ORIGIN_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u;

export interface ServerRunExecutorInput {
  request: ApiRunStartRequest;
  preparedRun: PreparedRunExecution;
  onMessage: (message: Message) => void;
}

export interface ServerRunExecutorResult {
  transcript: Transcript;
  persistedPath?: string;
}

export type ServerRunExecutor = (
  input: ServerRunExecutorInput
) => Promise<ServerRunExecutorResult>;

export interface StartApiServerOptions {
  port?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  packageVersion?: string;
  runExecutor?: ServerRunExecutor;
  heartbeatIntervalMs?: number;
}

export interface ApiServerInstance {
  port: number;
  url: string;
  server: Bun.Server<undefined>;
  runManager: ServerRunManager;
  stop: () => Promise<void>;
}

interface RunMetric {
  agentId: string;
  turns: number;
  totalTokens: number;
  avgLatencyMs: number;
}

function getAllowedOrigin(request: Request): string | undefined {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) {
    return undefined;
  }

  return LOCALHOST_ORIGIN_PATTERN.test(origin) ? origin : undefined;
}

function buildCorsHeaders(origin?: string): Headers {
  const headers = new Headers();
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function jsonResponse(status: number, body: unknown, origin?: string): Response {
  const headers = buildCorsHeaders(origin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function preflightResponse(origin?: string): Response {
  const headers = buildCorsHeaders(origin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

function notFoundResponse(origin?: string): Response {
  return jsonResponse(404, { error: "Not Found" }, origin);
}

function notImplementedResponse(origin?: string): Response {
  return jsonResponse(501, { error: "Not Implemented" }, origin);
}

async function readPackageVersion(cwd: string): Promise<string> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version
      : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

function deriveMessageEventType(message: Message): "turn" | "synthesis" | "error" {
  if (message.kind === "synthesis") {
    return "synthesis";
  }
  if (message.kind === "error") {
    return "error";
  }
  return "turn";
}

function buildExpectedPersistedPath(cwd: string, preparedRun: PreparedRunExecution): string | undefined {
  const transcriptConfig = preparedRun.runConfig.transcript;
  if (!transcriptConfig?.persistToFile) {
    return undefined;
  }

  return resolve(
    cwd,
    transcriptConfig.outputDir ?? "./runs",
    `${preparedRun.runId}.transcript.${transcriptConfig.format ?? "json"}`
  );
}

function createDefaultRunExecutor(): ServerRunExecutor {
  return async ({ preparedRun, onMessage }) => {
    const result = await executePreparedRun({
      preparedRun,
      onMessage
    });

    return {
      transcript: result.context.transcript,
      persistedPath: result.persistedPath
    };
  };
}

function parseRunStartRequest(payload: unknown): ApiRunStartRequest {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Request body must be a JSON object.");
  }

  const body = payload as Record<string, unknown>;
  const adapterId = typeof body.adapterId === "string" ? body.adapterId.trim() : "";
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const connectorId =
    typeof body.connectorId === "string" && body.connectorId.trim().length > 0
      ? body.connectorId.trim()
      : undefined;
  const model =
    typeof body.model === "string" && body.model.trim().length > 0
      ? body.model.trim()
      : undefined;

  if (!adapterId) {
    throw new Error("adapterId is required.");
  }
  if (!topic) {
    throw new Error("topic is required.");
  }

  return {
    adapterId,
    topic,
    connectorId,
    model
  };
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) {
    throw new Error("Request body must be valid JSON.");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function calculateRunMetrics(transcript: Transcript): RunMetric[] {
  const metricsByAgent = new Map<
    string,
    { turns: number; totalTokens: number; totalLatencyMs: number; latencySamples: number }
  >();

  for (const message of transcript.messages) {
    if (message.from === "orchestrator" || message.from === "system" || message.from === "user") {
      continue;
    }

    const existing = metricsByAgent.get(message.from) ?? {
      turns: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
      latencySamples: 0
    };
    existing.turns += 1;
    existing.totalTokens += (message.usage?.inputTokens ?? 0) + (message.usage?.outputTokens ?? 0);
    if (typeof message.usage?.latencyMs === "number") {
      existing.totalLatencyMs += message.usage.latencyMs;
      existing.latencySamples += 1;
    }
    metricsByAgent.set(message.from, existing);
  }

  return [...metricsByAgent.entries()].map(([agentId, metric]) => ({
    agentId,
    turns: metric.turns,
    totalTokens: metric.totalTokens,
    avgLatencyMs:
      metric.latencySamples > 0 ? metric.totalLatencyMs / metric.latencySamples : 0
  }));
}

function createCompleteOnlyStream(
  transcript: Transcript,
  completeMessage: ApiRunCompleteEventMessage,
  origin: string | undefined
): Response {
  const headers = buildCorsHeaders(origin);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("Connection", "keep-alive");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const message of transcript.messages) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: deriveMessageEventType(message), message })}\n\n`
          )
        );
      }

      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "complete", message: completeMessage })}\n\n`)
      );
      controller.close();
    }
  });

  return new Response(stream, { status: 200, headers });
}

function createLiveStream(input: {
  runId: string;
  transcript: Transcript;
  runManager: ServerRunManager;
  requestSignal: AbortSignal;
  heartbeatIntervalMs: number;
  origin?: string;
}): Response {
  const headers = buildCorsHeaders(input.origin);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("Connection", "keep-alive");

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribe();
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        try {
          controller.close();
        } catch {
          // Ignore controller close errors during abort cleanup.
        }
      };

      const sendEvent = (payload: unknown) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      for (const message of input.transcript.messages) {
        sendEvent({ type: deriveMessageEventType(message), message });
      }

      if (!input.runManager.isActive(input.runId)) {
        const completeMessage = input.runManager.buildCompleteMessage(input.runId);
        if (completeMessage) {
          sendEvent({ type: "complete", message: completeMessage });
        }
        close();
        return;
      }

      unsubscribe = input.runManager.subscribe(input.runId, {
        onMessage: (message) => {
          sendEvent({ type: deriveMessageEventType(message), message });
        },
        onComplete: (message) => {
          sendEvent({ type: "complete", message });
          close();
        }
      });

      if (input.heartbeatIntervalMs > 0) {
        heartbeat = setInterval(() => {
          if (!closed) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          }
        }, input.heartbeatIntervalMs);
      }

      input.requestSignal.addEventListener("abort", close, { once: true });
    }
  });

  return new Response(stream, { status: 200, headers });
}

export async function startApiServer(
  options: StartApiServerOptions = {}
): Promise<ApiServerInstance> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const version = options.packageVersion ?? (await readPackageVersion(cwd));
  const runExecutor = options.runExecutor ?? createDefaultRunExecutor();
  const runManager = new ServerRunManager();
  const runsDir = join(cwd, "runs");
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const server = Bun.serve({
    port: options.port ?? DEFAULT_SERVER_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = getAllowedOrigin(request);
      const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

      if (request.method === "OPTIONS") {
        return preflightResponse(origin);
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "health") {
        return jsonResponse(200, { status: "ok", version }, origin);
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "connectors") {
        const available = await listAvailableConnectors({ cwd, env });
        const response: ApiConnectorListEntry[] = formatConnectorListResponse({
          activeConnectorId: available.activeConnectorId,
          connectors: available.connectors
        });
        return jsonResponse(200, response, origin);
      }

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "runs") {
        if (request.method === "GET") {
          const persistedEntries = await readPersistedRunEntries(runsDir);
          const activeEntries = runManager.listActiveEntries();
          const response = filterRunListEntries(
            mergeRunListEntries({
              persistedEntries,
              activeEntries
            }),
            {
              filter: url.searchParams.get("filter"),
              status: url.searchParams.get("status")
            }
          );
          return jsonResponse(200, response, origin);
        }

        if (request.method === "POST") {
          let runRequest: ApiRunStartRequest;
          try {
            runRequest = parseRunStartRequest(await parseJsonBody(request));
          } catch (error) {
            return jsonResponse(
              400,
              { error: error instanceof Error ? error.message : "Invalid request body." },
              origin
            );
          }

          let preparedRun: PreparedRunExecution;
          try {
            preparedRun = await prepareRunExecution({
              adapterSource: runRequest.adapterId,
              topic: runRequest.topic,
              executionMode: "auto",
              connectorId: runRequest.connectorId,
              model: runRequest.model,
              cwd,
              env,
              requireStoredConnector: true
            });
          } catch (error) {
            return jsonResponse(
              400,
              { error: error instanceof Error ? error.message : "Unable to prepare run." },
              origin
            );
          }

          try {
            assertExecutionReady(preparedRun.resolution);
          } catch (error) {
            return jsonResponse(
              400,
              { error: error instanceof Error ? error.message : "Unable to start run." },
              origin
            );
          }

          runManager.createRun(preparedRun, runRequest);

          void (async () => {
            try {
              const result = await runExecutor({
                request: runRequest,
                preparedRun,
                onMessage: (message) => {
                  runManager.appendMessage(preparedRun.runId, message);
                }
              });
              runManager.completeRun(preparedRun.runId, result.transcript, result.persistedPath);
            } catch (error) {
              runManager.failRun(
                preparedRun.runId,
                error,
                buildExpectedPersistedPath(cwd, preparedRun)
              );
            }
          })();

          return jsonResponse(
            202,
            {
              runId: preparedRun.runId,
              status: "started"
            },
            origin
          );
        }
      }

      if (segments.length >= 3 && segments[0] === "api" && segments[1] === "runs") {
        const runId = segments[2] ?? "";

        if (segments.length === 4 && request.method === "POST") {
          if (segments[3] === "inject" || segments[3] === "interrupt") {
            return notImplementedResponse(origin);
          }
        }

        const state = runManager.getRun(runId);
        const transcript = state?.transcript ?? (await readPersistedTranscript(runsDir, runId));

        if (!transcript) {
          return notFoundResponse(origin);
        }

        if (segments.length === 3 && request.method === "GET") {
          return jsonResponse(200, transcript, origin);
        }

        if (segments.length === 4 && segments[3] === "metrics" && request.method === "GET") {
          return jsonResponse(200, calculateRunMetrics(transcript), origin);
        }

        if (segments.length === 4 && segments[3] === "stream" && request.method === "GET") {
          const completeMessage =
            runManager.buildCompleteMessage(runId) ?? {
              runId,
              status: transcript.status === "failed" ? "failed" : "completed",
              startedAt: transcript.startedAt,
              endedAt: transcript.endedAt,
              persistedPath: state?.persistedPath
            };

          if (state && runManager.isActive(runId)) {
            return createLiveStream({
              runId,
              transcript,
              runManager,
              requestSignal: request.signal,
              heartbeatIntervalMs,
              origin
            });
          }

          return createCompleteOnlyStream(transcript, completeMessage, origin);
        }
      }

      return notFoundResponse(origin);
    }
  });

  const actualPort = server.port ?? (options.port ?? DEFAULT_SERVER_PORT);

  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    runManager,
    stop: async () => {
      server.stop(true);
    }
  };
}
