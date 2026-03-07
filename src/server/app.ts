import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { listBuiltinAdapterIds, loadDomainAdapter } from "../adapters/adapter-loader";
import { listAvailableConnectors } from "../connectors/connector-resolution";
import {
  assertExecutionReady,
  executePreparedRun,
  prepareRunExecution,
  type PreparedRunExecution
} from "../run/prepare-run";
import type {
  InterTurnHook,
  Message,
  RunLifecycleEvent,
  Transcript
} from "../types";
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
  ApiRunInjectionRequest,
  ApiRunListEntry,
  ApiRunStartRequest,
  ApiRunSteerRequest,
  ApiRunStreamEvent
} from "./types";

const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const LOCALHOST_ORIGIN_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u;

export interface ServerRunExecutorInput {
  request: ApiRunStartRequest;
  preparedRun: PreparedRunExecution;
  onMessage: (message: Message) => void;
  onEvent?: (event: RunLifecycleEvent) => void;
  interTurnHook?: InterTurnHook;
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

function deriveMessageEventType(message: Message): "turn" | "synthesis" | "error" | "injection" {
  if (message.kind === "synthesis") {
    return "synthesis";
  }
  if (message.kind === "error") {
    return "error";
  }
  if (message.kind === "injection") {
    return "injection";
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
  return async ({ preparedRun, onEvent, onMessage, interTurnHook }) => {
    const result = await executePreparedRun({
      preparedRun,
      onMessage,
      onEvent,
      interTurnHook
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
  const rawAgentOverrides =
    typeof body.agentOverrides === "object" && body.agentOverrides !== null
      ? (body.agentOverrides as Record<string, unknown>)
      : undefined;
  const agentOverrides =
    rawAgentOverrides && Object.keys(rawAgentOverrides).length > 0
      ? Object.fromEntries(
          Object.entries(rawAgentOverrides).map(([agentId, override]) => {
            if (typeof override !== "object" || override === null) {
              throw new Error(`agentOverrides.${agentId} must be an object.`);
            }

            const candidate = override as Record<string, unknown>;
            return [
              agentId,
              {
                ...(typeof candidate.systemPrompt === "string"
                  ? { systemPrompt: candidate.systemPrompt }
                  : {}),
                ...(typeof candidate.systemPromptSuffix === "string"
                  ? { systemPromptSuffix: candidate.systemPromptSuffix }
                  : {}),
                ...(typeof candidate.persona === "string"
                  ? { persona: candidate.persona }
                  : {})
              }
            ];
          })
        )
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
    model,
    ...(agentOverrides ? { agentOverrides } : {})
  };
}

function parseInjectRequest(payload: unknown): ApiRunInjectionRequest {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Request body must be a JSON object.");
  }

  const body = payload as Record<string, unknown>;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const fromLabel =
    typeof body.fromLabel === "string" && body.fromLabel.trim().length > 0
      ? body.fromLabel.trim()
      : undefined;
  const targetPhaseId =
    typeof body.targetPhaseId === "string" && body.targetPhaseId.trim().length > 0
      ? body.targetPhaseId.trim()
      : undefined;

  if (!content) {
    throw new Error("content is required.");
  }

  return {
    content,
    fromLabel,
    targetPhaseId
  };
}

function parseSteerRequest(payload: unknown): ApiRunSteerRequest {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Request body must be a JSON object.");
  }

  const body = payload as Record<string, unknown>;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const directive = typeof body.directive === "string" ? body.directive.trim() : "";
  const turnsRemaining =
    typeof body.turnsRemaining === "number" && Number.isInteger(body.turnsRemaining)
      ? body.turnsRemaining
      : 3;

  if (!agentId) {
    throw new Error("agentId is required.");
  }
  if (!directive) {
    throw new Error("directive is required.");
  }

  return {
    agentId,
    directive,
    turnsRemaining
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
    if (
      message.from === "orchestrator" ||
      message.from === "system" ||
      message.from === "user" ||
      message.kind === "injection"
    ) {
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

function toApiRunStreamEvent(event: RunLifecycleEvent): ApiRunStreamEvent {
  return {
    type: event.type,
    message: event.message
  };
}

function sendSseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: ApiRunStreamEvent,
  encoder: TextEncoder
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
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
        sendSseEvent(
          controller,
          {
            type: deriveMessageEventType(message),
            message
          },
          encoder
        );
      }

      sendSseEvent(
        controller,
        {
          type: "complete",
          message: completeMessage
        },
        encoder
      );
      controller.close();
    }
  });

  return new Response(stream, { status: 200, headers });
}

function createEventReplayStream(
  events: ApiRunStreamEvent[],
  origin: string | undefined
): Response {
  const headers = buildCorsHeaders(origin);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("Connection", "keep-alive");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        sendSseEvent(controller, event, encoder);
      }
      controller.close();
    }
  });

  return new Response(stream, { status: 200, headers });
}

