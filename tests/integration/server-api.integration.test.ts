import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { runDiscussion } from "../../src/core/orchestrator";
import { saveConnectorCatalog } from "../../src/connectors/catalog";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type {
  ProviderClient,
  ProviderGenerateRequest,
  ProviderGenerateResult
} from "../../src/providers/provider-client";
import { startApiServer, type ServerRunExecutorInput } from "../../src/server/app";
import { persistTranscript } from "../../src/transcript/file-persistor";
import { appendMessage, finalizeTranscript, initializeTranscript } from "../../src/transcript/transcript-store";
import type { Message, Transcript } from "../../src/types";

function buildAgentMessage(input: {
  runId: string;
  turnIndex: number;
  from: string;
  kind: Message["kind"];
  content: string;
  latencyMs?: number;
}): Message {
  return {
    id: `${input.runId}-message-${input.turnIndex}`,
    runId: input.runId,
    roundId: "round-1",
    phaseId: input.kind === "synthesis" ? "synthesis" : "opening",
    turnIndex: input.turnIndex,
    timestamp: new Date(Date.UTC(2026, 2, 7, 10, 0, input.turnIndex)).toISOString(),
    from: input.from,
    to: "all",
    kind: input.kind,
    content: input.content,
    usage: {
      inputTokens: 10 * input.turnIndex,
      outputTokens: 15 * input.turnIndex,
      latencyMs: input.latencyMs
    }
  };
}

function buildPersistedTranscript(input: {
  runId: string;
  topic: string;
  startedAt: string;
  endedAt?: string;
  status?: Transcript["status"];
  actionabilityScore?: number;
  adapterId?: string;
  messageCount?: number;
}): Transcript {
  const messageCount = input.messageCount ?? 1;
  const messages =
    messageCount === 0
      ? []
      : Array.from({ length: messageCount }, (_, index) =>
          buildAgentMessage({
            runId: input.runId,
            turnIndex: index + 1,
            from: "advocate",
            kind: "agent_turn",
            content: `${input.topic} opening ${index + 1}.`
          })
        );

  return {
    runId: input.runId,
    adapterId: input.adapterId ?? "general-debate",
    topic: input.topic,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    status: input.status ?? "completed",
    messages,
    synthesis: {
      agentId: "synthesiser",
      messageId: `${input.runId}-message-2`,
      summary: `${input.topic} synthesis.`,
      recommendations: [{ text: "Document the next step", priority: "high" }]
    },
    metadata:
      input.actionabilityScore === undefined
        ? undefined
        : {
            qualityGate: {
              score: input.actionabilityScore
            }
          }
  };
}

function parseSsePayload(text: string): Array<{ type: string; message: unknown }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; message: unknown });
}

function createControlledExecutor(runsDir: string) {
  let releaseRun: (() => void) | undefined;
  let firstMessageResolved = false;
  let resolveFirstMessage: (() => void) | undefined;

  const firstMessageReady = new Promise<void>((resolve) => {
    resolveFirstMessage = resolve;
  });

  const runReleased = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const runExecutor = async ({ preparedRun, onMessage }: ServerRunExecutorInput) => {
    const firstMessage = buildAgentMessage({
      runId: preparedRun.runId,
      turnIndex: 1,
      from: "advocate",
      kind: "agent_turn",
      content: `Opening take on ${preparedRun.topic}.`,
      latencyMs: 900
    });
    onMessage(firstMessage);
    if (!firstMessageResolved) {
      firstMessageResolved = true;
      resolveFirstMessage?.();
    }

    await runReleased;

    const synthesisMessage = buildAgentMessage({
      runId: preparedRun.runId,
      turnIndex: 2,
      from: preparedRun.adapter.synthesisAgentId,
      kind: "synthesis",
      content: `Synthesis for ${preparedRun.topic}.`,
      latencyMs: 1500
    });
    onMessage(synthesisMessage);

    const transcript = finalizeTranscript(
      appendMessage(
        appendMessage(
          initializeTranscript({
            runId: preparedRun.runId,
            adapterId: preparedRun.adapter.id,
            topic: preparedRun.topic,
            metadata: preparedRun.metadata
          }),
          firstMessage
        ),
        synthesisMessage
      ),
      "completed",
      {
        agentId: preparedRun.adapter.synthesisAgentId,
        messageId: synthesisMessage.id,
        summary: `Summary for ${preparedRun.topic}.`,
        verdict: "Proceed carefully.",
        recommendations: [{ text: "Document the decision", priority: "high" }]
      }
    );

    return {
      transcript,
      persistedPath: resolve(
        runsDir,
        `${preparedRun.runId}.transcript.json`
      )
    };
  };

  return {
    firstMessageReady,
    release(): void {
      releaseRun?.();
    },
    runExecutor
  };
}

