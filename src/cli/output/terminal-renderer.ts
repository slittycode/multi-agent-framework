import type { Message, RunContext, SynthesisOutput } from "../../types";
import type { ActionabilityEvaluation } from "../../core/actionability";
import type { AvailableConnector } from "../../connectors/types";
import type { ProviderMode, ProviderSupportDescriptor } from "../../providers/provider-bootstrap";

import {
  formatMessage,
  formatRunHeader,
  formatRunSummary,
  formatSynthesisOutput,
  formatSynthesisUnavailableNotice
} from "./formatters";

export interface TerminalRendererOptions {
  showTimestamps?: boolean;
  showUsage?: boolean;
}

export class TerminalRenderer {
  private readonly options: TerminalRendererOptions;

  constructor(options: TerminalRendererOptions = {}) {
    this.options = options;
  }

  renderHeader(input: {
    runId: string;
    adapterName: string;
    topic: string;
    requestedExecutionMode: ProviderMode;
    resolvedExecutionMode: "mock" | "live";
    evaluationTier: string;
    providerSupport: ProviderSupportDescriptor[];
    connector?: AvailableConnector;
    activeConnectorId?: string;
  }): void {
    console.log(formatRunHeader(input));
  }

  renderMessage(message: Message): void {
    console.log(
      formatMessage(message, {
        showTimestamps: this.options.showTimestamps,
        showUsage: this.options.showUsage
      })
    );
  }

  renderSummary(
    context: RunContext,
    persistedPath?: string,
    actionability?: ActionabilityEvaluation
  ): void {
    console.log(formatRunSummary({ context, persistedPath, actionability }));
  }

  renderSynthesis(synthesis?: SynthesisOutput): void {
    if (!synthesis) {
      console.log(formatSynthesisUnavailableNotice());
      return;
    }

    console.log(formatSynthesisOutput(synthesis));
  }

  renderError(error: unknown): void {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      return;
    }

    console.error("Error: unknown failure.");
  }
}
