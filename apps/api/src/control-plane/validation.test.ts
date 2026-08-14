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

    const unsafeDefault = definition({
      inputs: [{ name: "api-token", type: "string", required: true, default: "plain-value" }],
    });
    expect(
      validateDefinition(unsafeDefault, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PLAINTEXT_SECRET" })]));
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

  it("accepts declared browser navigation and rejects script-shaped browser input", () => {
    const browserDefinition = definition({
      metadata: {
        name: "Browser health",
        systemKey: "sample-system",
        moduleKey: "order",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "read",
        tags: ["browser"],
      },
      steps: [
        {
          id: "open",
          name: "open health",
          kind: "action",
          action: "browser:navigate",
          params: { path: "/healthz", expectedStatus: 200 },
        },
      ],
    });
    expect(
      validateDefinition(browserDefinition, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = definition({
      steps: [
        {
          id: "open",
          name: "unsafe",
          kind: "action",
          action: "browser:navigate",
          params: { path: "/healthz", evaluate: "document.cookie" },
        },
      ],
    });
    expect(
      validateDefinition(unsafe, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ARBITRARY_BROWSER_INPUT_FORBIDDEN" }),
      ]),
    );
  });

  it("accepts bounded HTTP polling and rejects arbitrary wait inputs", () => {
    const polling = definition({
      steps: [
        {
          id: "wait-index",
          name: "wait for index",
          kind: "action",
          action: "wait:http",
          timeoutMs: 5_000,
          params: {
            path: "/tasks/${run.id}",
            intervalMs: 250,
            condition: { path: "$.body.state", operator: "equals", expected: "ready" },
          },
        },
      ],
    });
    expect(
      validateDefinition(polling, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = definition({
      steps: [
        {
          id: "wait-index",
          name: "unsafe wait",
          kind: "action",
          action: "wait:http",
          params: {
            path: "https://bypass.test/tasks/1",
            method: "POST",
            script: "return response.body.ready",
            condition: { path: "$[0]", operator: "eval" },
          },
        },
      ],
    });
    const result = validateDefinition(unsafe, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "WAIT_HTTP_PATH_INVALID",
        "ARBITRARY_WAIT_INPUT_FORBIDDEN",
        "WAIT_CONDITION_INVALID",
      ]),
    );
  });

  it("accepts an ordered HTTP to JSON variable chain", () => {
    const jsonDefinition = definition({
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          capture: { "health-body": "$.body" },
        },
        {
          id: "extract-status",
          name: "extract status",
          kind: "action",
          action: "json:extract",
          params: { source: "${step.health-body}", path: "$.items[0].status" },
          capture: { "health-status": "$.value" },
        },
        {
          id: "assert-status",
          name: "assert status",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.health-body}",
            path: "$.items[0].status",
            operator: "equals",
            expected: "${step.health-status}",
          },
        },
      ],
    });
    expect(
      validateDefinition(jsonDefinition, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects unsafe JSON paths, unknown sources and arbitrary JSON inputs", () => {
    const unsafe = definition({
      steps: [
        {
          id: "unsafe-json",
          name: "unsafe json",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.future-body}",
            path: "$.items[?(@.ready)].status",
            operator: "eval",
            script: "return value",
          },
        },
      ],
    });
    const result = validateDefinition(unsafe, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "ARBITRARY_JSON_INPUT_FORBIDDEN",
        "JSON_SOURCE_REFERENCE_UNKNOWN",
        "JSON_PATH_INVALID",
        "JSON_OPERATOR_INVALID",
      ]),
    );
  });

  it("requires comparison values and rejects values on exists JSON assertions", () => {
    const invalid = definition({
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          capture: { body: "$.body" },
        },
        {
          id: "missing-expected",
          name: "missing expected",
          kind: "action",
          action: "json:assert",
          params: { source: "${step.body}", path: "$.state", operator: "equals" },
        },
        {
          id: "unexpected-expected",
          name: "unexpected expected",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.body}",
            path: "$.state",
            operator: "exists",
            expected: true,
          },
        },
      ],
    });
    expect(
      validateDefinition(invalid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining(["JSON_EXPECTED_VALUE_REQUIRED", "JSON_EXPECTED_VALUE_FORBIDDEN"]),
    );
  });

  it("rejects capture paths that the runtime cannot resolve", () => {
    const invalid = definition({
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          capture: { body: "$.items[0]" },
        },
      ],
    });
    expect(
      validateDefinition(invalid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CAPTURE_PATH_INVALID" })]));
  });

  it("validates ordered step references while allowing declared case defaults", () => {
    const valid = definition({
      inputs: [{ name: "region", type: "string", required: true, default: "cn" }],
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/${case.region}/healthz" },
          capture: { status: "$.status" },
        },
        {
          id: "use-status",
          name: "use status",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/status/${step.status}" },
        },
      ],
    });
    expect(
      validateDefinition(valid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const invalid = definition({
      steps: [
        {
          id: "use-future",
          name: "use future",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/status/${step.future}" },
        },
      ],
    });
    expect(
      validateDefinition(invalid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "VARIABLE_REFERENCE_UNKNOWN" })]),
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

  it("accepts a fail-closed resource registration and rejects unsafe cleanup references", () => {
    const safe = definition({
      resourceLocks: ["knowledge-base:${run.id}"],
      steps: [
        {
          id: "request",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          resource: {
            type: "knowledge-base",
            id: "${run.id}",
            cleanup: {
              action: "http:request",
              params: { method: "GET", path: "/healthz?resource=${resource.id}" },
            },
          },
        },
      ],
      finally: [
        {
          id: "cleanup",
          name: "cleanup",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
        },
      ],
    });
    expect(
      validateDefinition(safe, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = definition({
      resourceLocks: ["knowledge-base:${case.secret}"],
      steps: [
        {
          id: "request",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          resource: {
            type: "knowledge-base",
            id: "${run.id}",
            cleanup: {
              action: "http:request",
              params: { method: "GET", path: "/healthz?resource=${step.untrusted}" },
            },
          },
        },
      ],
      finally: [
        {
          id: "cleanup",
          name: "cleanup",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
        },
      ],
    });
    const result = validateDefinition(unsafe, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CLEANUP_REFERENCE_FORBIDDEN", "RESOURCE_LOCK_REFERENCE_FORBIDDEN"]),
    );
  });
});
