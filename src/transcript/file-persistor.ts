import type { Transcript } from "../types";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { serializeTranscriptToJson, serializeTranscriptToJsonl } from "./transcript-serializer";

export interface PersistTranscriptInput {
  transcript: Transcript;
  outputDir: string;
  format: "json" | "jsonl";
}

export interface PersistTranscriptResult {
  path: string;
}

export async function persistTranscript(
  input: PersistTranscriptInput
): Promise<PersistTranscriptResult> {
  const absoluteOutputDir = resolve(input.outputDir);
  await mkdir(absoluteOutputDir, { recursive: true });

  const fileName = `${input.transcript.runId}.transcript.${input.format}`;
  const path = join(absoluteOutputDir, fileName);

  const payload =
    input.format === "json"
      ? serializeTranscriptToJson(input.transcript)
      : serializeTranscriptToJsonl(input.transcript);

  await writeFile(path, payload, "utf8");

  return { path };
}
