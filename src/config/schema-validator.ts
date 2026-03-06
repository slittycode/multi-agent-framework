import { readFileSync } from "node:fs";

import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";

export interface SchemaValidationIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationIssue[];
}

function loadSchema(relativePath: string): AnySchema {
  const schemaPath = new URL(relativePath, import.meta.url);
  const contents = readFileSync(schemaPath, "utf8");
  return JSON.parse(contents) as AnySchema;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});

const domainAdapterSchema = loadSchema("./schemas/domain-adapter.schema.json");
const orchestratorConfigSchema = loadSchema("./schemas/orchestrator-config.schema.json");

const domainAdapterValidator = ajv.compile(domainAdapterSchema);
const orchestratorConfigValidator = ajv.compile(orchestratorConfigSchema);

function normalizeSchemaErrors(errors: ErrorObject[] | null | undefined): SchemaValidationIssue[] {
  if (!errors || errors.length === 0) {
    return [];
  }

  return errors.map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "Schema validation error.",
    params: error.params as Record<string, unknown>
  }));
}

function validateWith(
  validator: ValidateFunction<unknown>,
  candidate: unknown
): SchemaValidationResult {
  const valid = validator(candidate);

  return {
    valid,
    errors: valid ? [] : normalizeSchemaErrors(validator.errors)
  };
}

export function validateDomainAdapterSchema(candidate: unknown): SchemaValidationResult {
  return validateWith(domainAdapterValidator, candidate);
}

export function validateOrchestratorConfigSchema(candidate: unknown): SchemaValidationResult {
  return validateWith(orchestratorConfigValidator, candidate);
}
