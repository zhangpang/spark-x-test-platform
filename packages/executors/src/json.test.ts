import { describe, expect, it } from "vitest";

import { executeJsonAssert, executeJsonExtract } from "./index.js";

function capturedFailure(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected executor action to fail");
}

describe("JSON executor", () => {
  it("extracts a nested array value without returning the complete source", () => {
    expect(
      executeJsonExtract(
        { source: "${step.response-body}", path: "$.orders[1].id" },
        {
          "step.response-body": {
            orders: [
              { id: "order-1", private: "not-selected" },
              { id: "order-2", private: "not-selected" },
            ],
          },
        },
      ),
    ).toEqual({ path: "$.orders[1].id", found: true, value: "order-2" });
  });

  it("compares objects structurally and resolves an exact expected variable", () => {
    expect(
      executeJsonAssert(
        {
          source: "${step.response-body}",
          path: "$.result",
          operator: "equals",
          expected: "${step.expected-result}",
        },
        {
          "step.response-body": JSON.stringify({ result: { count: 2, state: "ready" } }),
          "step.expected-result": { state: "ready", count: 2 },
        },
      ),
    ).toMatchObject({ matched: true, actual: { count: 2, state: "ready" } });
  });

  it("supports bounded string and array contains comparisons", () => {
    expect(
      executeJsonAssert(
        {
          source: "${step.response-body}",
          path: "$.message",
          operator: "contains",
          expected: "ready",
        },
        { "step.response-body": { message: "index ready", states: ["queued", "ready"] } },
      ),
    ).toMatchObject({ matched: true });
    expect(
      executeJsonAssert(
        {
          source: "${step.response-body}",
          path: "$.states",
          operator: "contains",
          expected: "ready",
        },
        { "step.response-body": { states: ["queued", "ready"] } },
      ),
    ).toMatchObject({ matched: true });
  });

  it("returns stable product failures for a missing path, malformed JSON and mismatch", () => {
    expect(
      capturedFailure(() =>
        executeJsonExtract(
          { source: "${step.response-body}", path: "$.missing" },
          { "step.response-body": { state: "ready" } },
        ),
      ),
    ).toMatchObject({ failure: { code: "JSON_PATH_NOT_FOUND" } });
    expect(
      capturedFailure(() =>
        executeJsonExtract(
          { source: "${step.response-body}", path: "$.state" },
          { "step.response-body": "{invalid" },
        ),
      ),
    ).toMatchObject({ failure: { code: "JSON_SOURCE_INVALID" } });
    expect(
      capturedFailure(() =>
        executeJsonAssert(
          {
            source: "${step.response-body}",
            path: "$.state",
            operator: "equals",
            expected: "ready",
          },
          { "step.response-body": { state: "failed" } },
        ),
      ),
    ).toMatchObject({ failure: { code: "JSON_ASSERTION_FAILED" } });
  });

  it("rejects missing variables, executable paths and oversized selected evidence", () => {
    expect(
      capturedFailure(() => executeJsonExtract({ source: "${step.missing}", path: "$" }, {})),
    ).toMatchObject({ failure: { code: "VARIABLE_NOT_FOUND" } });
    expect(
      capturedFailure(() =>
        executeJsonExtract(
          { source: "${step.response-body}", path: "$.items[*]" },
          { "step.response-body": { items: [] } },
        ),
      ),
    ).toMatchObject({ failure: { code: "JSON_PATH_INVALID" } });
    expect(
      capturedFailure(() =>
        executeJsonExtract(
          { source: "${step.response-body}", path: "$.value" },
          { "step.response-body": { value: "x".repeat(65_537) } },
        ),
      ),
    ).toMatchObject({ failure: { code: "JSON_SELECTED_VALUE_TOO_LARGE" } });

    let nested: unknown = "leaf";
    for (let depth = 0; depth < 52; depth += 1) nested = { child: nested };
    expect(
      capturedFailure(() =>
        executeJsonExtract(
          { source: "${step.response-body}", path: "$" },
          { "step.response-body": nested },
        ),
      ),
    ).toMatchObject({ failure: { code: "JSON_SOURCE_TOO_COMPLEX" } });
  });
});
