import { describe, expect, it } from "vitest";

import { caseResults, dependencyNames, runStatuses } from "./index.js";

describe("platform contracts", () => {
  it("keeps dependency health names stable", () => {
    expect(dependencyNames).toEqual(["postgres", "redis", "minio"]);
  });

  it("contains the committed result and run states", () => {
    expect(runStatuses).toContain("cleaning");
    expect(caseResults).toContain("environment_failed");
    expect(caseResults).toContain("infrastructure_failed");
  });
});
