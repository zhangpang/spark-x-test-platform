import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export const testCaseSchemaVersion = "1.0" as const;
export const testCaseSchemaId = "https://schemas.spark-x.test/test-case/v1.json" as const;

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

function loadSchema(): object {
  const schemaUrl = new URL("../../../schemas/test-case.schema.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(schemaUrl), "utf8")) as object;
}

let validator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (validator === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    ajv.addFormat(
      "uuid",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    validator = ajv.compile(loadSchema());
  }
  return validator;
}

export function validateTestCaseDefinition(value: unknown): SchemaValidationResult {
  const validate = getValidator();
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : [...(validate.errors ?? [])],
  };
}
