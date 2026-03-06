import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  AdapterLoadError,
  listBuiltinAdapterIds,
  loadDomainAdapter
} from "../../src/adapters/adapter-loader";

function fixturePath(name: string): string {
  return resolve(import.meta.dir, "..", "fixtures", "adapters", name);
}

function rootPath(name: string): string {
  return resolve(import.meta.dir, "..", "..", name);
}

async function expectLoadError(source: string, code: AdapterLoadError["code"]): Promise<void> {
  try {
    await loadDomainAdapter(source);
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterLoadError);
    expect((error as AdapterLoadError).code).toBe(code);
    return;
  }

  throw new Error(`Expected loadDomainAdapter to throw ${code} for source ${source}`);
}

describe("loadDomainAdapter", () => {
  test("loads a built-in adapter by id", async () => {
    const adapter = await loadDomainAdapter("general-debate");

    expect(adapter.id).toBe("general-debate");
    expect(adapter.agents).toHaveLength(3);
  });

  test("lists built-in ids", () => {
    expect(listBuiltinAdapterIds()).toEqual([
      "ableton-feedback",
      "creative-writing",
      "general-debate"
    ]);
  });

  test("loads adapter from JSON file", async () => {
    const adapter = await loadDomainAdapter(fixturePath("valid-adapter.json"));

    expect(adapter.id).toBe("fixture-json");
    expect(adapter.synthesisAgentId).toBe("synth");
  });

  test("loads adapter from TypeScript module file", async () => {
    const adapter = await loadDomainAdapter(fixturePath("valid-adapter.ts"));

    expect(adapter.id).toBe("fixture-ts");
    expect(adapter.agents).toHaveLength(2);
  });

  test("surfaces clear error for unknown built-in id", async () => {
    await expectLoadError("not-a-real-builtin", "BUILTIN_NOT_FOUND");
  });

  test("surfaces clear error for missing files", async () => {
    await expectLoadError(fixturePath("does-not-exist.json"), "FILE_NOT_FOUND");
  });

  test("surfaces clear error for unsupported file type", async () => {
    await expectLoadError(rootPath("README.md"), "UNSUPPORTED_FILE_TYPE");
  });

  test("surfaces clear error for bad module exports", async () => {
    await expectLoadError(fixturePath("missing-default-export.ts"), "BAD_MODULE_EXPORT");
  });

  test("surfaces clear error for schema-invalid adapter shape", async () => {
    await expectLoadError(fixturePath("invalid-adapter.json"), "SCHEMA_VALIDATION_FAILED");
  });

  test("surfaces clear error for semantically invalid adapter shape", async () => {
    await expectLoadError(fixturePath("semantic-invalid-adapter.json"), "VALIDATION_FAILED");
  });
});
