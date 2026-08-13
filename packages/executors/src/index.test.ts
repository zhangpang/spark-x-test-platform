import { describe, expect, it } from "vitest";

import {
  assertHttpTargetAllowed,
  executeHttpRequest,
  ExecutorFailure,
  ExecutorRegistry,
  interpolateString,
  interpolateValue,
} from "./index.js";

describe("executor registry", () => {
  it("rejects duplicate action keys", () => {
    const registry = new ExecutorRegistry();
    registry.register({ key: "http:get", actionLevel: "read", defaultTimeoutMs: 30_000 });
    expect(() =>
      registry.register({ key: "http:get", actionLevel: "read", defaultTimeoutMs: 30_000 }),
    ).toThrow("Executor already registered");
  });
});

describe("HTTP executor safety", () => {
  const environment = {
    baseUrl: "http://api:4100/",
    actionLevel: "read" as const,
    allowlist: [{ protocol: "http" as const, host: "api", ports: [4100], pathPrefixes: ["/"] }],
  };

  it("rejects targets outside the environment allowlist", () => {
    expect(() =>
      assertHttpTargetAllowed(new URL("http://metadata.internal/"), environment.allowlist),
    ).toThrow(ExecutorFailure);
  });

  it("fails closed when a variable is missing", () => {
    expect(() => interpolateString("Bearer ${case.token}", {})).toThrow("变量 case.token 不存在");
  });

  it("interpolates variables recursively in structured request bodies", () => {
    expect(
      interpolateValue(
        { order: { id: "${case.order-id}" }, tags: ["run:${run.id}"] },
        { "case.order-id": "A-42", "run.id": "run-1" },
      ),
    ).toEqual({ order: { id: "A-42" }, tags: ["run:run-1"] });
  });

  it("revalidates redirect targets", async () => {
    const fetcher = async () =>
      new Response(null, { status: 302, headers: { location: "http://metadata.internal/" } });
    await expect(
      executeHttpRequest(
        environment,
        { method: "GET", path: "/health" },
        {},
        { timeoutMs: 1_000, fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ failure: { code: "TARGET_NOT_ALLOWED" } });
  });

  it("returns bounded structured HTTP evidence", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", authorization: "secret" },
      });
    await expect(
      executeHttpRequest(
        environment,
        { method: "GET", path: "/health" },
        {},
        { timeoutMs: 1_000, fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toMatchObject({ status: 200, body: { ok: true }, headers: {} });
  });
});
