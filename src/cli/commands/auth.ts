import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  persistCertificationManifest,
  runAuthSmokeCheck,
  runProviderSmokeCheck,
  runRunProbeCheck,
  updateConnectorCertification
} from "../../connectors/auth-certifier";
import { loadConnectorCatalog, saveConnectorCatalog } from "../../connectors/catalog";
import { createCredentialStore } from "../../connectors/credential-store";
import {
  BENCHMARK_CERTIFICATION_TTL_MS,
  evaluateConnectorExecutionReadiness,
  normalizeLiveCertification
} from "../../connectors/live-certification";
import { listAvailableConnectors, resolveConnectorById } from "../../connectors/connector-resolution";
import {
  isConnectorBlocked,
  type ConnectorCatalog,
  type ConnectorCertificationLayerRecord,
  type ConnectorRecord
} from "../../connectors/types";
import { CodexAppServerClient } from "../../providers/clients/codex-app-server";
import { describeProviderSupport, getDefaultModelForProvider } from "../../providers/provider-support";
import { runBenchmarkSuite } from "./benchmark";

type AuthSubcommand = "login" | "status" | "logout" | "certify";
type AuthCertifyProfile = "smoke" | "full";

interface AuthLoginOptions {
  provider?: string;
  method?: string;
  connectorId?: string;
  model?: string;
  use: boolean;
  noCertify: boolean;
  outputDir?: string;
  baseURL?: string;
}

interface AuthCommandOptions {
  subcommand?: AuthSubcommand;
  login: AuthLoginOptions;
  connectorId?: string;
  outputDir?: string;
  profile: AuthCertifyProfile;
}

function getAuthUsage(): string {
  return [
    "Usage:",
    "  auth login --provider gemini|kimi|openai --method api-key|chatgpt-oauth [--connector-id <id>] [--model <model>] [--use] [--no-certify]",
    "  auth status [--connector <id>]",
    "  auth logout [--connector <id>]",
    "  auth certify [--connector <id>] [--profile smoke|full] [--output-dir <dir>]"
  ].join("\n");
}