class RecordingGeminiProvider implements ProviderClient {
  readonly id = "gemini";
  readonly requests: ProviderGenerateRequest[] = [];

  async generate(request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    this.requests.push(request);

    if (request.phaseId === "judge") {
      return {
        content: JSON.stringify({
          finished: false,
          rationale: "keep going"
        }),
        provider: "gemini",
        model: "gemini-test-model"
      };
    }

    if (request.phaseId === "synthesis") {
      return {
        content: JSON.stringify({
          summary: `Synthesis for ${request.runId}.`,
          verdict: "Wrap with a concise recommendation.",
          recommendations: [
            {
              text: "Capture the next practical step.",
              priority: "high"
            }
          ]
        }),
        provider: "gemini",
        model: "gemini-test-model"
      };
    }

    return {
      content: `${request.agent.id}|${request.phaseId}|persona=${request.agent.persona}|system=${request.systemPrompt ?? ""}`,
      provider: "gemini",
      model: "gemini-test-model",
      invocationId: `gemini-inv-${request.turnIndex ?? this.requests.length}`
    };
  }
}

function createOrchestratedExecutor(provider: RecordingGeminiProvider) {
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });

  return {
    provider,
    releaseStart() {
      releaseStart?.();
    },
    runExecutor: async ({
      preparedRun,
      onEvent,
      onMessage,
      interTurnHook
    }: ServerRunExecutorInput) => {
      await startGate;

      const result = await runDiscussion({
        adapter: preparedRun.adapter,
        topic: preparedRun.topic,
        runId: preparedRun.runId,
        providerRegistry: new ProviderRegistry([provider]),
        config: preparedRun.runConfig,
        evaluationTier: preparedRun.evaluationTier,
        metadata: preparedRun.metadata,
        onEvent,
        onMessage,
        interTurnHook
      });

      return {
        transcript: result.context.transcript,
        persistedPath: result.persistedPath
      };
    }
  };
}

function createSseObserver(url: string) {
  const events: Array<{ type: string; message: unknown }> = [];
  const waiters = new Map<string, Array<(event: { type: string; message: unknown }) => void>>();
  const decoder = new TextDecoder();

  const completion = (async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("SSE response body is missing.");
    }

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const separatorIndex = buffer.indexOf("\n\n");
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const dataLine = chunk
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) {
          continue;
        }

        const event = JSON.parse(dataLine.slice("data: ".length)) as {
          type: string;
          message: unknown;
        };
        events.push(event);

        const typedWaiters = waiters.get(event.type);
        if (typedWaiters && typedWaiters.length > 0) {
          const nextWaiter = typedWaiters.shift();
          nextWaiter?.(event);
        }
      }
    }

    return events;
  })();

  return {
    waitForType(type: string): Promise<{ type: string; message: unknown }> {
      const existing = events.find((event) => event.type === type);
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise((resolve) => {
        const typedWaiters = waiters.get(type) ?? [];
        typedWaiters.push(resolve);
        waiters.set(type, typedWaiters);
      });
    },
    done: completion,
    events
  };
}

