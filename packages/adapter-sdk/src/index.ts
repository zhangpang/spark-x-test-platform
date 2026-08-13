import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type ActionLevel = "read" | "write" | "dangerous";
export type FailureClassification =
  | "PRODUCT_BEHAVIOR"
  | "TEST_DEFINITION"
  | "ENVIRONMENT_UNAVAILABLE"
  | "INFRASTRUCTURE_FAILURE"
  | "CANCELLED"
  | "TIMEOUT"
  | "CAPABILITY_INCOMPATIBLE"
  | "SECURITY_POLICY_REJECTED";

export interface AdapterManifest {
  readonly manifestVersion: "1.0";
  readonly key: string;
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: "1.0";
  readonly platformRange: string;
  readonly environmentSchema: Readonly<Record<string, unknown>>;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface AdapterManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

export interface AdapterActionResult {
  readonly status: "succeeded" | "failed";
  readonly output?: unknown;
  readonly suggestedClassification?: FailureClassification;
}

function loadSchema(): object {
  const schemaUrl = new URL("../../../schemas/adapter-manifest.schema.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(schemaUrl), "utf8")) as object;
}

let validator: ValidateFunction | undefined;

export function validateAdapterManifest(value: unknown): AdapterManifestValidationResult {
  if (validator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    validator = ajv.compile(loadSchema());
  }
  const validate = validator;
  const valid = validate(value);
  return { valid, errors: valid ? [] : [...(validate.errors ?? [])] };
}