function createLiveStream(input: {
  runId: string;
  events: ApiRunStreamEvent[];
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

      const sendEvent = (payload: ApiRunStreamEvent) => {
        if (closed) {
          return;
        }
        sendSseEvent(controller, payload, encoder);
      };

      for (const event of input.events) {
        sendEvent(event);
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
        onEvent: (event) => {
          sendEvent(event);
          if (event.type === "complete") {
            close();
          }
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

      if (segments.length === 2 && segments[0] === "api" && segments[1] === "adapters") {
        if (request.method === "GET") {
          return jsonResponse(200, listBuiltinAdapterIds(), origin);
        }
      }

      if (segments.length === 3 && segments[0] === "api" && segments[1] === "adapters") {
        if (request.method === "GET") {
          try {
            const adapter = await loadDomainAdapter(segments[2] ?? "", { cwd });
            return jsonResponse(200, adapter, origin);
          } catch {
            return notFoundResponse(origin);
          }
        }
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
              agentOverrides: runRequest.agentOverrides,
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
          const interTurnHook = runManager.createInterTurnHook(preparedRun.runId);

          void (async () => {
            try {
              const result = await runExecutor({
                request: runRequest,
                preparedRun,
                onMessage: (message) => {
                  runManager.appendMessage(preparedRun.runId, message);
                },
                onEvent: (event) => {
                  runManager.recordLifecycleEvent(
                    preparedRun.runId,
                    toApiRunStreamEvent(event)
                  );
                },
                interTurnHook
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
        const state = runManager.getRun(runId);
        const transcript = state?.transcript ?? (await readPersistedTranscript(runsDir, runId));

        if (segments.length === 4 && request.method === "POST") {
          if (segments[3] === "inject") {
            if (!state) {
              return transcript
                ? jsonResponse(409, { error: "Run is already completed." }, origin)
                : notFoundResponse(origin);
            }

            let injectRequest: ApiRunInjectionRequest;
            try {
              injectRequest = parseInjectRequest(await parseJsonBody(request));
            } catch (error) {
              return jsonResponse(
                400,
                { error: error instanceof Error ? error.message : "Invalid request body." },
                origin
              );
            }

            try {
              const injectionId = runManager.queueInjection(runId, injectRequest);
              return jsonResponse(200, { injectionId, status: "queued" }, origin);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unable to queue injection.";
              if (message.includes("not found")) {
                return notFoundResponse(origin);
              }
              if (message.includes("completed")) {
                return jsonResponse(409, { error: message }, origin);
              }
              return jsonResponse(400, { error: message }, origin);
            }
          }

          if (segments[3] === "pause") {
            if (!state) {
              return transcript
                ? jsonResponse(409, { error: "Run is not currently running." }, origin)
                : notFoundResponse(origin);
            }

            try {
              runManager.pauseRun(runId);
              return jsonResponse(200, { status: "paused" }, origin);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unable to pause run.";
              if (message.includes("already paused")) {
                return jsonResponse(400, { error: message }, origin);
              }
              return jsonResponse(409, { error: message }, origin);
            }
          }

          if (segments[3] === "resume") {
            if (!state) {
              return transcript
                ? jsonResponse(400, { error: "Run is not paused." }, origin)
                : notFoundResponse(origin);
            }

            try {
              runManager.resumeRun(runId);
              return jsonResponse(200, { status: "resumed" }, origin);
            } catch (error) {
              return jsonResponse(
                400,
                { error: error instanceof Error ? error.message : "Unable to resume run." },
                origin
              );
            }
          }

          if (segments[3] === "interrupt") {
            if (!state) {
              return transcript
                ? jsonResponse(409, { error: "Run is already completed." }, origin)
                : notFoundResponse(origin);
            }

            try {
              const result = runManager.requestInterrupt(runId);
              return jsonResponse(
                200,
                {
                  status: "interrupting",
                  ...(result.resumedFromPause ? { resumedFromPause: true } : {})
                },
                origin
              );
            } catch (error) {
              return jsonResponse(
                409,
                { error: error instanceof Error ? error.message : "Unable to interrupt run." },
                origin
              );
            }
          }

          if (segments[3] === "steer") {
            if (!state) {
              return transcript
                ? jsonResponse(409, { error: "Run is already completed." }, origin)
                : notFoundResponse(origin);
            }

            let steerRequest: ApiRunSteerRequest;
            try {
              steerRequest = parseSteerRequest(await parseJsonBody(request));
            } catch (error) {
              return jsonResponse(
                400,
                { error: error instanceof Error ? error.message : "Invalid request body." },
                origin
              );
            }

            try {
              const turnsRemaining = steerRequest.turnsRemaining ?? 3;
              runManager.queueSteer(runId, {
                ...steerRequest,
                turnsRemaining
              });
              return jsonResponse(
                200,
                {
                  status: "queued",
                  agentId: steerRequest.agentId,
                  turnsRemaining
                },
                origin
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unable to steer run.";
              if (message.includes("Unknown agentId")) {
                return jsonResponse(404, { error: message }, origin);
              }
              if (message.includes("completed")) {
                return jsonResponse(409, { error: message }, origin);
              }
              return jsonResponse(400, { error: message }, origin);
            }
          }
        }

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
          if (state && state.events.length > 0 && !runManager.isActive(runId)) {
            return createEventReplayStream(state.events, origin);
          }

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
              events: runManager.getEvents(runId),
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
