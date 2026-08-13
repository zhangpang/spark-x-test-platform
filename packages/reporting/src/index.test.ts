import { describe, expect, it } from "vitest";

import { summarizeResults } from "./index.js";

describe("result summary", () => {
  it("does not merge environment and product failures", () => {
    const summary = summarizeResults(["product_failed", "environment_failed", "passed"]);
    expect(summary.product_failed).toBe(1);
    expect(summary.environment_failed).toBe(1);
    expect(summary.passed).toBe(1);
  });
});
