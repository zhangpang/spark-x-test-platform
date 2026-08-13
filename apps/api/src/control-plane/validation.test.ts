import { describe, expect, it } from "vitest";

import type { EnvironmentRecord, JsonObject } from "./model.js";
import {
  contentHash,
  findPlaintextSecrets,
  redactSecrets,
  validateDefinition,
} from "./validation.js";

function definition(overrides: Readonly<Record<string, unknown>> = {}): JsonObject {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "HTTP health",
      systemKey: "sample-system",
      moduleKey: "order",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      tags: ["http"],
    },
    inputs: [],
    execution: { stepTimeoutMs: 1000, caseTimeoutMs: 5000, diagnosticRetries: 0 },
    resourceLocks: [],
    steps: [
      {
        id: "request",
        name: "read health",
        kind: "action",
        action: "http:request",
        params: { method: "GET", path: "/healthz" },
        assertions: [],
      },
    ],
    finally: [],
    ...overrides,
  } as JsonObject;
}

const environment: EnvironmentRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  systemId: "00000000-0000-4000-8000-000000000002",
  key: "test",
  name: "Test",
  kind: "test",
  baseUrl: "https://example.test/",
  actionLevel: "read",
  allowlist: [{ protocol: "https", host: "example.test", ports: [443], pathPrefixes: ["/"] }],
  timezone: "Asia/Shanghai",
  concurrencyLimit: 5,
  adapterConfig: {},
  status: "active",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("M2 asset validation", () => {
  it("hashes semantically identical JSON deterministically", () => {
    expect(contentHash({ alpha: 1, nested: { second: true, first: "x" } })).toBe(
      contentHash({ nested: { first: "x", second: true }, alpha: 1 }),
    );
  });

  it("rejects plaintext secrets while allowing secret references", () => {
    expect(findPlaintextSecrets({ headers: { authorization: "Bearer real-token-value" } })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PLAINTEXT_SECRET" })]),
    );
    expect(
      findPlaintextSecrets({ headers: { authorization: "Bearer ${case.authToken}" } }),
    ).toEqual([]);
  });

  it("redacts secret-shaped fields and values from structured output", () => {
    expect(
      redactSecrets({
        token: "plain-value",
        nested: { note: "-----BEGIN PRIVATE KEY-----" },
      }),
    ).toEqual({ token: "[REDACTED]", nested: { note: "[REDACTED]" } });
  });

  it("accepts a valid relative HTTP target in an allowlisted environment", () => {
    expect(
      validateDefinition(definition(), {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects arbitrary absolute targets and duplicate step identifiers", () => {
    const invalid = definition({
      steps: [
        {
          id: "request",
          name: "first",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz", url: "https://bypass.test" },
        },
        {
          id: "request",
          name: "second",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
        },
      ],
    });
    const result = validateDefinition(invalid, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["ARBITRARY_TARGET_FORBIDDEN", "DUPLICATE_STEP_ID"]),
    );
  });

  it("requires cleanup and sufficient environment privilege for write cases", () => {
    const writeDefinition = definition({
      metadata: {
        name: "create order",
        systemKey: "sample-system",
        moduleKey: "order",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "write",
        tags: ["http"],
      },
      steps: [
        {
          id: "request",
          name: "create",
          kind: "action",
          action: "http:request",
          params: { method: "POST", path: "/orders" },
        },
      ],
    });
    const result = validateDefinition(writeDefinition, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["ACTION_LEVEL_EXCEEDS_ENVIRONMENT", "CLEANUP_REQUIRED"]),
    );
  });
});
