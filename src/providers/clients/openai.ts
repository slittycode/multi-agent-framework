import type { ProviderClient, ProviderGenerateRequest, ProviderGenerateResult } from "../provider-client";

export class OpenAIProviderClient implements ProviderClient {
  readonly id = "openai" as const;

  async generate(_request: ProviderGenerateRequest): Promise<ProviderGenerateResult> {
    throw new Error(
      "OpenAIProviderClient is not implemented in Step 3. Register MockProvider for deterministic test runs."
    );
  }
}
