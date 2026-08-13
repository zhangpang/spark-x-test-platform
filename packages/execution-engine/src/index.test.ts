import { describe, expect, it } from "vitest";

import {
  assertRunTransition,
  canTransitionRun,
  choosePrimaryFailure,
  gateResultForSummary,
  summarizeCaseResults,
} from "./index.js";

describe("run state machine", () => {
  it("forces cancellation through cleanup", () => {
    expect(canTransitionRun("running", "cancelling")).toBe(true);
    expect(canTransitionRun("cancelling", "cleaning")).toBe(true);
    expect(canTransitionRun("cancelling", "completed")).toBe(false);
  });

  it("rejects transitions out of completed", () => {
    expect(() => assertRunTransition("completed", "running")).toThrow("Invalid run transition");
  });
});

describe("run outcome aggregation", () => {
  it("blocks product and test failures without hiding the first failure", () => {
    const summary = summarizeCaseResults(["passed", "product_failed", "flaky"]);
    expect(summary).toMatchObject({ total: 3, passed: 1, productFailed: 1, flaky: 1 });
    expect(gateResultForSummary(summary)).toBe("blocked");
  });

  it("marks environment-only failures as inconclusive", () => {
    expect(gateResultForSummary(summarizeCaseResults(["environment_failed"]))).toBe("inconclusive");
  });

  it("chooses a product failure over infrastructure noise", () => {
    expect(
      choosePrimaryFailure([
        { code: "WORKER_LOST", message: "lost", classification: "infrastructure_failed" },
        { code: "ASSERTION", message: "wrong result", classification: "product_failed" },
      ]),
    ).toMatchObject({ code: "ASSERTION" });
  });
});
