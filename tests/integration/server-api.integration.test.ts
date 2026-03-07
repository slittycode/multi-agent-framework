import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { saveConnectorCatalog } from "../../src/connectors/catalog";
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

describe("integration/server-api", () => {
  test("serves health, CORS, connectors, and phase-two placeholders", async () => {
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

        const injectResponse = await fetch(`${server.url}/api/runs/demo-run/inject`, {
          method: "POST"
        });
        expect(injectResponse.status).toBe(501);

        const interruptResponse = await fetch(`${server.url}/api/runs/demo-run/interrupt`, {
          method: "POST"
        });
        expect(interruptResponse.status).toBe(501);

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
