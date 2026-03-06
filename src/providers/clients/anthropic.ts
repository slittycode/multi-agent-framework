import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "../provider-client";

export class AnthropicProviderClient implements ProviderClient {
  readonly id = "claude" as const;

  async generate(_request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    throw new Error(
      "AnthropicProviderClient is not implemented in Step 3. Register MockProvider for deterministic test runs."
    );
  }
}