describe("integration/server-api", () => {
  test("serves health, CORS, connectors, and adapter introspection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-server-api-health-"));

    try {
      await saveConnectorCatalog(
        {
          schemaVersion: 2,
          activeConnectorId: "openai-main",
          connectors: [
            {
              id: "openai-main",
              providerId: "openai",
              authMethod: "chatgpt-oauth",
              defaultModel: "gpt-5",
              credentialSource: "codex-app-server",
              credentialRef: "openai-main",
              lastCertificationStatus: "passed",
              lastCertifiedAt: "2026-03-07T10:00:00.000Z",
              liveCertification: {
                latestProfile: "full",
                overallStatus: "passed",
                checkedAt: "2026-03-07T10:00:00.000Z",
                freshUntil: "2099-03-14T10:00:00.000Z",
                manifestPath: "/tmp/openai-main.manifest.json",
                layers: {
                  auth: { status: "passed", freshUntil: "2099-03-08T10:00:00.000Z" },
                  provider: { status: "passed", freshUntil: "2099-03-08T10:00:00.000Z" },
                  run: { status: "passed", freshUntil: "2099-03-08T10:00:00.000Z" },
                  benchmark: { status: "passed", freshUntil: "2099-03-14T10:00:00.000Z" }
                }
              },
              runtimeStatus: "ready",
              providerNote: "Uses the Codex app server flow."
            }
          ]
        },
        { cwd }
      );

      const server = await startApiServer({
        cwd,
        port: 0,
        packageVersion: "1.2.3-test",
        env: {}
      });

      try {
        const origin = "http://localhost:5173";
        const preflight = await fetch(`${server.url}/api/runs`, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type"
          }
        });

        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
        expect(preflight.headers.get("vary")).toBe("Origin");

        const healthResponse = await fetch(`${server.url}/api/health`);
        expect(healthResponse.status).toBe(200);
        expect(await healthResponse.json()).toEqual({
          status: "ok",
          version: "1.2.3-test"
        });

        const connectorsResponse = await fetch(`${server.url}/api/connectors`);
        expect(connectorsResponse.status).toBe(200);
        const connectors = (await connectorsResponse.json()) as Array<Record<string, unknown>>;
        expect(connectors).toHaveLength(1);
        expect(connectors[0]).toMatchObject({
          id: "openai-main",
          active: true,
          providerId: "openai",
          authMethod: "chatgpt-oauth",
          certificationStatus: "passed",
          certificationProfile: "full"
        });

        const adaptersResponse = await fetch(`${server.url}/api/adapters`);
        expect(adaptersResponse.status).toBe(200);
        expect(await adaptersResponse.json()).toEqual([
          "ableton-feedback",
          "creative-writing",
          "general-debate"
        ]);

        const adapterResponse = await fetch(`${server.url}/api/adapters/general-debate`);
        expect(adapterResponse.status).toBe(200);
        const adapter = (await adapterResponse.json()) as Record<string, unknown>;
        expect(adapter).toMatchObject({
          id: "general-debate",
          synthesisAgentId: "synthesiser"
        });
        expect(Array.isArray(adapter.agents)).toBe(true);
        expect(Array.isArray(adapter.rounds)).toBe(true);

        const missingAdapterResponse = await fetch(`${server.url}/api/adapters/does-not-exist`);
        expect(missingAdapterResponse.status).toBe(404);

        const missingResponse = await fetch(`${server.url}/api/runs/does-not-exist`);
        expect(missingResponse.status).toBe(404);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("lists active in-memory runs above persisted runs and deduplicates by runId", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-server-api-list-"));
    const runsDir = join(cwd, "runs");
    await mkdir(runsDir, { recursive: true });
    const executor = createControlledExecutor(runsDir);

    try {
      await persistTranscript({
        transcript: buildPersistedTranscript({
          runId: "persisted-newer",
          topic: "Persisted newer topic",
          startedAt: "2026-03-07T09:00:00.000Z",
          endedAt: "2026-03-07T09:05:00.000Z",
          actionabilityScore: 61.2
        }),
        outputDir: runsDir,
        format: "json"
      });

      await persistTranscript({
        transcript: buildPersistedTranscript({
          runId: "persisted-older",
          topic: "Persisted older topic",
          startedAt: "2026-03-07T08:00:00.000Z",
          endedAt: "2026-03-07T08:05:00.000Z",
          actionabilityScore: 58.8
        }),
        outputDir: runsDir,
        format: "json"
      });

      const server = await startApiServer({
        cwd,
        port: 0,
        runExecutor: executor.runExecutor
      });

      try {
        const startResponse = await fetch(`${server.url}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            adapterId: "general-debate",
            topic: "Active dashboard topic"
          })
        });

        expect(startResponse.status).toBe(202);
        const started = (await startResponse.json()) as { runId: string; status: string };
        expect(started.status).toBe("started");

        await executor.firstMessageReady;

        await persistTranscript({
          transcript: buildPersistedTranscript({
            runId: started.runId,
            topic: "Old persisted copy",
            startedAt: "2026-03-07T07:00:00.000Z",
            endedAt: "2026-03-07T07:05:00.000Z",
            actionabilityScore: 57.5
          }),
          outputDir: runsDir,
          format: "json"
        });

        const listResponse = await fetch(`${server.url}/api/runs`);
        expect(listResponse.status).toBe(200);
        const runs = (await listResponse.json()) as Array<Record<string, unknown>>;

        expect(runs[0]).toMatchObject({
          runId: started.runId,
          status: "running",
          topic: "Active dashboard topic",
          messageCount: 1
        });
        expect(runs.filter((entry) => entry.runId === started.runId)).toHaveLength(1);
        expect(runs.slice(1).map((entry) => entry.runId)).toEqual([
          "persisted-newer",
          "persisted-older"
        ]);

        const runResponse = await fetch(`${server.url}/api/runs/${started.runId}`);
        expect(runResponse.status).toBe(200);
        const run = (await runResponse.json()) as Transcript;
        expect(run.status).toBe("running");
        expect(run.messages).toHaveLength(1);
        expect(run.messages[0]?.content).toContain("Active dashboard topic");
      } finally {
        executor.release();
        await server.stop();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("filters runs with filter=real and status=completed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-server-api-filter-"));
    const runsDir = join(cwd, "runs");
    await mkdir(runsDir, { recursive: true });
    const executor = createControlledExecutor(runsDir);

    try {
      await persistTranscript({
        transcript: buildPersistedTranscript({
          runId: "real-completed",
          topic: "How should teams review quarterly plans?",
          startedAt: "2026-03-07T09:00:00.000Z",
          endedAt: "2026-03-07T09:05:00.000Z",
          actionabilityScore: 72
        }),
        outputDir: runsDir,
        format: "json"
      });

      await persistTranscript({
        transcript: buildPersistedTranscript({
          runId: "placeholder-topic",
          topic: "CLI topic",
          startedAt: "2026-03-07T08:00:00.000Z",
          endedAt: "2026-03-07T08:05:00.000Z"
        }),
        outputDir: runsDir,
        format: "json"
      });

      await persistTranscript({
        transcript: buildPersistedTranscript({
          runId: "fixture-adapter",
          topic: "Should still be filtered",
          adapterId: "fixture-demo",
          startedAt: "2026-03-07T07:00:00.000Z",
          endedAt: "2026-03-07T07:05:00.000Z"
        }),
        outputDir: runsDir,
        format: "json"
      });

      await persistTranscript({
        transcript: buildPersistedTranscript({
          runId: "empty-run",
          topic: "Placeholder topic",
          startedAt: "2026-03-07T06:00:00.000Z",
          endedAt: "2026-03-07T06:05:00.000Z",
          messageCount: 0
        }),
        outputDir: runsDir,
        format: "json"
      });

      const server = await startApiServer({
        cwd,
        port: 0,
        runExecutor: executor.runExecutor
      });

      try {
        const startResponse = await fetch(`${server.url}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            adapterId: "general-debate",
            topic: "Should a live active run stay visible?"
          })
        });

        expect(startResponse.status).toBe(202);
        await executor.firstMessageReady;

        const defaultListResponse = await fetch(`${server.url}/api/runs`);
        expect(defaultListResponse.status).toBe(200);
        const defaultList = (await defaultListResponse.json()) as Array<Record<string, unknown>>;
        expect(defaultList).toHaveLength(5);

        const filteredListResponse = await fetch(`${server.url}/api/runs?filter=real`);
        expect(filteredListResponse.status).toBe(200);
        const filteredList = (await filteredListResponse.json()) as Array<Record<string, unknown>>;
        expect(filteredList.map((entry) => entry.runId)).toEqual([
          defaultList[0]?.runId,
          "real-completed"
        ]);

        const completedOnlyResponse = await fetch(`${server.url}/api/runs?status=completed`);
        expect(completedOnlyResponse.status).toBe(200);
        const completedOnlyRuns = (await completedOnlyResponse.json()) as Array<Record<string, unknown>>;
        expect(completedOnlyRuns.map((entry) => entry.runId)).toEqual([
          "real-completed",
          "placeholder-topic",
          "fixture-adapter",
          "empty-run"
        ]);

        const completedRealResponse = await fetch(
          `${server.url}/api/runs?filter=real&status=completed`
        );
        expect(completedRealResponse.status).toBe(200);
        const completedRealRuns = (await completedRealResponse.json()) as Array<Record<string, unknown>>;
        expect(completedRealRuns).toEqual([
          {
            runId: "real-completed",
            adapterId: "general-debate",
            topic: "How should teams review quarterly plans?",
            status: "completed",
            startedAt: "2026-03-07T09:00:00.000Z",
            endedAt: "2026-03-07T09:05:00.000Z",
            messageCount: 1,
            actionabilityScore: 72
          }
        ]);
      } finally {
        executor.release();
        await server.stop();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("queues targeted injections, applies startup overrides and steer directives, and replays injection SSE events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-server-api-engage-"));
    const runsDir = join(cwd, "runs");
    await mkdir(runsDir, { recursive: true });
    const executor = createOrchestratedExecutor(new RecordingGeminiProvider());

    try {
      const server = await startApiServer({
        cwd,
        port: 0,
        runExecutor: executor.runExecutor
      });

      try {
        const startResponse = await fetch(`${server.url}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            adapterId: "general-debate",
            topic: "How should teams track roadmap risk?",
            agentOverrides: {
              advocate: {
                persona: "Measured and implementation-focused.",
                systemPromptSuffix: "Add one concrete implementation detail in every turn."
              },
              critic: {
                systemPrompt: "Full critic replacement prompt."
              }
            }
          })
        });

        expect(startResponse.status).toBe(202);
        const started = (await startResponse.json()) as { runId: string };

        const injectResponse = await fetch(`${server.url}/api/runs/${started.runId}/inject`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content: "Address delivery risk explicitly.",
            fromLabel: "User",
            targetPhaseId: "challenge"
          })
        });
        expect(injectResponse.status).toBe(200);
        const queuedInjection = (await injectResponse.json()) as { injectionId: string };

        const steerResponse = await fetch(`${server.url}/api/runs/${started.runId}/steer`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            agentId: "advocate",
            directive: "Emphasize operational risk.",
            turnsRemaining: 1
          })
        });
        expect(steerResponse.status).toBe(200);
        expect(await steerResponse.json()).toEqual({
          status: "queued",
          agentId: "advocate",
          turnsRemaining: 1
        });

        executor.releaseStart();

        await delay(25);

        const completedRunResponse = await fetch(`${server.url}/api/runs/${started.runId}`);
        expect(completedRunResponse.status).toBe(200);
        const completedRun = (await completedRunResponse.json()) as Transcript;

        const injectionIndex = completedRun.messages.findIndex((message) => message.kind === "injection");
        const firstChallengeIndex = completedRun.messages.findIndex(
          (message) => message.phaseId === "challenge" && message.kind !== "injection"
        );
        expect(injectionIndex).toBeGreaterThanOrEqual(0);
        expect(firstChallengeIndex).toBeGreaterThan(injectionIndex);
        expect(completedRun.messages[injectionIndex]).toMatchObject({
          from: "User",
          kind: "injection",
          content: "Address delivery risk explicitly.",
          metadata: {
            injectionId: queuedInjection.injectionId
          }
        });

        const advocateOpeningRequest = executor.provider.requests.find(
          (request) => request.phaseId === "opening" && request.agent.id === "advocate"
        );
        const advocateChallengeRequest = executor.provider.requests.find(
          (request) => request.phaseId === "challenge" && request.agent.id === "advocate"
        );
        const criticOpeningRequest = executor.provider.requests.find(
          (request) => request.phaseId === "opening" && request.agent.id === "critic"
        );

        expect(advocateOpeningRequest?.agent.persona).toBe(
          "Measured and implementation-focused."
        );
        expect(advocateOpeningRequest?.systemPrompt).toContain(
          "Add one concrete implementation detail in every turn."
        );
        expect(advocateOpeningRequest?.systemPrompt).toContain("Emphasize operational risk.");
        expect(advocateChallengeRequest?.systemPrompt).not.toContain("Emphasize operational risk.");
        expect(criticOpeningRequest?.systemPrompt).toBe("Full critic replacement prompt.");

        const replayStreamResponse = await fetch(`${server.url}/api/runs/${started.runId}/stream`);
        expect(replayStreamResponse.status).toBe(200);
        const replayEvents = parseSsePayload(await replayStreamResponse.text());
        expect(replayEvents.some((event) => event.type === "injection")).toBe(true);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("pauses at the inter-turn hook and resumes through the API", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-server-api-pause-"));
    const runsDir = join(cwd, "runs");
    await mkdir(runsDir, { recursive: true });
    const executor = createOrchestratedExecutor(new RecordingGeminiProvider());

    try {
      const server = await startApiServer({
        cwd,
        port: 0,
        runExecutor: executor.runExecutor,
        heartbeatIntervalMs: 5
      });

      try {
        const startResponse = await fetch(`${server.url}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            adapterId: "general-debate",
            topic: "Pause and resume topic"
          })
        });

        expect(startResponse.status).toBe(202);
        const started = (await startResponse.json()) as { runId: string };

        const pauseResponse = await fetch(`${server.url}/api/runs/${started.runId}/pause`, {
          method: "POST"
        });
        expect(pauseResponse.status).toBe(200);
        expect(await pauseResponse.json()).toEqual({
          status: "paused"
        });

        const observer = createSseObserver(`${server.url}/api/runs/${started.runId}/stream`);

        executor.releaseStart();

        await observer.waitForType("pause");

        const pausedRunResponse = await fetch(`${server.url}/api/runs/${started.runId}`);
        expect(pausedRunResponse.status).toBe(200);
        const pausedRun = (await pausedRunResponse.json()) as Transcript;
        expect(pausedRun.messages).toHaveLength(0);
        expect(pausedRun.status).toBe("running");

        const resumeResponse = await fetch(`${server.url}/api/runs/${started.runId}/resume`, {
          method: "POST"
        });
        expect(resumeResponse.status).toBe(200);
        expect(await resumeResponse.json()).toEqual({
          status: "resumed"
        });

        const events = await observer.done;
        expect(events.map((event) => event.type)).toContain("pause");
        expect(events.map((event) => event.type)).toContain("resume");
        expect(events.at(-1)?.type).toBe("complete");
      } finally {
        await server.stop();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("interrupts a paused run, emits lifecycle SSE events, and warns when targeted injections are dropped", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-server-api-interrupt-"));
    const runsDir = join(cwd, "runs");
    await mkdir(runsDir, { recursive: true });
    const executor = createOrchestratedExecutor(new RecordingGeminiProvider());
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const server = await startApiServer({
        cwd,
        port: 0,
        runExecutor: executor.runExecutor,
        heartbeatIntervalMs: 5
      });

      try {
        const startResponse = await fetch(`${server.url}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            adapterId: "general-debate",
            topic: "Interrupt topic"
          })
        });

        expect(startResponse.status).toBe(202);
        const started = (await startResponse.json()) as { runId: string };

        const injectResponse = await fetch(`${server.url}/api/runs/${started.runId}/inject`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content: "Hold for the challenge phase.",
            targetPhaseId: "challenge"
          })
        });
        expect(injectResponse.status).toBe(200);
        const queuedInjection = (await injectResponse.json()) as { injectionId: string };

        const pauseResponse = await fetch(`${server.url}/api/runs/${started.runId}/pause`, {
          method: "POST"
        });
        expect(pauseResponse.status).toBe(200);

        const observer = createSseObserver(`${server.url}/api/runs/${started.runId}/stream`);

        executor.releaseStart();
        await observer.waitForType("pause");

        const interruptResponse = await fetch(`${server.url}/api/runs/${started.runId}/interrupt`, {
          method: "POST"
        });
        expect(interruptResponse.status).toBe(200);
        expect(await interruptResponse.json()).toEqual({
          status: "interrupting",
          resumedFromPause: true
        });

        const events = await observer.done;
        expect(events.map((event) => event.type)).toEqual([
          "pause",
          "resume",
          "interrupt",
          "synthesis",
          "complete"
        ]);

        const completedRunResponse = await fetch(`${server.url}/api/runs/${started.runId}`);
        expect(completedRunResponse.status).toBe(200);
        const completedRun = (await completedRunResponse.json()) as Transcript;
        expect(completedRun.messages.every((message) => message.kind !== "agent_turn")).toBe(true);
        expect(completedRun.messages.at(-1)?.kind).toBe("synthesis");

        expect(warnSpy).toHaveBeenCalled();
        const warningText = warnSpy.mock.calls
          .flat()
          .map((value) => String(value))
          .join(" ");
        expect(warningText).toContain(queuedInjection.injectionId);
        expect(warningText).toContain("challenge");
      } finally {
        await server.stop();
      }
    } finally {
      warnSpy.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("streams replayed and live messages, then serves completed metrics and replay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "maf-server-api-stream-"));
    const runsDir = join(cwd, "runs");
    await mkdir(runsDir, { recursive: true });
    const executor = createControlledExecutor(runsDir);

    try {
      const server = await startApiServer({
        cwd,
        port: 0,
        runExecutor: executor.runExecutor,
        heartbeatIntervalMs: 5
      });

      try {
        const startResponse = await fetch(`${server.url}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            adapterId: "general-debate",
            topic: "Streaming topic"
          })
        });

        expect(startResponse.status).toBe(202);
        const started = (await startResponse.json()) as { runId: string };

        await executor.firstMessageReady;

        const liveStreamResponse = await fetch(`${server.url}/api/runs/${started.runId}/stream`);
        expect(liveStreamResponse.status).toBe(200);
        executor.release();
        const liveEvents = parseSsePayload(await liveStreamResponse.text());

        expect(liveEvents.map((event) => event.type)).toEqual(["turn", "synthesis", "complete"]);

        const metricsResponse = await fetch(`${server.url}/api/runs/${started.runId}/metrics`);
        expect(metricsResponse.status).toBe(200);
        const metrics = (await metricsResponse.json()) as Array<Record<string, number | string>>;
        expect(metrics).toEqual([
          {
            agentId: "advocate",
            turns: 1,
            totalTokens: 25,
            avgLatencyMs: 900
          },
          {
            agentId: "synthesiser",
            turns: 1,
            totalTokens: 50,
            avgLatencyMs: 1500
          }
        ]);

        const replayStreamResponse = await fetch(`${server.url}/api/runs/${started.runId}/stream`);
        expect(replayStreamResponse.status).toBe(200);
        const replayEvents = parseSsePayload(await replayStreamResponse.text());
        expect(replayEvents.map((event) => event.type)).toEqual(["turn", "synthesis", "complete"]);

        const completedRunResponse = await fetch(`${server.url}/api/runs/${started.runId}`);
        expect(completedRunResponse.status).toBe(200);
        const completedRun = (await completedRunResponse.json()) as Transcript;
        expect(completedRun.status).toBe("completed");
        expect(completedRun.messages).toHaveLength(2);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
