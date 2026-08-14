import type { RunExecutionSnapshot } from "@spark-x-test/service-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeCompensationJob,
  executeRunJob,
  type CompensationExecutionStore,
  type RunExecutionStore,
} from "./run-executor.js";

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
    acquireResourceLocks: vi.fn(() => Promise.resolve(true)),
    releaseResourceLocks: vi.fn(() => Promise.resolve()),
    registerResource: vi.fn(() => Promise.resolve()),
    markCaseResources: vi.fn(() => Promise.resolve(0)),
    prepareCompensation: vi.fn(() =>
      Promise.resolve({
        id: "00000000-0000-4000-8000-000000000107",
        runId: job.runId,
        status: "queued",
        attempts: 0,
        lastError: null,
        createdAt: new Date(0).toISOString(),
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date(0).toISOString(),
      }),
    ),
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
        steps: [{ id: "missing", action: "adapter:missing/action", params: {} }],
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

  it("records Chromium screenshots and trace chunks against the browser step attempt", async () => {
    const store = fakeStore(
      snapshot({
        steps: [
          {
            id: "open-console",
            action: "browser:navigate",
            params: { path: "/" },
            capture: { title: "$.title" },
          },
        ],
      }),
    );
    const close = vi.fn(() => Promise.resolve());
    const browserSessionFactory = vi.fn(() =>
      Promise.resolve({
        execute: vi.fn(() =>
          Promise.resolve({
            output: { url: "http://api:4100/", title: "Platform", status: 200 },
            artifacts: [
              {
                kind: "screenshot" as const,
                data: Buffer.from("png"),
                contentType: "image/png" as const,
                extension: "png" as const,
              },
              {
                kind: "trace" as const,
                data: Buffer.from("zip"),
                contentType: "application/zip" as const,
                extension: "zip" as const,
              },
            ],
          }),
        ),
        close,
      }),
    );

    await executeRunJob(job, "worker-1", store, undefined, { browserSessionFactory });

    expect(browserSessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://api:4100/" }),
    );
    expect(store.recordStep).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({
        attempt: 1,
        action: "browser:navigate",
        status: "passed",
        artifacts: [
          expect.objectContaining({ kind: "screenshot" }),
          expect.objectContaining({ kind: "trace" }),
        ],
      }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("classifies attachment persistence failure without retrying away the root cause", async () => {
    const store = fakeStore(
      snapshot({
        steps: [{ id: "open-console", action: "browser:navigate", params: { path: "/" } }],
      }),
    );
    vi.mocked(store.recordStep).mockImplementation((_runId, input) =>
      "artifacts" in input ? Promise.reject(new Error("minio unavailable")) : Promise.resolve(),
    );
    const browserSessionFactory = vi.fn(() =>
      Promise.resolve({
        execute: () =>
          Promise.resolve({
            output: { url: "http://api:4100/" },
            artifacts: [
              {
                kind: "screenshot" as const,
                data: Buffer.from("png"),
                contentType: "image/png" as const,
                extension: "png" as const,
              },
            ],
          }),
        close: () => Promise.resolve(),
      }),
    );

    await executeRunJob(job, "worker-1", store, undefined, { browserSessionFactory });

    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ infrastructureFailed: 1 }),
      "inconclusive",
      expect.objectContaining({ code: "ARTIFACT_PERSISTENCE_FAILED" }),
    );
    expect(store.startCase).toHaveBeenCalledTimes(2);
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

  it("polls an allowlisted HTTP target and records the final structured wait evidence", async () => {
    const store = fakeStore(
      snapshot({
        execution: { stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 },
        steps: [
          {
            id: "wait-index",
            action: "wait:http",
            params: {
              path: "/tasks/task-42",
              intervalMs: 100,
              condition: { path: "$.body.state", operator: "equals", expected: "ready" },
            },
            capture: { state: "$.lastResponse.body.state" },
          },
        ],
      }),
    );
    const responses = [
      new Response(JSON.stringify({ state: "processing" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ state: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      void input;
      return Promise.resolve(responses.shift() as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { passed: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recordedWaitStep = vi
      .mocked(store.recordStep)
      .mock.calls.find(([, input]) => input.action === "wait:http")?.[1];
    expect(recordedWaitStep).toMatchObject({ action: "wait:http", status: "passed" });
    expect(recordedWaitStep?.outputSummary).toMatchObject({
      attempts: 2,
      matched: true,
      lastResponse: { body: { state: "ready" } },
    });
  });

  it("chains an HTTP capture through JSON extraction and a downstream variable", async () => {
    const store = fakeStore(
      snapshot({
        execution: { stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 },
        steps: [
          {
            id: "read-health",
            action: "http:request",
            params: { method: "GET", path: "/healthz" },
            capture: { "health-body": "$.body" },
          },
          {
            id: "extract-status",
            action: "json:extract",
            params: { source: "${step.health-body}", path: "$.status" },
            capture: { "health-status": "$.value" },
          },
          {
            id: "assert-status",
            action: "json:assert",
            params: {
              source: "${step.health-body}",
              path: "$.status",
              operator: "equals",
              expected: "${step.health-status}",
            },
          },
          {
            id: "use-status",
            action: "http:request",
            params: { method: "GET", path: "/echo/${step.health-status}" },
          },
        ],
      }),
    );
    const responses = [
      new Response(JSON.stringify({ status: "ok", private: "not-selected" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { status: 204 }),
    ];
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      void input;
      return Promise.resolve(responses.shift() as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { passed: 1 },
    });
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).toBe("http://api:4100/echo/ok");
    const jsonSteps = vi
      .mocked(store.recordStep)
      .mock.calls.map(([, input]) => input)
      .filter((input) => input.action.startsWith("json:"));
    expect(jsonSteps).toEqual([
      expect.objectContaining({
        action: "json:extract",
        outputSummary: { path: "$.status", found: true, value: "ok" },
      }),
      expect.objectContaining({
        action: "json:assert",
        outputSummary: { path: "$.status", operator: "equals", matched: true, actual: "ok" },
      }),
    ]);
    expect(JSON.stringify(jsonSteps)).not.toContain("not-selected");
  });

  it("preserves the first JSON assertion failure and still executes finally", async () => {
    const store = fakeStore(
      snapshot({
        execution: { stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 },
        steps: [
          {
            id: "read-health",
            action: "http:request",
            params: { method: "GET", path: "/healthz" },
            capture: { "health-body": "$.body" },
          },
          {
            id: "assert-status",
            action: "json:assert",
            params: {
              source: "${step.health-body}",
              path: "$.status",
              operator: "equals",
              expected: "ready",
            },
          },
        ],
        finally: [
          {
            id: "cleanup",
            action: "http:request",
            params: { method: "POST", path: "/cleanup" },
          },
        ],
      }),
    );
    const responses = [
      new Response(JSON.stringify({ status: "failed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ status: "failed-again" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { status: 204 }),
    ];
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      void input;
      return Promise.resolve(responses.shift() as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { productFailed: 1 },
    });
    expect(store.startCase).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock.mock.calls[2]?.[0])).toBe("http://api:4100/cleanup");
    expect(store.finishCase).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      "product_failed",
      "passed",
      expect.objectContaining({ code: "JSON_ASSERTION_FAILED", stepId: "assert-status" }),
      expect.any(Number),
      false,
    );
    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ productFailed: 1 }),
      "blocked",
      expect.objectContaining({ code: "JSON_ASSERTION_FAILED", stepId: "assert-status" }),
    );
  });

  it("reports a missing capture path before a downstream variable can hide the root cause", async () => {
    const store = fakeStore(
      snapshot({
        steps: [
          {
            id: "read-health",
            action: "http:request",
            params: { method: "GET", path: "/healthz" },
            capture: { state: "$.body.state" },
          },
          {
            id: "use-state",
            action: "http:request",
            params: { method: "GET", path: "/state/${step.state}" },
          },
        ],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    await executeRunJob(job, "worker-1", store);

    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ productFailed: 1 }),
      "blocked",
      expect.objectContaining({ code: "CAPTURE_PATH_NOT_FOUND", stepId: "read-health" }),
    );
  });

  it("injects declared default inputs into downstream interpolation without treating them as secrets", async () => {
    const store = fakeStore(
      snapshot({
        inputs: [{ name: "region", type: "string", required: true, default: "cn" }],
        steps: [
          {
            id: "read-region",
            action: "http:request",
            params: { method: "GET", path: "/regions/${case.region}" },
          },
        ],
      }),
    );
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      void input;
      return Promise.resolve(
        new Response(JSON.stringify({ region: "cn" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await executeRunJob(job, "worker-1", store);

    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe("http://api:4100/regions/cn");
    const recorded = vi.mocked(store.recordStep).mock.calls[0]?.[1];
    expect(recorded?.outputSummary).toMatchObject({ body: { region: "cn" } });
  });

  it("registers a nested response resource and queues compensation after cleanup fails", async () => {
    const store = fakeStore(
      snapshot({
        execution: { stepTimeoutMs: 1_000, caseTimeoutMs: 5_000 },
        resourceLocks: ["knowledge-base:${run.id}"],
        steps: [
          {
            id: "create-resource",
            action: "http:request",
            params: { method: "POST", path: "/resources" },
            capture: { "resource-id": "$.body.id" },
            resource: {
              type: "knowledge-base",
              id: "${step.resource-id}",
              cleanup: {
                action: "http:request",
                params: { method: "GET", path: "/cleanup/${resource.id}" },
              },
            },
          },
        ],
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
    vi.mocked(store.markCaseResources).mockResolvedValue(1);
    const responses = [
      new Response(JSON.stringify({ id: "kb-123" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
      new Response(null, { status: 500 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(responses.shift() as Response)),
    );
    const enqueueCleanup = vi.fn(() => Promise.resolve());

    await expect(executeRunJob(job, "worker-1", store, enqueueCleanup)).resolves.toMatchObject({
      compensationPending: true,
    });

    expect(store.acquireResourceLocks).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      [`knowledge-base:${job.runId}`],
    );
    expect(store.registerResource).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({
        resourceType: "knowledge-base",
        systemResourceId: "kb-123",
      }),
    );
    expect(store.prepareCompensation).toHaveBeenCalledOnce();
    expect(enqueueCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupJobId: "00000000-0000-4000-8000-000000000107" }),
    );
    expect(store.completeRun).not.toHaveBeenCalled();
  });

  it("executes a persisted compensation definition and completes the pending run", async () => {
    const cleanupJob = {
      protocolVersion: "1.0" as const,
      cleanupJobId: "00000000-0000-4000-8000-000000000107",
      runId: job.runId,
      queuedAt: new Date(0).toISOString(),
    };
    const store = {
      claimCleanupJob: vi.fn(() =>
        Promise.resolve({
          id: cleanupJob.cleanupJobId,
          runId: job.runId,
          attempts: 1,
          summary: {
            total: 1,
            queued: 0,
            running: 0,
            passed: 0,
            productFailed: 0,
            testFailed: 0,
            environmentFailed: 0,
            infrastructureFailed: 1,
            flaky: 0,
            cancelled: 0,
            skipped: 0,
          },
          gateResult: "inconclusive",
          firstFailure: null,
          snapshot: snapshot({ steps: [] }),
        }),
      ),
      resolveSecretVariables: vi.fn(() => Promise.resolve({})),
      listResourcesForCleanup: vi.fn(() =>
        Promise.resolve([
          {
            id: "00000000-0000-4000-8000-000000000108",
            systemResourceId: "kb-123",
            cleanupDefinition: {
              action: "http:request",
              params: { method: "GET", path: "/cleanup/${resource.id}" },
            },
          },
        ]),
      ),
      markResourceCleanup: vi.fn(() => Promise.resolve()),
      renewResourceLocks: vi.fn(() => Promise.resolve()),
      failCleanupJob: vi.fn(() => Promise.resolve()),
      completeCompensation: vi.fn(() => Promise.resolve()),
    } as unknown as CompensationExecutionStore;
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      void input;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeCompensationJob(cleanupJob, store)).resolves.toEqual({ cleaned: 1 });

    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe("http://api:4100/cleanup/kb-123");
    expect(store.markResourceCleanup).toHaveBeenLastCalledWith(
      "00000000-0000-4000-8000-000000000108",
      "passed",
    );
    expect(store.completeCompensation).toHaveBeenCalledWith(cleanupJob.cleanupJobId);
  });
});
