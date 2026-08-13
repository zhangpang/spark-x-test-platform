import type { RunExecutionSnapshot } from "@spark-x-test/service-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunJob, type RunExecutionStore } from "./run-executor.js";

const job = {
  protocolVersion: "1.0" as const,
  runId: "00000000-0000-4000-8000-000000000101",
  queuedAt: new Date(0).toISOString(),
  priority: 50,
};

function snapshot(definition: Readonly<Record<string, unknown>>): RunExecutionSnapshot {
  return {
    environment: {
      id: "00000000-0000-4000-8000-000000000102",
      baseUrl: "http://api:4100/",
      actionLevel: "write",
      allowlist: [{ protocol: "http", host: "api", ports: [4100], pathPrefixes: ["/"] }],
    },
    suite: {
      id: "00000000-0000-4000-8000-000000000103",
      name: "Core regression",
      diagnosticRetries: 1,
    },
    cases: [
      {
        runCaseId: "00000000-0000-4000-8000-000000000104",
        caseId: "00000000-0000-4000-8000-000000000105",
        caseVersionId: "00000000-0000-4000-8000-000000000106",
        name: "Health",
        version: 1,
        sortOrder: 0,
        definition,
      },
    ],
  };
}

function fakeStore(executionSnapshot: RunExecutionSnapshot) {
  return {
    claimRun: vi.fn(() => Promise.resolve(executionSnapshot)),
    setRunStatus: vi.fn(() => Promise.resolve(true)),
    isCancellationRequested: vi.fn(() => Promise.resolve(false)),
    resolveSecretVariables: vi.fn(() => Promise.resolve({})),
    heartbeat: vi.fn(() => Promise.resolve()),
    startCase: vi.fn(() => Promise.resolve()),
    recordStep: vi.fn(() => Promise.resolve()),
    finishCase: vi.fn(() => Promise.resolve()),
    completeRun: vi.fn(() => Promise.resolve()),
  } as unknown as RunExecutionStore;
}

function requestUrl(input: URL | RequestInfo | undefined): string | undefined {
  if (input instanceof URL) return input.toString();
  if (typeof input === "string") return input;
  return input?.url;
}

afterEach(() => vi.unstubAllGlobals());

describe("run worker", () => {
  it("preserves the first failure when a diagnostic retry passes", async () => {
    const definition = {
      execution: { stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 },
      steps: [
        {
          id: "health",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          capture: { status: "$.status" },
          assertions: [{ type: "status:equals", actual: "${step.status}", expected: 200 }],
        },
      ],
      finally: [
        {
          id: "cleanup",
          action: "http:request",
          params: { method: "POST", path: "/cleanup/${step.status}" },
        },
      ],
    };
    const statuses = [503, 200, 204];
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      void input;
      return Promise.resolve(new Response(null, { status: statuses.shift() ?? 500 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = fakeStore(snapshot(definition));

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { total: 1, flaky: 1 },
    });
    expect(store.startCase).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock.mock.calls[2]?.[0])).toBe("http://api:4100/cleanup/200");
    expect(store.finishCase).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      "flaky",
      "passed",
      expect.objectContaining({ code: "STATUS_ASSERTION_FAILED" }),
      expect.any(Number),
      true,
    );
    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ flaky: 1 }),
      "passed",
      expect.objectContaining({ code: "STATUS_ASSERTION_FAILED" }),
    );
  });

  it("classifies an unavailable executor as a test failure", async () => {
    const store = fakeStore(
      snapshot({
        steps: [{ id: "browser", action: "browser:navigate", params: { path: "/" } }],
      }),
    );
    await executeRunJob(job, "worker-1", store);
    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ testFailed: 1 }),
      "blocked",
      expect.objectContaining({ code: "EXECUTOR_NOT_AVAILABLE" }),
    );
  });

  it("promotes a cleanup failure to an infrastructure failure", async () => {
    const store = fakeStore(
      snapshot({
        steps: [{ id: "health", action: "http:request", params: { method: "GET", path: "/" } }],
        finally: [
          {
            id: "cleanup",
            action: "http:request",
            params: { method: "POST", path: "/cleanup" },
            capture: { status: "$.status" },
            assertions: [{ type: "status:equals", actual: "${step.status}", expected: 204 }],
          },
        ],
      }),
    );
    const statuses = [200, 500];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: statuses.shift() ?? 500 }))),
    );

    await executeRunJob(job, "worker-1", store);

    expect(store.finishCase).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      "infrastructure_failed",
      "failed",
      expect.objectContaining({ code: "CLEANUP_FAILED" }),
      expect.any(Number),
      false,
    );
    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ infrastructureFailed: 1 }),
      "inconclusive",
      expect.objectContaining({ code: "CLEANUP_FAILED" }),
    );
  });

  it("injects referenced secrets in memory and redacts echoed evidence", async () => {
    const store = fakeStore(
      snapshot({
        inputs: [{ name: "auth-token", secretRef: "api-token" }],
        steps: [
          {
            id: "authenticated",
            action: "http:request",
            params: {
              method: "GET",
              path: "/echo/${case.auth-token}",
              headers: { Authorization: "Bearer ${case.auth-token}" },
            },
          },
        ],
      }),
    );
    const secret = "synthetic-secret-that-must-not-persist";
    const recorded: unknown[] = [];
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({ "case.auth-token": secret });
    vi.mocked(store.recordStep).mockImplementation((_runId, input) => {
      recorded.push(input);
      return Promise.resolve();
    });
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      void input;
      return Promise.resolve(
        new Response(JSON.stringify({ token: secret, value: `echo:${secret}` }), {
          status: 200,
          headers: { "content-type": "application/json", "x-echo": secret },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await executeRunJob(job, "worker-1", store);

    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(`http://api:4100/echo/${secret}`);
    const evidence = JSON.stringify(recorded[0]);
    expect(evidence).not.toContain(secret);
    expect(evidence).toContain("[REDACTED]");
  });

  it("propagates cancellation to HTTP and still executes finally cleanup", async () => {
    const store = fakeStore(
      snapshot({
        execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 10_000 },
        steps: [{ id: "slow", action: "http:request", params: { method: "GET", path: "/slow" } }],
        finally: [
          {
            id: "cleanup",
            action: "http:request",
            params: { method: "POST", path: "/cleanup" },
          },
        ],
      }),
    );
    vi.mocked(store.isCancellationRequested).mockResolvedValueOnce(false).mockResolvedValue(true);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        call += 1;
        if (call > 1) return new Response(null, { status: 204 });
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === null || signal === undefined) {
            reject(new Error("missing abort signal"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }),
    );

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { cancelled: 1 },
    });
    expect(store.finishCase).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      "cancelled",
      "passed",
      null,
      expect.any(Number),
      false,
    );
    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ cancelled: 1 }),
      "inconclusive",
      null,
    );
  });
});
