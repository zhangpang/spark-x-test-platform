import { describe, expect, it } from "vitest";

import { assertRunTransition, canTransitionRun } from "./index.js";

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
