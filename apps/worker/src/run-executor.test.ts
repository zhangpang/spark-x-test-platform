import { createHash } from "node:crypto";

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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function knowledgeBaseSnapshot(): RunExecutionSnapshot {
  return {
    ...snapshot({
      execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 30_000, diagnosticRetries: 0 },
      inputs: [
        { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
        { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
      ],
      resourceLocks: ["spark-x-agent:admin:knowledge-base"],
      steps: [
        {
          id: "create-knowledge-base",
          action: "adapter:spark-x-agent/knowledge-base.create",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            name: "spark-x-kb-${run.id}",
            description: "fixed fixture",
          },
          capture: { "knowledge-base-id": "$.knowledgeBaseId" },
          resource: {
            type: "spark-x-agent-knowledge-base",
            id: "${step.knowledge-base-id}",
            cleanup: {
              action: "adapter:spark-x-agent/knowledge-base.cleanup",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                knowledgeBaseId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "upload-fixture",
          action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
          },
          capture: {
            "uploaded-document-id": "$.uploadedDocumentId",
            "fixture-sha256": "$.fixtureSha256",
          },
        },
        {
          id: "attach-fixture",
          action: "adapter:spark-x-agent/knowledge-base.attach-upload",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
            uploadedDocumentId: "${step.uploaded-document-id}",
            title: "spark-x-kb-${run.id}.pdf",
          },
          capture: { "knowledge-document-id": "$.knowledgeDocumentId" },
        },
        {
          id: "wait-ready",
          action: "adapter:spark-x-agent/knowledge-base.wait-ready",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
            knowledgeDocumentId: "${step.knowledge-document-id}",
            expectedFixtureSha256: "${step.fixture-sha256}",
            expectedTitle: "spark-x-kb-${run.id}.pdf",
          },
        },
      ],
      finally: [
        {
          id: "cleanup-knowledge-base",
          action: "adapter:spark-x-agent/knowledge-base.cleanup",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
          },
        },
      ],
    }),
    suite: {
      id: "00000000-0000-4000-8000-000000000103",
      name: "Knowledge base P0",
      diagnosticRetries: 0,
    },
    environment: {
      id: "00000000-0000-4000-8000-000000000102",
      baseUrl: "http://192.168.110.136/trade/",
      actionLevel: "dangerous",
      adapterKey: "spark-x-agent",
      allowlist: [
        {
          protocol: "http",
          host: "192.168.110.136",
          ports: [80],
          pathPrefixes: ["/trade/", "/trade-domain-api/"],
        },
      ],
    },
  };
}

