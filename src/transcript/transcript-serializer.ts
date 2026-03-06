import type { Transcript } from "../types";

interface JsonlMessageRecord {
  recordType: "message";
  [key: string]: unknown;
}

interface JsonlSummaryRecord {
  recordType: "transcript_summary";
  runId: Transcript["runId"];
  adapterId: string;
  topic: string;
  status: Transcript["status"];
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  synthesis?: Transcript["synthesis"];
  metadata?: Record<string, unknown>;
}

export function serializeTranscriptToJson(transcript: Transcript): string {
  return JSON.stringify(transcript, null, 2);
}

export function serializeTranscriptToJsonl(transcript: Transcript): string {
  const lines: string[] = [];

  for (const message of transcript.messages) {
    const record: JsonlMessageRecord = {
      recordType: "message",
      ...message
    };
    lines.push(JSON.stringify(record));
  }

  const summaryRecord: JsonlSummaryRecord = {
    recordType: "transcript_summary",
    runId: transcript.runId,
    adapterId: transcript.adapterId,
    topic: transcript.topic,
    status: transcript.status,
    startedAt: transcript.startedAt,
    endedAt: transcript.endedAt,
    messageCount: transcript.messages.length,
    synthesis: transcript.synthesis,
    metadata: transcript.metadata
  };
  lines.push(JSON.stringify(summaryRecord));

  return `${lines.join("\n")}\n`;
}
