import type { Agent } from "../types/agent";
import type { ProviderId } from "../types/provider";
import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "./provider-client";

export interface RegisterProviderOptions {
  replace?: boolean;
}

export class ProviderRegistryError extends Error {}

export class UnknownProviderError extends ProviderRegistryError {
  constructor(providerId: ProviderId) {
    super(`Provider "${providerId}" is not registered.`);
    this.name = "UnknownProviderError";
  }
}

export class DuplicateProviderError extends ProviderRegistryError {
  constructor(providerId: ProviderId) {
    super(`Provider "${providerId}" is already registered.`);
    this.name = "DuplicateProviderError";
  }
}

export class MissingAgentProviderError extends ProviderRegistryError {
  constructor(agentId: string) {
    super(`Agent "${agentId}" does not define an llm provider.`);
    this.name = "MissingAgentProviderError";
  }
}

export class ProviderRegistry {
  private readonly clients = new Map<ProviderId, ProviderClient>();

  constructor(initialProviders: ProviderClient[] = []) {
    this.registerMany(initialProviders, { replace: true });
  }

  register(provider: ProviderClient, options: RegisterProviderOptions = {}): void {
    if (this.clients.has(provider.id) && !options.replace) {
      throw new DuplicateProviderError(provider.id);
    }

    this.clients.set(provider.id, provider);
  }

  registerMany(providers: ProviderClient[], options: RegisterProviderOptions = {}): void {
    for (const provider of providers) {
      this.register(provider, options);
    }
  }

  has(providerId: ProviderId): boolean {
    return this.clients.has(providerId);
  }

  get(providerId: ProviderId): ProviderClient {
    const provider = this.clients.get(providerId);
    if (!provider) {
      throw new UnknownProviderError(providerId);
    }
    return provider;
  }

  list(): ProviderId[] {
    return [...this.clients.keys()];
  }

  resolveForAgent(agent: Agent): ProviderClient {
    const providerId = agent.llm?.provider;
    if (!providerId) {
      throw new MissingAgentProviderError(agent.id);
    }
    return this.get(providerId);
  }

  async generate(providerId: ProviderId, request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    const provider = this.get(providerId);
    return provider.generate(request);
  }

  async generateForAgent(
    agent: Agent,
    request: Omit<ProviderGenerateRequest, "agent">
  ): Promise<ProviderGenerateResult> {
    const provider = this.resolveForAgent(agent);
    return provider.generate({ ...request, agent });
  }
}
