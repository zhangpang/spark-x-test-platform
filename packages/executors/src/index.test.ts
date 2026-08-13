import { describe, expect, it } from "vitest";

import { ExecutorRegistry } from "./index.js";

describe("executor registry", () => {
  it("rejects duplicate action keys", () => {
    const registry = new ExecutorRegistry();
    registry.register({ key: "http:get", actionLevel: "read", defaultTimeoutMs: 30_000 });
    expect(() =>
      registry.register({ key: "http:get", actionLevel: "read", defaultTimeoutMs: 30_000 }),
    ).toThrow("Executor already registered");
  });
});