function parseAuthOptions(args: string[]): AuthCommandOptions {
  const options: AuthCommandOptions = {
    login: {
      use: false,
      noCertify: false
    },
    profile: "full"
  };

  const [subcommand, ...rest] = args;
  if (subcommand === "login" || subcommand === "status" || subcommand === "logout" || subcommand === "certify") {
    options.subcommand = subcommand;
  }

  const tokens = subcommand ? rest : args;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    switch (token) {
      case "--provider": {
        options.login.provider = tokens[index + 1];
        index += 1;
        break;
      }
      case "--method": {
        options.login.method = tokens[index + 1];
        index += 1;
        break;
      }
      case "--connector-id": {
        options.login.connectorId = tokens[index + 1];
        index += 1;
        break;
      }
      case "--connector": {
        options.connectorId = tokens[index + 1];
        index += 1;
        break;
      }
      case "--model": {
        options.login.model = tokens[index + 1];
        index += 1;
        break;
      }
      case "--output-dir": {
        const value = tokens[index + 1];
        options.outputDir = value;
        options.login.outputDir = value;
        index += 1;
        break;
      }
      case "--profile": {
        const value = tokens[index + 1];
        if (value !== "smoke" && value !== "full") {
          throw new Error(`Invalid --profile value: ${value}. Expected smoke|full.`);
        }
        options.profile = value;
        index += 1;
        break;
      }
      case "--use": {
        options.login.use = true;
        break;
      }
      case "--no-certify": {
        options.login.noCertify = true;
        break;
      }
      case "--base-url": {
        options.login.baseURL = tokens[index + 1];
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function upsertConnector(catalog: ConnectorCatalog, connector: ConnectorRecord): ConnectorCatalog {
  const remaining = catalog.connectors.filter((candidate) => candidate.id !== connector.id);
  return {
    ...catalog,
    connectors: [...remaining, connector].sort((left, right) => left.id.localeCompare(right.id))
  };
}

function addMs(timestamp: string, durationMs: number): string {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function buildBenchmarkLayerRecord(
  outputPath: string,
  report: { generatedAt: string },
  exitCode: number
): ConnectorCertificationLayerRecord {
  const passed = exitCode === 0;
  return {
    status: passed ? "passed" : "failed",
    checkedAt: report.generatedAt,
    freshUntil: addMs(report.generatedAt, BENCHMARK_CERTIFICATION_TTL_MS),
    artifactPath: outputPath,
    ...(passed ? {} : { message: "Live benchmark certification thresholds were not met." })
  };
}

async function promptForApiKey(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return (await rl.question("API key: ")).trim();
  } finally {
    rl.close();
  }
}

async function getCredentialAvailability(connector: ConnectorRecord): Promise<boolean> {
  const credentialStore = createCredentialStore(process.env as Record<string, string | undefined>);

  if (connector.credentialSource === "codex-app-server") {
    const appServer = new CodexAppServerClient({
      env: process.env as Record<string, string | undefined>
    });
    try {
      const account = await appServer.getAccount({ refresh: true });
      if (account.account?.type === "chatgpt" && account.account.email) {
        console.log(
          `ChatGPT account: ${account.account.email}${
            account.account.planType ? ` (${account.account.planType})` : ""
          }`
        );
      }
      return account.account?.type === "chatgpt";
    } finally {
      await appServer.disconnect();
    }
  }

  if (connector.credentialSource === "env") {
    return Boolean((process.env as Record<string, string | undefined>)[connector.credentialRef]?.trim());
  }

  return Boolean(await credentialStore.get(connector.credentialRef));
}

function printFullCertificationReminder(connectorId: string): void {
  console.log("Full certification required before live runs.");
  console.log(`Next: bun run start -- auth certify --profile full --connector ${connectorId}`);
}

async function runLoginAuthCheck(input: {
  connector: ConnectorRecord;
  env: Record<string, string | undefined>;
  outputDir?: string;
}): Promise<{
  updatedConnector: ConnectorRecord;
  artifactPath: string;
  passed: boolean;
}> {
  const authResult = await runAuthSmokeCheck({
    connector: {
      ...input.connector,
      ephemeral: false
    },
    env: input.env,
    outputDir: input.outputDir
  });
  const generatedAt = new Date().toISOString();
  const updatedConnector = updateConnectorCertification({
    connector: input.connector,
    profile: "auth",
    generatedAt,
    layerUpdates: {
      auth: authResult.layer
    }
  });

  return {
    updatedConnector,
    artifactPath: authResult.artifactPath,
    passed: authResult.artifact.passed
  };
}

async function handleAuthLogin(options: AuthLoginOptions): Promise<number> {
  if (!options.provider || !["gemini", "kimi", "openai"].includes(options.provider)) {
    throw new Error("auth login requires --provider gemini|kimi|openai");
  }
  const support = describeProviderSupport(options.provider);
  const method = options.method?.trim();
  if (!method || !support.declaredAuthMethods.includes(method)) {
    throw new Error(
      `auth login requires --method ${support.declaredAuthMethods.join("|")} for provider ${options.provider}.`
    );
  }

  const connectorId =
    options.connectorId?.trim() ||
    (method === "chatgpt-oauth" ? `${options.provider}-oauth` : `${options.provider}-main`);
  if (connectorId.endsWith("-env")) {
    throw new Error('Connector ids ending in "-env" are reserved for ephemeral environment connectors.');
  }

  if (method === "chatgpt-oauth") {
    if (options.provider !== "openai") {
      throw new Error(`auth login --method chatgpt-oauth is only supported for provider openai.`);
    }

    const appServer = new CodexAppServerClient({
      env: process.env as Record<string, string | undefined>
    });

    try {
      const initialAccount = await appServer.getAccount({ refresh: true });
      if (!initialAccount.account || initialAccount.account.type !== "chatgpt") {
        const login = await appServer.loginWithChatGpt();
        console.log(`ChatGPT login URL: ${login.authUrl}`);
        if (!login.browserOpened) {
          console.log("Browser auto-open was skipped; open the login URL manually if needed.");
        }
      }

      const confirmedAccount = await appServer.getAccount({ refresh: true });
      if (!confirmedAccount.account || confirmedAccount.account.type !== "chatgpt") {
        throw new Error("OpenAI ChatGPT OAuth login did not produce an authenticated ChatGPT account.");
      }

      const resolvedModel = options.model?.trim() || (await appServer.getDefaultModel()).model;

      const catalog = await loadConnectorCatalog();
      const connector: ConnectorRecord = {
        id: connectorId,
        providerId: options.provider,
        authMethod: "chatgpt-oauth",
        defaultModel: resolvedModel,
        credentialSource: "codex-app-server",
        credentialRef: "openai-chatgpt",
        lastCertificationStatus: "never",
        runtimeStatus: "ready",
        ...(support.providerNote ? { providerNote: support.providerNote } : {})
      };

      let updatedCatalog = upsertConnector(catalog, connector);
      if (options.use) {
        updatedCatalog = {
          ...updatedCatalog,
          activeConnectorId: connectorId
        };
      }

      await saveConnectorCatalog(updatedCatalog);

      console.log(`Stored connector: ${connectorId}`);
      console.log(`Provider: ${options.provider}`);
      console.log(`Auth method: ${method}`);
      console.log(`Default model: ${connector.defaultModel}`);
      if (confirmedAccount.account.email) {
        console.log(
          `ChatGPT account: ${confirmedAccount.account.email}${
            confirmedAccount.account.planType ? ` (${confirmedAccount.account.planType})` : ""
          }`
        );
      }

      if (options.noCertify) {
        return 0;
      }

      const authCheck = await runLoginAuthCheck({
        connector,
        env: process.env as Record<string, string | undefined>,
        outputDir: options.outputDir
      });
      updatedCatalog = upsertConnector(updatedCatalog, authCheck.updatedConnector);
      await saveConnectorCatalog(updatedCatalog);

      console.log(`Auth check: ${authCheck.passed ? "passed" : "failed"}`);
      console.log(`Auth artifact: ${authCheck.artifactPath}`);
      if (authCheck.passed) {
        printFullCertificationReminder(connectorId);
      }
      return authCheck.passed ? 0 : 1;
    } finally {
      await appServer.disconnect();
    }
  }

  if (method !== "api-key") {
    throw new Error(`auth login --method ${method} is not implemented for provider ${options.provider}.`);
  }

  const apiKey = await promptForApiKey();
  if (!apiKey) {
    throw new Error("API key input was empty.");
  }

  const credentialStore = createCredentialStore(process.env as Record<string, string | undefined>);
  if (!(await credentialStore.isAvailable())) {
    throw new Error(
      "Interactive credential storage is unavailable on this platform. Use env-backed connectors instead."
    );
  }

  await credentialStore.set(connectorId, apiKey);

  const catalog = await loadConnectorCatalog();
  const connector: ConnectorRecord = {
    id: connectorId,
    providerId: options.provider,
    authMethod: "api-key",
    defaultModel: options.model?.trim() || (getDefaultModelForProvider(options.provider) as string),
    credentialSource: "keychain",
    credentialRef: connectorId,
    lastCertificationStatus: "never",
    runtimeStatus: "ready",
    ...(support.providerNote ? { providerNote: support.providerNote } : {}),
    ...(options.provider === "kimi" && options.baseURL?.trim() ? { baseURL: options.baseURL.trim() } : {})
  };

  let updatedCatalog = upsertConnector(catalog, connector);
  if (options.use) {
    updatedCatalog = {
      ...updatedCatalog,
      activeConnectorId: connectorId
    };
  }

  await saveConnectorCatalog(updatedCatalog);

  console.log(`Stored connector: ${connectorId}`);
  console.log(`Provider: ${options.provider}`);
  console.log(`Default model: ${connector.defaultModel}`);

  if (options.noCertify) {
    return 0;
  }

  const resolved = await resolveConnectorById({
    connectorId,
    credentialStore
  });
  const authCheck = await runLoginAuthCheck({
    connector,
    env: {
      ...(process.env as Record<string, string | undefined>),
      ...resolved.envOverlay
    },
    outputDir: options.outputDir
  });
  updatedCatalog = upsertConnector(updatedCatalog, authCheck.updatedConnector);
  await saveConnectorCatalog(updatedCatalog);

  console.log(`Auth check: ${authCheck.passed ? "passed" : "failed"}`);
  console.log(`Auth artifact: ${authCheck.artifactPath}`);
  if (authCheck.passed) {
    printFullCertificationReminder(connectorId);
  }
  return authCheck.passed ? 0 : 1;
}

async function handleAuthStatus(connectorId?: string): Promise<number> {
  const available = await listAvailableConnectors({
    env: process.env as Record<string, string | undefined>
  });
  const resolvedConnectorId =
    connectorId?.trim() ||
    available.activeConnectorId ||
    (available.connectors.length === 1 ? available.connectors[0]?.id : undefined);

  if (!resolvedConnectorId) {
    console.log("No connector is selected.");
    return 1;
  }

  const connector = available.connectors.find((candidate) => candidate.id === resolvedConnectorId);
  if (!connector) {
    throw new Error(`Connector "${resolvedConnectorId}" is not available.`);
  }

  console.log(`Connector: ${connector.id}`);
  console.log(`Provider: ${connector.providerId}`);
  console.log(`Auth method: ${connector.authMethod}`);
  console.log(`Runtime status: ${connector.runtimeStatus}`);
  if (connector.runtimeStatusReason) {
    console.log(`Runtime reason: ${connector.runtimeStatusReason}`);
  }
  if (connector.trackedIssueUrl) {
    console.log(`Tracking: ${connector.trackedIssueUrl}`);
  }
  if (connector.providerNote) {
    console.log(`Provider note: ${connector.providerNote}`);
  }
  console.log(`Default model: ${connector.defaultModel}`);

  if (isConnectorBlocked(connector)) {
    return 1;
  }

  const credentialAvailable = await getCredentialAvailability(connector);
  const liveCertification = normalizeLiveCertification(connector.liveCertification);
  const readiness = evaluateConnectorExecutionReadiness({
    id: connector.id,
    runtimeStatus: connector.runtimeStatus,
    runtimeStatusReason: connector.runtimeStatusReason,
    liveCertification
  });

  console.log(`Credential source: ${connector.credentialSource}`);
  console.log(`Credential available: ${credentialAvailable ? "yes" : "no"}`);
  console.log(
    `Certification readiness: ${readiness.overallStatus}${
      connector.lastCertifiedAt ? ` at ${connector.lastCertifiedAt}` : ""
    }`
  );
  if (liveCertification.latestProfile) {
    console.log(`Latest certification profile: ${liveCertification.latestProfile}`);
  }
  if (liveCertification.manifestPath) {
    console.log(`Certification manifest: ${liveCertification.manifestPath}`);
  }
  if (readiness.freshUntil) {
    console.log(`Fresh until: ${readiness.freshUntil}`);
  }
  if (!readiness.runnable) {
    const recommendedProfile = liveCertification.latestProfile === "auth" ? "full" : readiness.requiredProfile ?? "full";
    console.log(
      `Remediation: bun run start -- auth certify --profile ${recommendedProfile} --connector ${connector.id}`
    );
  }
  return credentialAvailable ? 0 : 1;
}

async function handleAuthLogout(connectorId?: string): Promise<number> {
  const catalog = await loadConnectorCatalog();
  const resolvedConnectorId = connectorId?.trim() || catalog.activeConnectorId;
  if (!resolvedConnectorId) {
    throw new Error("auth logout requires --connector when no active connector is set.");
  }

  const connector = catalog.connectors.find((candidate) => candidate.id === resolvedConnectorId);
  if (!connector) {
    throw new Error(`Connector "${resolvedConnectorId}" is not stored in this workspace.`);
  }

  const credentialStore = createCredentialStore(process.env as Record<string, string | undefined>);
  const removedConnectorIds = new Set(
    connector.credentialSource === "codex-app-server"
      ? catalog.connectors
          .filter(
            (candidate) =>
              candidate.providerId === connector.providerId &&
              candidate.credentialSource === "codex-app-server"
          )
          .map((candidate) => candidate.id)
      : [resolvedConnectorId]
  );

  if (connector.credentialSource === "codex-app-server") {
    const appServer = new CodexAppServerClient({
      env: process.env as Record<string, string | undefined>
    });
    try {
      await appServer.logout();
    } finally {
      await appServer.disconnect();
    }
  } else {
    await credentialStore.delete(connector.credentialRef);
  }

  const updatedCatalog: ConnectorCatalog = {
    ...catalog,
    activeConnectorId:
      catalog.activeConnectorId && removedConnectorIds.has(catalog.activeConnectorId)
        ? undefined
        : catalog.activeConnectorId,
    connectors: catalog.connectors.filter((candidate) => !removedConnectorIds.has(candidate.id))
  };
  await saveConnectorCatalog(updatedCatalog);

  console.log(`Removed connector: ${resolvedConnectorId}`);
  return 0;
}

async function handleAuthCertify(
  connectorId?: string,
  outputDir?: string,
  profile: AuthCertifyProfile = "full"
): Promise<number> {
  const credentialStore = createCredentialStore(process.env as Record<string, string | undefined>);
  const available = await listAvailableConnectors({
    env: process.env as Record<string, string | undefined>
  });
  const resolvedConnectorId =
    connectorId?.trim() ||
    available.activeConnectorId ||
    (available.connectors.length === 1 ? available.connectors[0]?.id : undefined);

  if (!resolvedConnectorId) {
    throw new Error("No connector is selected for certification.");
  }

  const selectedConnector = available.connectors.find((candidate) => candidate.id === resolvedConnectorId);
  if (!selectedConnector) {
    throw new Error(`Connector "${resolvedConnectorId}" is not available.`);
  }
  if (selectedConnector.ephemeral) {
    throw new Error(
      `Connector "${selectedConnector.id}" is environment-backed. Store it with auth login before certification.`
    );
  }
  if (isConnectorBlocked(selectedConnector)) {
    throw new Error(
      `Connector "${selectedConnector.id}" cannot be certified because it is blocked (${selectedConnector.runtimeStatusReason}).`
    );
  }

  const resolved = await resolveConnectorById({
    connectorId: resolvedConnectorId,
    credentialStore
  });
  const env = {
    ...(process.env as Record<string, string | undefined>),
    ...resolved.envOverlay
  };
  const outputRoot = outputDir ?? "./runs/auth";
  const catalog = await loadConnectorCatalog();
  const storedConnector = catalog.connectors.find((candidate) => candidate.id === resolved.connector.id);
  if (!storedConnector) {
    throw new Error(`Connector "${resolved.connector.id}" is not stored in this workspace.`);
  }

  const layerUpdates: Partial<Record<"auth" | "provider" | "run" | "benchmark", ConnectorCertificationLayerRecord>> = {};
  let profilePassed = true;

  const authResult = await runAuthSmokeCheck({
    connector: resolved.connector,
    env,
    outputDir: outputRoot
  });
  layerUpdates.auth = authResult.layer;
  profilePassed = authResult.artifact.passed;

  if (profilePassed) {
    const providerResult = await runProviderSmokeCheck({
      connector: resolved.connector,
      env,
      outputDir: outputRoot
    });
    layerUpdates.provider = providerResult.layer;
    profilePassed = providerResult.artifact.passed;

    if (profilePassed) {
      const runResult = await runRunProbeCheck({
        connector: resolved.connector,
        env,
        outputDir: outputRoot
      });
      layerUpdates.run = runResult.layer;
      profilePassed = runResult.artifact.passed;
    }
  }

  if (profile === "full" && profilePassed) {
    const benchmarkResult = await runBenchmarkSuite(
      {
        executionMode: "live",
        connectorId: resolved.connector.id,
        allConnectors: false,
        outputDir: join(outputRoot, "benchmark")
      },
      env
    );
    layerUpdates.benchmark = buildBenchmarkLayerRecord(
      benchmarkResult.outputPath,
      benchmarkResult.report,
      benchmarkResult.exitCode
    );
    profilePassed = benchmarkResult.exitCode === 0;
  }

  const generatedAt = new Date().toISOString();
  const updatedConnector = updateConnectorCertification({
    connector: storedConnector,
    profile,
    generatedAt,
    layerUpdates
  });
  const manifestResult = await persistCertificationManifest({
    connector: resolved.connector,
    profile,
    outputDir: outputRoot,
    profilePassed,
    updatedConnector
  });
  const finalConnector = updateConnectorCertification({
    connector: updatedConnector,
    profile,
    generatedAt,
    manifestPath: manifestResult.manifestPath,
    layerUpdates: {}
  });

  await saveConnectorCatalog(upsertConnector(catalog, finalConnector));

  console.log(`Connector: ${resolved.connector.id}`);
  console.log(`Profile: ${profile}`);
  console.log(`Certification: ${profilePassed ? "passed" : "failed"}`);
  console.log(`Manifest: ${manifestResult.manifestPath}`);

  if (profile === "smoke" && profilePassed) {
    const readiness = evaluateConnectorExecutionReadiness({
      id: finalConnector.id,
      runtimeStatus: finalConnector.runtimeStatus,
      runtimeStatusReason: finalConnector.runtimeStatusReason,
      liveCertification: finalConnector.liveCertification
    });
    if (!readiness.runnable) {
      printFullCertificationReminder(finalConnector.id);
    }
  }

  return profilePassed ? 0 : 1;
}

export async function authCommand(args: string[]): Promise<number> {
  let options: AuthCommandOptions;

  try {
    options = parseAuthOptions(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid auth arguments.");
    console.error(getAuthUsage());
    return 1;
  }

  try {
    switch (options.subcommand) {
      case "login":
        return handleAuthLogin(options.login);
      case "status":
        return handleAuthStatus(options.connectorId);
      case "logout":
        return handleAuthLogout(options.connectorId);
      case "certify":
        return handleAuthCertify(options.connectorId, options.outputDir, options.profile);
      default:
        console.error(getAuthUsage());
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Auth command failed.");
    return 1;
  }
}
