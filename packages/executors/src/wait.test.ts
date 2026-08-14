import { describe, expect, it, vi } from "vitest";

import { executeWaitHttp } from "./index.js";

const environment = {
  baseUrl: "http://api:4100/",
  actionLevel: "read" as const,
  allowlist: [{ protocol: "http" as const, host: "api", ports: [4100], pathPrefixes: ["/"] }],
};

describe("HTTP wait executor", () => {
  it("polls until a bounded JSON condition matches and returns structured evidence", async () => {
    const responses = [
      { state: "processing", secret: "not-a-real-secret" },
      { state: "ready", result: { count: 2 } },
    ];
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      executeWaitHttp(
        environment,
        {
          path: "/tasks/${step.task-id}",
          intervalMs: 100,
          condition: { path: "$.body.state", operator: "equals", expected: "ready" },
        },
        { "step.task-id": "task-42" },
        {
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          fetcher: fetcher as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({
      attempts: 2,
      matched: true,
      lastResponse: { status: 200, body: { state: "ready", result: { count: 2 } } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("revalidates every redirect target through the environment allowlist", async () => {
    const fetcher = () =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "http://metadata.internal/" } }),
      );
    await expect(
      executeWaitHttp(
        environment,
        {
          path: "/tasks/task-42",
          condition: { path: "$.status", operator: "equals", expected: 200 },
        },
        {},
        {
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          fetcher: fetcher as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ failure: { code: "TARGET_NOT_ALLOWED" } });
  });

  it("returns a stable product failure when healthy responses never satisfy the condition", async () => {
    const fetcher = () =>
      Promise.resolve(
        new Response(JSON.stringify({ state: "processing" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    await expect(
      executeWaitHttp(
        environment,
        {
          path: "/tasks/task-42",
          intervalMs: 100,
          condition: { path: "$.body.state", operator: "equals", expected: "ready" },
        },
        {},
        { timeoutMs: 120, signal: new AbortController().signal, fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({
      failure: { code: "WAIT_CONDITION_TIMEOUT", classification: "product_failed" },
    });
  });

  it("propagates run cancellation without sending another request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Run cancellation requested"));
    const fetcher = vi.fn();
    await expect(
      executeWaitHttp(
        environment,
        {
          path: "/tasks/task-42",
          condition: { path: "$.status", operator: "equals", expected: 200 },
        },
        {},
        { timeoutMs: 1_000, signal: controller.signal, fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject({ failure: { code: "EXECUTION_CANCELLED" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects arbitrary targets and unbounded condition syntax at runtime", async () => {
    await expect(
      executeWaitHttp(
        environment,
        {
          path: "http://api:4100/tasks/task-42",
          condition: { path: "$[0]", operator: "equals", expected: "ready" },
        },
        {},
        { timeoutMs: 1_000, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ failure: { code: "WAIT_HTTP_PATH_INVALID" } });
  });
});
