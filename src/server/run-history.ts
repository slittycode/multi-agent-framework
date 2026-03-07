import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Transcript } from "../types";
import type { ApiRunListEntry } from "./types";

interface JsonlMessageRecord {
  recordType: "message";
  [key: string]: unknown;
}

interface JsonlSummaryRecord {
  recordType: "transcript_summary";
  runId: string;
  adapterId: string;
  topic: string;
  status: Transcript["status"];
  startedAt: string;
  endedAt?: string;
  synthesis?: Transcript["synthesis"];
  metadata?: Record<string, unknown>;
}

const REAL_FILTER_EXACT_TOPICS = new Set(["topic", "test topic", "cli topic"]);
const RUN_STATUSES = new Set<Transcript["status"]>(["running", "completed", "failed"]);

function isTranscriptFileName(fileName: string): boolean {
  return fileName.endsWith(".transcript.json") || fileName.endsWith(".transcript.jsonl");
}

function extractActionabilityScore(metadata: Record<string, unknown> | undefined): number | undefined {
  const qualityGate = metadata?.qualityGate;
  if (typeof qualityGate !== "object" || qualityGate === null) {
    return undefined;
  }

  const score = (qualityGate as { score?: unknown }).score;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

function parseJsonlTranscript(payload: string): Transcript {
  const lines = payload
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const messages: Transcript["messages"] = [];
  let summary: JsonlSummaryRecord | undefined;

  for (const line of lines) {
    const parsed = JSON.parse(line) as JsonlMessageRecord | JsonlSummaryRecord;

    if (parsed.recordType === "message") {
      const { recordType: _recordType, ...message } = parsed;
      messages.push(message as unknown as Transcript["messages"][number]);
      continue;
    }

    if (parsed.recordType === "transcript_summary") {
      summary = parsed;
    }
  }

  if (!summary) {
    throw new Error("Transcript JSONL payload is missing a transcript_summary record.");
  }

  return {
    runId: summary.runId,
    adapterId: summary.adapterId,
    topic: summary.topic,
    status: summary.status,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    messages,
    synthesis: summary.synthesis,
    metadata: summary.metadata
  };
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function parsePersistedTranscriptPayload(
  fileName: string,
  payload: string
): Transcript {
  if (fileName.endsWith(".transcript.json")) {
    return JSON.parse(payload) as Transcript;
  }

  if (fileName.endsWith(".transcript.jsonl")) {
    return parseJsonlTranscript(payload);
  }

  throw new Error(`Unsupported transcript file: ${fileName}`);
}

export function buildRunListEntry(
  transcript: Transcript,
  overrides: Partial<ApiRunListEntry> = {}
): ApiRunListEntry {
  return {
    runId: overrides.runId ?? transcript.runId,
    adapterId: overrides.adapterId ?? transcript.adapterId,
    topic: overrides.topic ?? transcript.topic,
    status: overrides.status ?? transcript.status,
    startedAt: overrides.startedAt ?? transcript.startedAt,
    endedAt: overrides.endedAt ?? transcript.endedAt,
    messageCount: overrides.messageCount ?? transcript.messages.length,
    actionabilityScore:
      overrides.actionabilityScore ?? extractActionabilityScore(transcript.metadata)
  };
}

export function mergeRunListEntries(input: {
  persistedEntries: ApiRunListEntry[];
  activeEntries: ApiRunListEntry[];
}): ApiRunListEntry[] {
  const sortedActiveEntries = [...input.activeEntries].sort(
    (left, right) => timestampValue(right.startedAt) - timestampValue(left.startedAt)
  );
  const activeRunIds = new Set(sortedActiveEntries.map((entry) => entry.runId));
  const sortedPersistedEntries = [...input.persistedEntries]
    .filter((entry) => !activeRunIds.has(entry.runId))
    .sort((left, right) => timestampValue(right.startedAt) - timestampValue(left.startedAt));

  return [...sortedActiveEntries, ...sortedPersistedEntries];
}

function isPlaceholderTopic(topic: string): boolean {
  return REAL_FILTER_EXACT_TOPICS.has(topic.trim().toLowerCase());
}

function isRealRunEntry(entry: ApiRunListEntry): boolean {
  if (entry.messageCount <= 0) {
    return false;
  }
  if (entry.adapterId.startsWith("fixture-")) {
    return false;
  }
  if (isPlaceholderTopic(entry.topic)) {
    return false;
  }

  return true;
}

export function filterRunListEntries(
  entries: readonly ApiRunListEntry[],
  input: {
    filter?: string | null;
    status?: string | null;
  } = {}
): ApiRunListEntry[] {
  let filteredEntries = [...entries];

  if (input.filter === "real") {
    filteredEntries = filteredEntries.filter((entry) => isRealRunEntry(entry));
  }

  if (input.status && RUN_STATUSES.has(input.status as Transcript["status"])) {
    filteredEntries = filteredEntries.filter((entry) => entry.status === input.status);
  }

  return filteredEntries;
}

export async function readPersistedRunEntries(runsDir: string): Promise<ApiRunListEntry[]> {
  let fileNames: string[];
  try {
    fileNames = await readdir(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const transcripts = await Promise.all(
    fileNames
      .filter(isTranscriptFileName)
      .map(async (fileName) => {
        try {
          const payload = await readFile(join(runsDir, fileName), "utf8");
          return parsePersistedTranscriptPayload(fileName, payload);
        } catch {
          return undefined;
        }
      })
  );

  return transcripts
    .filter((transcript): transcript is Transcript => transcript !== undefined)
    .map((transcript) => buildRunListEntry(transcript));
}

export async function readPersistedTranscript(
  runsDir: string,
  runId: string
): Promise<Transcript | undefined> {
  for (const extension of ["json", "jsonl"] as const) {
    const fileName = `${runId}.transcript.${extension}`;

    try {
      const payload = await readFile(join(runsDir, fileName), "utf8");
      return parsePersistedTranscriptPayload(fileName, payload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return undefined;
}
