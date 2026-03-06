export interface RetrievedWebSource {
  title: string;
  url: string;
  snippet?: string;
}

export interface RetrieveWebEvidenceInput {
  topic: string;
  roundName: string;
  phaseName: string;
  agentName: string;
  maxSources: number;
}

export interface RetrieveWebEvidenceResult {
  sources: RetrievedWebSource[];
  warning?: string;
}

export interface RetrieverClient {
  retrieve(input: RetrieveWebEvidenceInput): Promise<RetrieveWebEvidenceResult>;
}

export class NoopRetriever implements RetrieverClient {
  async retrieve(_input: RetrieveWebEvidenceInput): Promise<RetrieveWebEvidenceResult> {
    return {
      sources: [],
      warning:
        "Web retrieval is unavailable in this run; continuing with transcript-only citations."
    };
  }
}

export interface WebRetrieverOptions {
  fetcher?: (input: RetrieveWebEvidenceInput) => Promise<RetrieveWebEvidenceResult>;
}

export class WebRetriever implements RetrieverClient {
  private readonly fetcher?: (input: RetrieveWebEvidenceInput) => Promise<RetrieveWebEvidenceResult>;

  constructor(options: WebRetrieverOptions = {}) {
    this.fetcher = options.fetcher;
  }

  async retrieve(input: RetrieveWebEvidenceInput): Promise<RetrieveWebEvidenceResult> {
    if (this.fetcher) {
      return this.fetcher(input);
    }

    return {
      sources: [],
      warning: "WebRetriever is configured without an active fetcher."
    };
  }
}
