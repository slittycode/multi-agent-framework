import { describe, expect, test } from "bun:test";

import {
  createEmptyLiveCertification,
  evaluateConnectorExecutionReadiness,
  type ConnectorLiveCertification
} from "../../src/connectors/live-certification";

function buildLiveCertification(): ConnectorLiveCertification {
  return createEmptyLiveCertification();
}

describe("live certification", () => {
  test("marks a connector runnable only when smoke layers and benchmark are fresh", () => {
    const now = new Date("2026-03-07T12:00:00.000Z");
    const liveCertification = buildLiveCertification();

    liveCertification.layers.auth = {
      status: "passed",
      checkedAt: "2026-03-07T11:00:00.000Z",
      freshUntil: "2026-03-08T11:00:00.000Z"
    };
    liveCertification.layers.provider = {
      status: "passed",
      checkedAt: "2026-03-07T11:05:00.000Z",
      freshUntil: "2026-03-08T11:05:00.000Z"
    };
    liveCertification.layers.run = {
      status: "passed",
      checkedAt: "2026-03-07T11:10:00.000Z",
      freshUntil: "2026-03-08T11:10:00.000Z"
    };
    liveCertification.layers.benchmark = {
      status: "passed",
      checkedAt: "2026-03-06T12:00:00.000Z",
      freshUntil: "2026-03-13T12:00:00.000Z"
    };

    const readiness = evaluateConnectorExecutionReadiness(
      {
        id: "openai-main",
        runtimeStatus: "ready",
        liveCertification
      },
      { now }
    );

    expect(readiness.overallStatus).toBe("passed");
    expect(readiness.runnable).toBe(true);
    expect(readiness.requiredProfile).toBeUndefined();
    expect(readiness.freshUntil).toBe("2026-03-08T11:00:00.000Z");
  });

  test("marks the connector stale when the benchmark layer has expired", () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const liveCertification = buildLiveCertification();

    liveCertification.layers.auth = {
      status: "passed",
      checkedAt: "2026-03-15T10:00:00.000Z",
      freshUntil: "2026-03-16T10:00:00.000Z"
    };
    liveCertification.layers.provider = {
      status: "passed",
      checkedAt: "2026-03-15T10:05:00.000Z",
      freshUntil: "2026-03-16T10:05:00.000Z"
    };
    liveCertification.layers.run = {
      status: "passed",
      checkedAt: "2026-03-15T10:10:00.000Z",
      freshUntil: "2026-03-16T10:10:00.000Z"
    };
    liveCertification.layers.benchmark = {
      status: "passed",
      checkedAt: "2026-03-07T12:00:00.000Z",
      freshUntil: "2026-03-14T12:00:00.000Z"
    };

    const readiness = evaluateConnectorExecutionReadiness(
      {
        id: "openai-main",
        runtimeStatus: "ready",
        liveCertification
      },
      { now }
    );

    expect(readiness.overallStatus).toBe("stale");
    expect(readiness.runnable).toBe(false);
    expect(readiness.requiredProfile).toBe("full");
    expect(readiness.reason).toContain("benchmark");
  });

  test("requires a full certification when smoke layers passed but benchmark has never run", () => {
    const now = new Date("2026-03-07T12:00:00.000Z");
    const liveCertification = buildLiveCertification();

    liveCertification.layers.auth = {
      status: "passed",
      checkedAt: "2026-03-07T11:00:00.000Z",
      freshUntil: "2026-03-08T11:00:00.000Z"
    };
    liveCertification.layers.provider = {
      status: "passed",
      checkedAt: "2026-03-07T11:05:00.000Z",
      freshUntil: "2026-03-08T11:05:00.000Z"
    };
    liveCertification.layers.run = {
      status: "passed",
      checkedAt: "2026-03-07T11:10:00.000Z",
      freshUntil: "2026-03-08T11:10:00.000Z"
    };

    const readiness = evaluateConnectorExecutionReadiness(
      {
        id: "openai-main",
        runtimeStatus: "ready",
        liveCertification
      },
      { now }
    );

    expect(readiness.overallStatus).toBe("never");
    expect(readiness.runnable).toBe(false);
    expect(readiness.requiredProfile).toBe("full");
    expect(readiness.reason).toContain("full");
  });
});
