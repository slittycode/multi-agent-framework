import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createLiveProviderClient } from "../providers/provider-bootstrap";
import type { Agent } from "../types";
import type { AvailableConnector } from "./types";

export interface AuthCertificationArtifact {
  generatedAt: string;
  connectorId: string;
  providerId: string;
  model: string;
  credentialSource: string;
  passed: boolean;
  invocationId?: string;
  latencyMs?: number;
  error?: {
    message: string;
    code?: string;
  };
}

export async function certifyConnector(input: {
  connector: AvailableConnector;
  env: Record<string, string | undefined>;
  outputDir?: string;
}): Promise<{
  artifact: AuthCertificationArtifact;
  artifactPath: string;
}> {
  const outputDir = resolve(process.cwd(), input.outputDir ?? "./runs/auth");
  await mkdir(outputDir, { recursive: true });

  const provider = createLiveProviderClient(input.connector.providerId, input.env, input.connector);
  const agent: Agent = {
    id: "auth-certifier",
    name: "Auth Certifier",
    role: "credential-smoke-test",
    persona: "Concise and factual",
    systemPrompt: "Confirm service availability in one short sentence.",
    llm: {
      provider: input.connector.providerId,
      model: input.connector.defaultModel,
      temperature: 0.1
    }
  };

  const generatedAt = new Date().toISOString();

  try {
    const result = await provider.generate({
      runId: `auth-cert-${input.connector.id}`,
      agent,
      systemPrompt: agent.systemPrompt,
      prompt: "Confirm credential validation succeeded in one short sentence.",
      transcript: []
    });

    const artifact: AuthCertificationArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      model: result.model,
      credentialSource: input.connector.credentialSource,
      passed: true,
      invocationId: result.invocationId,
      latencyMs: result.usage?.latencyMs
    };
    const artifactPath = join(outputDir, `${input.connector.id}-${Date.now()}.auth-cert.json`);
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    return { artifact, artifactPath };
  } catch (error) {
    const artifact: AuthCertificationArtifact = {
      generatedAt,
      connectorId: input.connector.id,
      providerId: input.connector.providerId,
      model: input.connector.defaultModel,
      credentialSource: input.connector.credentialSource,
      passed: false,
      error: {
        message: error instanceof Error ? error.message : "Unknown auth certification failure.",
        ...(typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? { code: (error as { code: string }).code }
          : {})
      }
    };
    const artifactPath = join(outputDir, `${input.connector.id}-${Date.now()}.auth-cert.json`);
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    return { artifact, artifactPath };
  }
}
