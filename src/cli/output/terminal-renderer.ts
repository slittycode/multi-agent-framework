import type { Message, RunContext, SynthesisOutput } from "../../types";

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

  renderHeader(input: { runId: string; adapterName: string; topic: string }): void {
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

  renderSummary(context: RunContext, persistedPath?: string): void {
    console.log(formatRunSummary({ context, persistedPath }));
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
