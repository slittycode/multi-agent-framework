import { describe, expect, test } from "bun:test";

import type { AvailableConnector } from "../../src/connectors/types";
import { formatConnectorListResponse } from "../../src/server/connectors-response";

describe("server/connectors-response", () => {
  test("formats connector rows in the same shape as the CLI list view", () => {
    const connectors: AvailableConnector[] = [
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
          freshUntil: "2026-03-14T10:00:00.000Z",
          manifestPath: "/tmp/openai-main.manifest.json",
          layers: {
            auth: { status: "passed" },
            provider: { status: "passed" },
            run: { status: "passed" },
            benchmark: { status: "passed" }
          }
        },
        runtimeStatus: "ready",
        trackedIssueUrl: "https://example.test/tracking",
        providerNote: "Uses the Codex app server flow.",
        ephemeral: false
      }
    ];

    const formatted = formatConnectorListResponse({
      activeConnectorId: "openai-main",
      connectors
    });

    expect(formatted).toEqual([
      {
        id: "openai-main",
        active: true,
        providerId: "openai",
        authMethod: "chatgpt-oauth",
        credentialSource: "codex-app-server",
        ephemeral: false,
        defaultModel: "gpt-5",
        runtimeStatus: "ready",
        certificationStatus: "passed",
        certificationProfile: "full",
        trackedIssueUrl: "https://example.test/tracking",
        providerNote: "Uses the Codex app server flow."
      }
    ]);
  });
});
