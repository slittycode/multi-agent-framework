import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { DomainAdapter } from "../types";
import { validateDomainAdapterSchema } from "../config/schema-validator";
import abletonFeedback from "./builtins/ableton-feedback";
import creativeWriting from "./builtins/creative-writing";
import generalDebate from "./builtins/general-debate";
import { validateDomainAdapter, type AdapterValidationError } from "./adapter-validator";

const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

export type AdapterLoadErrorCode =
  | "BUILTIN_NOT_FOUND"
  | "FILE_NOT_FOUND"
  | "UNSUPPORTED_FILE_TYPE"
  | "MODULE_IMPORT_FAILED"
  | "BAD_MODULE_EXPORT"
  | "JSON_PARSE_FAILED"
  | "SCHEMA_VALIDATION_FAILED"
  | "VALIDATION_FAILED";

export class AdapterLoadError extends Error {
  readonly code: AdapterLoadErrorCode;
  readonly details?: unknown;

  constructor(code: AdapterLoadErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AdapterLoadError";
    this.code = code;
    this.details = details;
  }
}

export interface LoadDomainAdapterOptions {
  cwd?: string;
}

export const BUILTIN_ADAPTERS: Record<string, DomainAdapter> = {
  "general-debate": generalDebate,
  "creative-writing": creativeWriting,
  "ableton-feedback": abletonFeedback
};

export function listBuiltinAdapterIds(): string[] {
  return Object.keys(BUILTIN_ADAPTERS).sort();
}

function isLikelyPath(source: string): boolean {
  return (
    source.startsWith(".") ||
    source.startsWith("/") ||
    source.startsWith("~") ||
    source.includes("/") ||
    extname(source).length > 0
  );
}

function validateOrThrow(candidate: unknown, context: string): DomainAdapter {
  const schemaResult = validateDomainAdapterSchema(candidate);
  if (!schemaResult.valid) {
    throw new AdapterLoadError(
      "SCHEMA_VALIDATION_FAILED",
      `Adapter schema validation failed for ${context}.`,
      { errors: schemaResult.errors }
    );
  }

  const result = validateDomainAdapter(candidate);
  if (!result.valid) {
    throw new AdapterLoadError(
      "VALIDATION_FAILED",
      `Adapter validation failed for ${context}.`,
      { errors: result.errors }
    );
  }

  return candidate as DomainAdapter;
}

async function loadAdapterFromJsonFile(filePath: string): Promise<DomainAdapter> {
  const contents = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new AdapterLoadError(
      "JSON_PARSE_FAILED",
      `Unable to parse JSON adapter file: ${filePath}.`,
      { filePath, cause: error }
    );
  }

  return validateOrThrow(parsed, `JSON file "${filePath}"`);
}

async function loadAdapterFromModuleFile(filePath: string): Promise<DomainAdapter> {
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(filePath).href);
  } catch (error) {
    throw new AdapterLoadError(
      "MODULE_IMPORT_FAILED",
      `Unable to import adapter module: ${filePath}.`,
      { filePath, cause: error }
    );
  }

  if (
    typeof imported !== "object" ||
    imported === null ||
    !("default" in imported)
  ) {
    throw new AdapterLoadError(
      "BAD_MODULE_EXPORT",
      `Adapter module "${filePath}" must have a default export.`,
      { filePath }
    );
  }

  const candidate = (imported as { default: unknown }).default;
  return validateOrThrow(candidate, `module "${filePath}" default export`);
}

function resolveSourcePath(source: string, cwd: string): string {
  if (isAbsolute(source)) {
    return source;
  }
  return resolve(cwd, source);
}

function throwBuiltinNotFound(source: string): never {
  throw new AdapterLoadError(
    "BUILTIN_NOT_FOUND",
    `Unknown built-in adapter "${source}". Available: ${listBuiltinAdapterIds().join(", ")}.`,
    { source, available: listBuiltinAdapterIds() }
  );
}

export async function loadDomainAdapter(
  source: string,
  options: LoadDomainAdapterOptions = {}
): Promise<DomainAdapter> {
  if (!isLikelyPath(source)) {
    const builtin = BUILTIN_ADAPTERS[source];
    if (!builtin) {
      throwBuiltinNotFound(source);
    }
    return validateOrThrow(builtin, `built-in "${source}"`);
  }

  const cwd = options.cwd ?? process.cwd();
  const sourcePath = resolveSourcePath(source, cwd);

  if (!existsSync(sourcePath)) {
    throw new AdapterLoadError(
      "FILE_NOT_FOUND",
      `Adapter source file not found: ${sourcePath}.`,
      { source, sourcePath }
    );
  }

  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".json") {
    return loadAdapterFromJsonFile(sourcePath);
  }

  if (MODULE_EXTENSIONS.has(extension)) {
    return loadAdapterFromModuleFile(sourcePath);
  }

  throw new AdapterLoadError(
    "UNSUPPORTED_FILE_TYPE",
    `Unsupported adapter source extension "${extension}" for file ${sourcePath}.`,
    { sourcePath, extension }
  );
}

export function formatAdapterValidationErrors(errors: AdapterValidationError[]): string {
  if (errors.length === 0) {
    return "";
  }

  return errors.map((error) => `${error.path} (${error.code}): ${error.message}`).join("\n");
}