function knowledgeBaseFetchMock(failFirstRefresh = false) {
  const knowledgeBaseId = "00000000-0000-4000-8000-000000000130";
  const uploadedDocumentId = "00000000-0000-4000-8000-000000000131";
  const knowledgeDocumentId = "00000000-0000-4000-8000-000000000132";
  let fixture: Readonly<{ sha256: string; text: string }> | undefined;
  let refreshFailed = false;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(requestUrl(input) as string);
    const method = init?.method ?? "GET";
    if (url.pathname === "/trade/api/auth/login" && method === "POST") {
      return json({ success: true, data: { token: "kb-memory-only-token-value" } });
    }
    if (url.pathname === "/trade-domain-api/knowledge-bases" && method === "POST") {
      return json({
        success: true,
        data: {
          id: knowledgeBaseId,
          name: `spark-x-kb-${job.runId}`,
          status: "active",
          visibility: "private",
        },
      });
    }
    if (url.pathname === "/trade/api/documents/upload" && method === "POST") {
      if (!(init?.body instanceof FormData)) throw new Error("expected fixed multipart fixture");
      const file = init.body.get("file");
      if (!(file instanceof Blob)) throw new Error("expected fixed PDF blob");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = (file as Blob & { readonly name?: string }).name;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      fixture = { sha256, text: new TextDecoder().decode(bytes) };
      return json({
        success: true,
        data: {
          id: uploadedDocumentId,
          name,
          size_bytes: bytes.byteLength,
          content_sha256: sha256,
        },
      });
    }
    if (
      url.pathname === `/trade/api/documents/${uploadedDocumentId}/parser-source` &&
      method === "GET"
    ) {
      return json({
        success: true,
        data: {
          document_id: uploadedDocumentId,
          url: "http://192.168.110.136:9000/source.pdf?X-Amz-Signature=kb-secret",
        },
      });
    }
    if (
      url.pathname === `/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents` &&
      method === "POST"
    ) {
      return json({
        success: true,
        data: {
          id: knowledgeDocumentId,
          knowledge_base_id: knowledgeBaseId,
          rust_document_id: uploadedDocumentId,
          title: `spark-x-kb-${job.runId}.pdf`,
          status: "pending",
          parse_job_id: "parse-job-worker-1",
        },
      });
    }
    if (
      url.pathname ===
        `/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents/${knowledgeDocumentId}/refresh` &&
      method === "POST"
    ) {
      if (failFirstRefresh && !refreshFailed) {
        refreshFailed = true;
        return json({ success: false }, 500);
      }
      return json({
        success: true,
        data: {
          id: knowledgeDocumentId,
          knowledge_base_id: knowledgeBaseId,
          title: `spark-x-kb-${job.runId}.pdf`,
          status: "completed",
          current_version_id: "parser-version-worker-1",
          current_version_number: 1,
        },
      });
    }
    if (
      url.pathname === `/trade-domain-api/knowledge-bases/${knowledgeBaseId}` &&
      method === "GET"
    ) {
      return json({
        success: true,
        data: {
          id: knowledgeBaseId,
          status: "active",
          document_count: 1,
          ready_document_count: 1,
        },
      });
    }
    if (
      url.pathname ===
        `/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents/${knowledgeDocumentId}/versions` &&
      method === "GET"
    ) {
      if (fixture === undefined) throw new Error("fixture hash was not captured");
      return json({
        success: true,
        data: {
          items: [
            {
              knowledge_document_id: knowledgeDocumentId,
              version_number: 1,
              status: "completed",
              content_hash: fixture.sha256,
              parser_version_id: "parser-version-worker-1",
            },
          ],
        },
      });
    }
    if (
      url.pathname === `/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents` &&
      method === "GET"
    ) {
      return json({
        success: true,
        data: {
          items: [
            {
              id: knowledgeDocumentId,
              status: failFirstRefresh ? "failed" : "completed",
            },
          ],
        },
      });
    }
    if (
      url.pathname === `/trade/api/documents/upload-status/${knowledgeBaseId}` &&
      method === "GET"
    ) {
      if (fixture === undefined) throw new Error("fixture hash was not captured");
      return json({
        success: true,
        data: {
          id: uploadedDocumentId,
          name: `spark-x-kb-${knowledgeBaseId}.pdf`,
          size_bytes: 1,
          content_sha256: fixture.sha256,
        },
      });
    }
    if (method === "DELETE") return json({ success: true, data: {} });
    throw new Error(`unexpected knowledge-base request ${method} ${url.toString()}`);
  });
  return { fetchMock, fixture: () => fixture };
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

    await executeRunJob(job, "worker-1", store, undefined, {
      browserSessionFactory,
    });

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
        steps: [
          {
            id: "open-console",
            action: "browser:navigate",
            params: { path: "/" },
          },
        ],
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

    await executeRunJob(job, "worker-1", store, undefined, {
      browserSessionFactory,
    });

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
        steps: [
          {
            id: "health",
            action: "http:request",
            params: { method: "GET", path: "/" },
          },
        ],
        finally: [
          {
            id: "cleanup",
            action: "http:request",
            params: { method: "POST", path: "/cleanup" },
            capture: { status: "$.status" },
            assertions: [
              {
                type: "status:equals",
                actual: "${step.status}",
                expected: 204,
              },
            ],
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
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.auth-token": secret,
    });
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
        steps: [
          {
            id: "slow",
            action: "http:request",
            params: { method: "GET", path: "/slow" },
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
              condition: {
                path: "$.body.state",
                operator: "equals",
                expected: "ready",
              },
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
    expect(recordedWaitStep).toMatchObject({
      action: "wait:http",
      status: "passed",
    });
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
        outputSummary: {
          path: "$.status",
          operator: "equals",
          matched: true,
          actual: "ok",
        },
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
      expect.objectContaining({
        code: "JSON_ASSERTION_FAILED",
        stepId: "assert-status",
      }),
      expect.any(Number),
      false,
    );
    expect(store.completeRun).toHaveBeenCalledWith(
      job.runId,
      expect.objectContaining({ productFailed: 1 }),
      "blocked",
      expect.objectContaining({
        code: "JSON_ASSERTION_FAILED",
        stepId: "assert-status",
      }),
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
      expect.objectContaining({
        code: "CAPTURE_PATH_NOT_FOUND",
        stepId: "read-health",
      }),
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
            assertions: [
              {
                type: "status:equals",
                actual: "${step.status}",
                expected: 204,
              },
            ],
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
      expect.objectContaining({
        cleanupJobId: "00000000-0000-4000-8000-000000000107",
      }),
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

    await expect(executeCompensationJob(cleanupJob, store)).resolves.toEqual({
      cleaned: 1,
    });

    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe("http://api:4100/cleanup/kb-123");
    expect(store.markResourceCleanup).toHaveBeenLastCalledWith(
      "00000000-0000-4000-8000-000000000108",
      "passed",
    );
    expect(store.completeCompensation).toHaveBeenCalledWith(cleanupJob.cleanupJobId);
  });

  it("executes the Spark X Agent conversation lifecycle without persisting credentials", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000109";
    const password = "adapter-password-that-must-not-persist";
    const title = `spark-x-regression-${job.runId}`;
    const executionSnapshot: RunExecutionSnapshot = {
      ...snapshot({
        inputs: [
          { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
          { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
        ],
        resourceLocks: ["spark-x-agent-conversation:${run.id}"],
        steps: [
          {
            id: "create-conversation",
            action: "adapter:spark-x-agent/conversation.create",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              title: "spark-x-regression-${run.id}",
            },
            capture: { "conversation-id": "$.conversationId" },
            resource: {
              type: "spark-x-agent-conversation",
              id: "${step.conversation-id}",
              cleanup: {
                action: "adapter:spark-x-agent/conversation.delete",
                params: {
                  username: "${case.admin-username}",
                  password: "${case.admin-password}",
                  conversationId: "${resource.id}",
                },
              },
            },
          },
          {
            id: "assert-recent",
            action: "adapter:spark-x-agent/conversation.assert-recent",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
              title: "spark-x-regression-${run.id}",
            },
          },
        ],
        finally: [
          {
            id: "delete-conversation",
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
            },
          },
        ],
      }),
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/"],
          },
        ],
      },
    };
    const store = fakeStore(executionSnapshot);
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": password,
    });
    const responses = [
      { success: true, data: { token: "adapter-memory-only-token-value" } },
      { success: true, data: { id: conversationId, title } },
      { success: true, data: { token: "adapter-memory-only-token-value" } },
      {
        success: true,
        data: {
          items: [
            {
              id: conversationId,
              title,
              is_pinned: false,
              message_count: 0,
            },
          ],
        },
      },
      { success: true, data: { token: "adapter-memory-only-token-value" } },
      { success: true, message: "deleted" },
    ];
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { passed: 1 },
    });

    const registeredResourceCall = vi.mocked(store.registerResource).mock.calls[0];
    expect(registeredResourceCall?.[0]).toBe(job.runId);
    expect(registeredResourceCall?.[1]).toMatchObject({
      resourceType: "spark-x-agent-conversation",
      systemResourceId: conversationId,
      cleanupDefinition: {
        action: "adapter:spark-x-agent/conversation.delete",
      },
    });
    const evidence = JSON.stringify(vi.mocked(store.recordStep).mock.calls);
    expect(evidence).not.toContain(password);
    expect(evidence).not.toContain("adapter-memory-only-token-value");
    expect(
      vi.mocked(store.recordStep).mock.calls.map(([, input]) => [input.action, input.phase]),
    ).toEqual([
      ["adapter:spark-x-agent/conversation.create", "main"],
      ["adapter:spark-x-agent/conversation.assert-recent", "main"],
      ["adapter:spark-x-agent/conversation.delete", "finally"],
    ]);
  });

  it("routes Spark X Agent chat evidence through captures, history verification, and cleanup", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000119";
    const password = "chat-password-that-must-not-persist";
    const marker = `spark-x-chat-${job.runId}`;
    const message = `自动化回归标识 ${marker}。请只回复这个标识。`;
    const assistantContent = `回复 ${marker}`;
    const assistantHash = createHash("sha256").update(assistantContent).digest("hex");
    const executionSnapshot: RunExecutionSnapshot = {
      ...snapshot({
        inputs: [
          { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
          { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
        ],
        execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 15_000, diagnosticRetries: 0 },
        resourceLocks: ["spark-x-agent:admin:chat"],
        steps: [
          {
            id: "create-conversation",
            action: "adapter:spark-x-agent/conversation.create",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              title: "spark-x-chat-${run.id}",
            },
            capture: { "conversation-id": "$.conversationId" },
            resource: {
              type: "spark-x-agent-conversation",
              id: "${step.conversation-id}",
              cleanup: {
                action: "adapter:spark-x-agent/conversation.delete",
                params: {
                  username: "${case.admin-username}",
                  password: "${case.admin-password}",
                  conversationId: "${resource.id}",
                },
              },
            },
          },
          {
            id: "ask",
            action: "adapter:spark-x-agent/chat.ask",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
              message: "自动化回归标识 spark-x-chat-${run.id}。请只回复这个标识。",
              expectedText: "spark-x-chat-${run.id}",
            },
            capture: { "assistant-sha256": "$.finalContentSha256" },
          },
          {
            id: "assert-history",
            action: "adapter:spark-x-agent/chat.assert-history",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
              expectedUserText: "自动化回归标识 spark-x-chat-${run.id}。请只回复这个标识。",
              expectedAssistantText: "spark-x-chat-${run.id}",
              expectedAssistantSha256: "${step.assistant-sha256}",
            },
          },
        ],
        finally: [
          {
            id: "delete-conversation",
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
            },
          },
        ],
      }),
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/"],
          },
        ],
      },
    };
    const store = fakeStore(executionSnapshot);
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": password,
    });
    const responses = [
      new Response(
        JSON.stringify({
          success: true,
          data: { token: "adapter-memory-only-token-value" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({
          success: true,
          data: { id: conversationId, title: `spark-x-chat-${job.runId}` },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({
          success: true,
          data: { token: "adapter-memory-only-token-value" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        [
          {
            event: "conversation_id",
            data: { conversation_id: conversationId },
          },
          { event: "content", data: { content: assistantContent } },
          {
            event: "done",
            data: {
              final_content: assistantContent,
              truncated: false,
              stop_reason: "stop",
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      new Response(
        JSON.stringify({
          success: true,
          data: { token: "adapter-memory-only-token-value" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({
          success: true,
          data: {
            items: [
              { role: "user", content: message, payload_truncated: false },
              {
                role: "assistant",
                content: assistantContent,
                payload_truncated: false,
                finish_reason: "stop",
                turn_status: "completed",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        JSON.stringify({
          success: true,
          data: { token: "adapter-memory-only-token-value" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(JSON.stringify({ success: true, message: "deleted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(responses.shift() as Response)),
    );

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { passed: 1 },
    });

    expect(vi.mocked(store.registerResource).mock.calls[0]?.[1]).toMatchObject({
      resourceType: "spark-x-agent-conversation",
      systemResourceId: conversationId,
    });
    const evidence = JSON.stringify(vi.mocked(store.recordStep).mock.calls);
    expect(evidence).toContain(assistantHash);
    expect(evidence).not.toContain(assistantContent);
    expect(evidence).not.toContain(password);
    expect(evidence).not.toContain("adapter-memory-only-token-value");
    expect(
      vi.mocked(store.recordStep).mock.calls.map(([, input]) => [input.action, input.phase]),
    ).toEqual([
      ["adapter:spark-x-agent/conversation.create", "main"],
      ["adapter:spark-x-agent/chat.ask", "main"],
      ["adapter:spark-x-agent/chat.assert-history", "main"],
      ["adapter:spark-x-agent/conversation.delete", "finally"],
    ]);
  });

  it("routes one bounded Spark X Agent tool call through hash-linked history and cleanup", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000121";
    const password = "tool-password-that-must-not-persist";
    const marker = `spark-x-tool-${job.runId}:42`;
    const message = `自动化回归 ${job.runId}：只调用一次 builtin-demo__calculator 计算 6×7，并回复 ${marker}。`;
    const assistantContent = `计算完成，${marker}`;
    const argumentsValue = { operation: "multiply", a: 6, b: 7 };
    const resultValue = { success: true, operation: "multiply", a: 6, b: 7, result: 42 };
    const assistantHash = createHash("sha256").update(assistantContent).digest("hex");
    const argumentsHash = hashCanonical(argumentsValue);
    const resultHash = hashCanonical(resultValue);
    const executionSnapshot: RunExecutionSnapshot = {
      ...snapshot({
        inputs: [
          { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
          { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
        ],
        execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 15_000, diagnosticRetries: 0 },
        resourceLocks: ["spark-x-agent:admin:tools"],
        steps: [
          {
            id: "create-conversation",
            action: "adapter:spark-x-agent/conversation.create",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              title: "spark-x-tool-${run.id}",
            },
            capture: { "conversation-id": "$.conversationId" },
            resource: {
              type: "spark-x-agent-conversation",
              id: "${step.conversation-id}",
              cleanup: {
                action: "adapter:spark-x-agent/conversation.delete",
                params: {
                  username: "${case.admin-username}",
                  password: "${case.admin-password}",
                  conversationId: "${resource.id}",
                },
              },
            },
          },
          {
            id: "invoke-safe-tool",
            action: "adapter:spark-x-agent/tool.invoke-safe",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
              message:
                "自动化回归 ${run.id}：只调用一次 builtin-demo__calculator 计算 6×7，并回复 spark-x-tool-${run.id}:42。",
              expectedText: "spark-x-tool-${run.id}:42",
              expectedToolName: "builtin-demo__calculator",
              expectedArgumentsJson: JSON.stringify(argumentsValue),
              expectedResultJson: JSON.stringify(resultValue),
            },
            capture: {
              "assistant-sha256": "$.finalContentSha256",
              "arguments-sha256": "$.argumentsSha256",
              "result-sha256": "$.resultSha256",
            },
          },
          {
            id: "assert-tool-history",
            action: "adapter:spark-x-agent/tool.assert-history",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
              expectedUserText:
                "自动化回归 ${run.id}：只调用一次 builtin-demo__calculator 计算 6×7，并回复 spark-x-tool-${run.id}:42。",
              expectedAssistantText: "spark-x-tool-${run.id}:42",
              expectedAssistantSha256: "${step.assistant-sha256}",
              expectedToolName: "builtin-demo__calculator",
              expectedArgumentsSha256: "${step.arguments-sha256}",
              expectedResultSha256: "${step.result-sha256}",
            },
          },
        ],
        finally: [
          {
            id: "delete-conversation",
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
            },
          },
        ],
      }),
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/"],
          },
        ],
      },
    };
    const store = fakeStore(executionSnapshot);
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": password,
    });
    const tokenResponse = (): Response =>
      new Response(
        JSON.stringify({ success: true, data: { token: "adapter-memory-only-token-value" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const responses = [
      tokenResponse(),
      new Response(
        JSON.stringify({
          success: true,
          data: { id: conversationId, title: `spark-x-tool-${job.runId}` },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      tokenResponse(),
      new Response(
        [
          { event: "conversation_id", data: { conversation_id: conversationId } },
          {
            event: "tool_call",
            data: {
              id: "call-worker-safe-1",
              name: "builtin-demo__calculator",
              arguments: argumentsValue,
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-worker-safe-1",
              name: "builtin-demo__calculator",
              result: resultValue,
              success: true,
            },
          },
          { event: "content", data: { content: assistantContent } },
          {
            event: "done",
            data: { final_content: assistantContent, truncated: false, stop_reason: "stop" },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      tokenResponse(),
      new Response(
        JSON.stringify({
          success: true,
          data: {
            items: [
              { role: "user", content: message, payload_truncated: false },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-worker-safe-1",
                    type: "function",
                    function: {
                      name: "builtin-demo__calculator",
                      arguments: JSON.stringify(argumentsValue),
                    },
                  },
                ],
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_call",
                    id: "call-worker-safe-1",
                    name: "builtin-demo__calculator",
                    arguments: argumentsValue,
                  },
                ],
              },
              {
                role: "tool",
                content: JSON.stringify(resultValue),
                tool_call_id: "call-worker-safe-1",
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_result",
                    id: "call-worker-safe-1",
                    name: "builtin-demo__calculator",
                    result: resultValue,
                    success: true,
                  },
                ],
              },
              {
                role: "assistant",
                content: assistantContent,
                payload_truncated: false,
                finish_reason: "stop",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      tokenResponse(),
      new Response(JSON.stringify({ success: true, message: "deleted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(responses.shift() as Response)),
    );

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { passed: 1 },
    });

    const evidence = JSON.stringify(vi.mocked(store.recordStep).mock.calls);
    expect(evidence).toContain(assistantHash);
    expect(evidence).toContain(argumentsHash);
    expect(evidence).toContain(resultHash);
    expect(evidence).not.toContain(assistantContent);
    expect(evidence).not.toContain(JSON.stringify(argumentsValue));
    expect(evidence).not.toContain(JSON.stringify(resultValue));
    expect(evidence).not.toContain(password);
    expect(evidence).not.toContain("adapter-memory-only-token-value");
    expect(vi.mocked(store.registerResource).mock.calls[0]?.[1]).toMatchObject({
      resourceType: "spark-x-agent-conversation",
      systemResourceId: conversationId,
    });
    expect(
      vi.mocked(store.recordStep).mock.calls.map(([, input]) => [input.action, input.phase]),
    ).toEqual([
      ["adapter:spark-x-agent/conversation.create", "main"],
      ["adapter:spark-x-agent/tool.invoke-safe", "main"],
      ["adapter:spark-x-agent/tool.assert-history", "main"],
      ["adapter:spark-x-agent/conversation.delete", "finally"],
    ]);
  });

  it("runs the fixed knowledge-base fixture through version evidence and full cleanup", async () => {
    const store = fakeStore(knowledgeBaseSnapshot());
    const password = "knowledge-worker-password";
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": password,
    });
    const fixtureBackend = knowledgeBaseFetchMock();
    vi.stubGlobal("fetch", fixtureBackend.fetchMock);

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { passed: 1 },
    });

    expect(fixtureBackend.fixture()?.text).toContain("SPARK_X_KB_FIXTURE");
    expect(vi.mocked(store.registerResource).mock.calls[0]?.[1]).toMatchObject({
      resourceType: "spark-x-agent-knowledge-base",
      systemResourceId: "00000000-0000-4000-8000-000000000130",
      cleanupDefinition: {
        action: "adapter:spark-x-agent/knowledge-base.cleanup",
      },
    });
    expect(
      vi
        .mocked(store.recordStep)
        .mock.calls.map(([, input]) => [input.action, input.phase, input.status]),
    ).toEqual([
      ["adapter:spark-x-agent/knowledge-base.create", "main", "passed"],
      ["adapter:spark-x-agent/knowledge-base.upload-fixture", "main", "passed"],
      ["adapter:spark-x-agent/knowledge-base.attach-upload", "main", "passed"],
      ["adapter:spark-x-agent/knowledge-base.wait-ready", "main", "passed"],
      ["adapter:spark-x-agent/knowledge-base.cleanup", "finally", "passed"],
    ]);
    const evidence = JSON.stringify(vi.mocked(store.recordStep).mock.calls);
    expect(evidence).toContain(fixtureBackend.fixture()?.sha256);
    expect(evidence).not.toContain("SPARK_X_KB_FIXTURE");
    expect(evidence).not.toContain("B2C-KB-001");
    expect(evidence).not.toContain("X-Amz-Signature");
    expect(evidence).not.toContain("kb-secret");
    expect(evidence).not.toContain(password);
    expect(evidence).not.toContain("kb-memory-only-token-value");
  });

  it("records only hashed evidence for the trusted Skill publication projection", async () => {
    const prompt = "Trusted Skill runtime prompt that must never enter persisted step evidence.";
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const skillId = "00000000-0000-4000-8000-000000000133";
    const projection = {
      id: skillId,
      name: "trade-port-daily-brief",
      display_name: "贸易与港口每日简报",
      description: "trusted fixture",
      category: "行业研究",
      is_builtin: false,
      is_enabled: true,
      config: {
        prompt_template: prompt,
        source: "upload",
        main_file: "trade-port-daily-brief.md",
        durable_agent_task_v17: true,
      },
      assets: {
        root_exists: true,
        has_skill_md: true,
        main_file: "trade-port-daily-brief.md",
        asset_count: 1,
      },
    };
    const executionSnapshot: RunExecutionSnapshot = {
      ...snapshot({
        execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 15_000, diagnosticRetries: 0 },
        inputs: [
          { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
          { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
        ],
        steps: [
          {
            id: "assert-trusted-publication",
            action: "adapter:spark-x-agent/skill.assert-trusted-publication",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              expectedPublicationSha256: promptSha256,
            },
          },
        ],
      }),
      suite: {
        id: "00000000-0000-4000-8000-000000000103",
        name: "Skill P0",
        diagnosticRetries: 0,
      },
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/"],
          },
        ],
      },
    };
    const store = fakeStore(executionSnapshot);
    const password = "skill-worker-password";
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": password,
    });
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const responses = [
      json({ success: true, data: { token: "skill-memory-only-token-value" } }),
      json({ success: true, data: [projection] }),
      json({ success: true, data: projection }),
      json({ success: true, data: { items: [projection], total: 1, page: 1, per_page: 100 } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(responses.shift() as Response)),
    );

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { passed: 1 },
    });
    expect(vi.mocked(store.registerResource)).not.toHaveBeenCalled();
    const evidence = JSON.stringify(vi.mocked(store.recordStep).mock.calls);
    expect(evidence).toContain(promptSha256);
    expect(evidence).not.toContain(prompt);
    expect(evidence).not.toContain(password);
    expect(evidence).not.toContain("skill-memory-only-token-value");
  });

  it("preserves the first parser environment failure and still performs full knowledge cleanup", async () => {
    const store = fakeStore(knowledgeBaseSnapshot());
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": "knowledge-failure-password",
    });
    const fixtureBackend = knowledgeBaseFetchMock(true);
    vi.stubGlobal("fetch", fixtureBackend.fetchMock);

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { environmentFailed: 1, infrastructureFailed: 0 },
    });

    expect(store.finishCase).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      "environment_failed",
      "passed",
      expect.objectContaining({
        code: "SPARK_X_AGENT_KNOWLEDGE_REFRESH_FAILED",
        stepId: "wait-ready",
      }),
      expect.any(Number),
      false,
    );
    expect(
      vi.mocked(store.recordStep).mock.calls.map(([, input]) => [input.action, input.status]),
    ).toEqual([
      ["adapter:spark-x-agent/knowledge-base.create", "passed"],
      ["adapter:spark-x-agent/knowledge-base.upload-fixture", "passed"],
      ["adapter:spark-x-agent/knowledge-base.attach-upload", "passed"],
      ["adapter:spark-x-agent/knowledge-base.wait-ready", "failed"],
      ["adapter:spark-x-agent/knowledge-base.cleanup", "passed"],
    ]);
  });

  it("preserves a missing safe-tool fixture as an environment failure and still cleans the conversation", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000122";
    const executionSnapshot: RunExecutionSnapshot = {
      ...snapshot({
        execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 15_000, diagnosticRetries: 0 },
        inputs: [
          { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
          { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
        ],
        resourceLocks: ["spark-x-agent:admin:tools"],
        steps: [
          {
            id: "create-conversation",
            action: "adapter:spark-x-agent/conversation.create",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              title: "spark-x-tool-${run.id}",
            },
            capture: { "conversation-id": "$.conversationId" },
            resource: {
              type: "spark-x-agent-conversation",
              id: "${step.conversation-id}",
              cleanup: {
                action: "adapter:spark-x-agent/conversation.delete",
                params: {
                  username: "${case.admin-username}",
                  password: "${case.admin-password}",
                  conversationId: "${resource.id}",
                },
              },
            },
          },
          {
            id: "assert-safe-tool-precondition",
            action: "adapter:spark-x-agent/tool.assert-safe-catalog",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
            },
          },
        ],
        finally: [
          {
            id: "delete-conversation",
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
            },
          },
        ],
      }),
      suite: {
        id: "00000000-0000-4000-8000-000000000103",
        name: "Core regression",
        diagnosticRetries: 0,
      },
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/"],
          },
        ],
      },
    };
    const store = fakeStore(executionSnapshot);
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": "fixture-cleanup-password",
    });
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const responses = [
      json({ success: true, data: { token: "adapter-memory-only-token-value" } }),
      json({
        success: true,
        data: { id: conversationId, title: `spark-x-tool-${job.runId}` },
      }),
      json({ success: true, data: { token: "adapter-memory-only-token-value" } }),
      json({ success: true, data: { items: [] } }),
      json({ success: true, data: { token: "adapter-memory-only-token-value" } }),
      json({ success: true, message: "deleted" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(responses.shift() as Response)),
    );

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { environmentFailed: 1, infrastructureFailed: 0 },
    });

    expect(store.finishCase).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      "environment_failed",
      "passed",
      expect.objectContaining({
        code: "SPARK_X_AGENT_SAFE_TOOL_CATALOG_UNAVAILABLE",
        stepId: "assert-safe-tool-precondition",
      }),
      expect.any(Number),
      false,
    );
    expect(vi.mocked(store.registerResource).mock.calls[0]?.[1]).toMatchObject({
      systemResourceId: conversationId,
    });
    expect(
      vi.mocked(store.recordStep).mock.calls.map(([, input]) => [input.action, input.status]),
    ).toEqual([
      ["adapter:spark-x-agent/conversation.create", "passed"],
      ["adapter:spark-x-agent/tool.assert-safe-catalog", "failed"],
      ["adapter:spark-x-agent/conversation.delete", "passed"],
    ]);
  });

  it("preserves an incomplete chat-stream failure while cleaning the pre-registered conversation", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000120";
    const executionSnapshot: RunExecutionSnapshot = {
      ...snapshot({
        execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 15_000, diagnosticRetries: 0 },
        inputs: [
          { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
          { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
        ],
        resourceLocks: ["spark-x-agent:admin:chat"],
        steps: [
          {
            id: "create-conversation",
            action: "adapter:spark-x-agent/conversation.create",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              title: "spark-x-chat-${run.id}",
            },
            capture: { "conversation-id": "$.conversationId" },
            resource: {
              type: "spark-x-agent-conversation",
              id: "${step.conversation-id}",
              cleanup: {
                action: "adapter:spark-x-agent/conversation.delete",
                params: {
                  username: "${case.admin-username}",
                  password: "${case.admin-password}",
                  conversationId: "${resource.id}",
                },
              },
            },
          },
          {
            id: "ask",
            action: "adapter:spark-x-agent/chat.ask",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
              message: "spark-x-chat-${run.id}",
              expectedText: "spark-x-chat-${run.id}",
            },
          },
        ],
        finally: [
          {
            id: "delete-conversation",
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${step.conversation-id}",
            },
          },
        ],
      }),
      suite: {
        id: "00000000-0000-4000-8000-000000000103",
        name: "Core regression",
        diagnosticRetries: 0,
      },
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/"],
          },
        ],
      },
    };
    const store = fakeStore(executionSnapshot);
    vi.mocked(store.resolveSecretVariables).mockResolvedValue({
      "case.admin-username": "admin",
      "case.admin-password": "failure-cleanup-password",
    });
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const responses = [
      json({ success: true, data: { token: "adapter-memory-only-token-value" } }),
      json({
        success: true,
        data: { id: conversationId, title: `spark-x-chat-${job.runId}` },
      }),
      json({ success: true, data: { token: "adapter-memory-only-token-value" } }),
      new Response(
        [
          { event: "conversation_id", data: { conversation_id: conversationId } },
          { event: "content", data: { content: "partial" } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      json({ success: true, data: { token: "adapter-memory-only-token-value" } }),
      json({ success: true, message: "deleted" }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(responses.shift() as Response)),
    );

    await expect(executeRunJob(job, "worker-1", store)).resolves.toMatchObject({
      summary: { productFailed: 1 },
    });

    expect(store.finishCase).toHaveBeenCalledWith(
      job.runId,
      "00000000-0000-4000-8000-000000000104",
      "product_failed",
      "passed",
      expect.objectContaining({
        code: "SPARK_X_AGENT_CHAT_STREAM_INCOMPLETE",
        stepId: "ask",
      }),
      expect.any(Number),
      false,
    );
    expect(vi.mocked(store.registerResource).mock.calls[0]?.[1]).toMatchObject({
      systemResourceId: conversationId,
    });
    expect(
      vi.mocked(store.recordStep).mock.calls.map(([, input]) => [input.action, input.status]),
    ).toEqual([
      ["adapter:spark-x-agent/conversation.create", "passed"],
      ["adapter:spark-x-agent/chat.ask", "failed"],
      ["adapter:spark-x-agent/conversation.delete", "passed"],
    ]);
  });

  it("re-authenticates Spark X Agent cleanup from persisted resource data", async () => {
    const cleanupJob = {
      protocolVersion: "1.0" as const,
      cleanupJobId: "00000000-0000-4000-8000-000000000110",
      runId: job.runId,
      queuedAt: new Date(0).toISOString(),
    };
    const definition = {
      inputs: [
        { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
        { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
      ],
      steps: [],
    };
    const compensationSnapshot: RunExecutionSnapshot = {
      ...snapshot(definition),
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/"],
          },
        ],
      },
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
          snapshot: compensationSnapshot,
        }),
      ),
      resolveSecretVariables: vi.fn(() =>
        Promise.resolve({
          "case.admin-username": "admin",
          "case.admin-password": "compensation-password",
        }),
      ),
      listResourcesForCleanup: vi.fn(() =>
        Promise.resolve([
          {
            id: "00000000-0000-4000-8000-000000000111",
            runCaseId: "00000000-0000-4000-8000-000000000104",
            systemResourceId: "00000000-0000-4000-8000-000000000112",
            cleanupDefinition: {
              action: "adapter:spark-x-agent/conversation.delete",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                conversationId: "${resource.id}",
              },
            },
          },
        ]),
      ),
      markResourceCleanup: vi.fn(() => Promise.resolve()),
      renewResourceLocks: vi.fn(() => Promise.resolve()),
      failCleanupJob: vi.fn(() => Promise.resolve()),
      completeCompensation: vi.fn(() => Promise.resolve()),
    } as unknown as CompensationExecutionStore;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { token: "compensation-memory-token" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeCompensationJob(cleanupJob, store)).resolves.toEqual({
      cleaned: 1,
    });
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).toBe(
      "http://192.168.110.136/trade/api/conversations/00000000-0000-4000-8000-000000000112",
    );
    expect(store.markResourceCleanup).toHaveBeenLastCalledWith(
      "00000000-0000-4000-8000-000000000111",
      "passed",
    );
  });

  it("runs unified knowledge-base cleanup from the persisted resource ledger", async () => {
    const cleanupJob = {
      protocolVersion: "1.0" as const,
      cleanupJobId: "00000000-0000-4000-8000-000000000140",
      runId: job.runId,
      queuedAt: new Date(0).toISOString(),
    };
    const knowledgeBaseId = "00000000-0000-4000-8000-000000000141";
    const knowledgeDocumentId = "00000000-0000-4000-8000-000000000142";
    const uploadedDocumentId = "00000000-0000-4000-8000-000000000143";
    const compensationSnapshot: RunExecutionSnapshot = {
      ...snapshot({
        inputs: [
          { name: "admin-username", secretRef: "spark-x-agent-admin-username" },
          { name: "admin-password", secretRef: "spark-x-agent-admin-password" },
        ],
        steps: [],
      }),
      environment: {
        id: "00000000-0000-4000-8000-000000000102",
        baseUrl: "http://192.168.110.136/trade/",
        actionLevel: "dangerous",
        adapterKey: "spark-x-agent",
        allowlist: [
          {
            protocol: "http",
            host: "192.168.110.136",
            ports: [80],
            pathPrefixes: ["/trade/", "/trade-domain-api/"],
          },
        ],
      },
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
          snapshot: compensationSnapshot,
        }),
      ),
      resolveSecretVariables: vi.fn(() =>
        Promise.resolve({
          "case.admin-username": "admin",
          "case.admin-password": "knowledge-compensation-password",
        }),
      ),
      listResourcesForCleanup: vi.fn(() =>
        Promise.resolve([
          {
            id: "00000000-0000-4000-8000-000000000144",
            runCaseId: "00000000-0000-4000-8000-000000000104",
            systemResourceId: knowledgeBaseId,
            cleanupDefinition: {
              action: "adapter:spark-x-agent/knowledge-base.cleanup",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                knowledgeBaseId: "${resource.id}",
              },
            },
          },
        ]),
      ),
      markResourceCleanup: vi.fn(() => Promise.resolve()),
      renewResourceLocks: vi.fn(() => Promise.resolve()),
      failCleanupJob: vi.fn(() => Promise.resolve()),
      completeCompensation: vi.fn(() => Promise.resolve()),
    } as unknown as CompensationExecutionStore;
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const responses = [
      json({ success: true, data: { token: "knowledge-compensation-token" } }),
      json({
        success: true,
        data: { items: [{ id: knowledgeDocumentId, status: "completed" }] },
      }),
      json({ success: true, data: {} }),
      json({
        success: true,
        data: {
          id: uploadedDocumentId,
          name: "fixture.pdf",
          size_bytes: 100,
          content_sha256: "a".repeat(64),
        },
      }),
      json({ success: true, data: {} }),
      json({ success: true, data: {} }),
    ];
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(responses.shift() as Response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeCompensationJob(cleanupJob, store)).resolves.toEqual({ cleaned: 1 });
    expect(fetchMock.mock.calls.slice(1).map((call) => requestUrl(call[0]))).toEqual([
      `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents?include_archived=true`,
      `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents/${knowledgeDocumentId}`,
      `http://192.168.110.136/trade/api/documents/upload-status/${knowledgeBaseId}`,
      `http://192.168.110.136/trade/api/documents/${uploadedDocumentId}`,
      `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}`,
    ]);
    expect(store.markResourceCleanup).toHaveBeenLastCalledWith(
      "00000000-0000-4000-8000-000000000144",
      "passed",
    );
  });
});
