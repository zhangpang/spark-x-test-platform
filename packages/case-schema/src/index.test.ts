import { describe, expect, it } from "vitest";

import { validateTestCaseDefinition } from "./index.js";

const validCase = {
  schemaVersion: "1.0",
  kind: "automated",
  metadata: {
    name: "Health contract",
    systemKey: "sample-system",
    moduleKey: "health",
    priority: "P0",
    classification: "blackbox",
    actionLevel: "read",
  },
  execution: {
    stepTimeoutMs: 10_000,
    caseTimeoutMs: 60_000,
    diagnosticRetries: 0,
  },
  steps: [
    {
      id: "check-health",
      name: "Check health",
      kind: "action",
      action: "http:get",
      params: { path: "/healthz" },
    },
  ],
  finally: [],
};

describe("test case schema", () => {
  it("accepts a minimal automated case", () => {
    expect(validateTestCaseDefinition(validCase)).toEqual({ valid: true, errors: [] });
  });

  it("rejects an action outside the registered namespace shape", () => {
    const invalidCase = structuredClone(validCase);
    invalidCase.steps[0]!.action = "shell";
    expect(validateTestCaseDefinition(invalidCase).valid).toBe(false);
  });

  it("accepts optional resource registration metadata", () => {
    const resourceCase = {
      ...validCase,
      steps: [
        {
          ...validCase.steps[0],
          resource: {
            type: "knowledge-base",
            id: "${run.id}",
            cleanup: {
              action: "http:request",
              params: { method: "DELETE", path: "/knowledge-bases/${resource.id}" },
            },
          },
        },
      ],
    };
    expect(validateTestCaseDefinition(resourceCase)).toEqual({ valid: true, errors: [] });
  });
});
