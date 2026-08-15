import { createHmac } from "node:crypto";

import type { TestRunRecord } from "@spark-x-test/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApiApplication } from "./app.js";
import type { RunQueue, RunRouteStore } from "./run-routes.js";

const systemId = "00000000-0000-4000-8000-000000000201";
const environmentId = "00000000-0000-4000-8000-000000000202";
const suiteId = "00000000-0000-4000-8000-000000000203";
const runId = "00000000-0000-4000-8000-000000000204";
const secret = "release-hook-test-secret-32-bytes-minimum";
const testedVersion = "a".repeat(40);
const releaseTaskId = "job_1786763285133_52qxun";

const baseEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  REDIS_URL: "redis://127.0.0.1:1/0",
  MINIO_ENDPOINT: "127.0.0.1",
  MINIO_PORT: "1",
  MINIO_USE_SSL: "false",
  MINIO_ACCESS_KEY: "unused",
  MINIO_SECRET_KEY: "unused",
  MINIO_BUCKET: "unused",
};

const configuredEnvironment = {
  ...baseEnvironment,
  PLATFORM_RELEASE_WEBHOOK_SECRET: secret,
  PLATFORM_SPARK_X_AGENT_SYSTEM_ID: systemId,
  PLATFORM_SPARK_X_AGENT_ENVIRONMENT_ID: environmentId,
  PLATFORM_SPARK_X_AGENT_CORE_SUITE_ID: suiteId,
};

const applications: ReturnType<typeof buildApiApplication>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async ({ app }) => app.close()));
});

function payload(version = testedVersion) {
  return { event: "release.completed", releaseTaskId, testedVersion: version } as const;
}

function signedHeaders(
  body: ReturnType<typeof payload>,
  timestamp = Math.floor(Date.now() / 1_000),
) {
  const canonical = JSON.stringify({
    event: body.event,
    releaseTaskId: body.releaseTaskId,
    testedVersion: body.testedVersion,
  });
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${canonical}`, "utf8")
    .digest("hex");
  return {
    "x-spark-release-timestamp": String(timestamp),
    "x-spark-release-signature": `sha256=${signature}`,
  };
}

function queueAdd() {
  return vi.fn<RunQueue["add"]>(() => Promise.resolve());
}

function run(version = testedVersion): TestRunRecord {
  return {
    id: runId,
    sequenceNumber: 77,
    triggerType: "release",
    triggerSource: `youlan:${releaseTaskId}`,
    idempotencyKey: `spark-x-agent-release:${releaseTaskId}`,
    priority: 75,
    systemId,
    environmentId,
    suiteId,
    systemName: "Spark X Agent",
    environmentName: "Test",
    suiteName: "Core smoke",
    testedVersion: version,
    platformVersion: "0.1.0",
    status: "queued",
    gateResult: null,
    summary: {
      total: 9,
      queued: 9,
      running: 0,
      passed: 0,
      productFailed: 0,
      testFailed: 0,
      environmentFailed: 0,
      infrastructureFailed: 0,
      flaky: 0,
      cancelled: 0,
      skipped: 0,
    },
    cancellationRequested: false,
    firstFailure: null,
    workerId: null,
    workerImageDigest: null,
    executorVersion: null,
    queuedAt: new Date(0).toISOString(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(0).toISOString(),
  };
}

describe("Spark X Agent release hook", () => {
  it("authenticates and queues an immutable release-linked core smoke run", async () => {
    const createRun = vi.fn(() => Promise.resolve({ run: run(), created: true }));
    const add = queueAdd();
    const application = buildApiApplication(configuredEnvironment, {
      runStore: { createRun } as unknown as RunRouteStore,
      runQueue: { add } satisfies RunQueue,
    });
    applications.push(application);
    const body = payload();

    const response = await application.app.inject({
      method: "POST",
      url: "/api/v1/release-hooks/spark-x-agent",
      payload: body,
      headers: signedHeaders(body),
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      event: "release.completed",
      releaseTaskId,
      testedVersion,
      duplicate: false,
      run: { id: runId, triggerType: "release", testedVersion },
    });
    expect(createRun).toHaveBeenCalledWith({
      triggerType: "release",
      triggerSource: `youlan:${releaseTaskId}`,
      idempotencyKey: `spark-x-agent-release:${releaseTaskId}`,
      priority: 75,
      systemId,
      environmentId,
      suiteId,
      testedVersion,
    });
    expect(add).toHaveBeenCalledWith(
      "run.execute",
      expect.objectContaining({ runId, priority: 75 }),
      expect.objectContaining({ jobId: runId, attempts: 1 }),
    );
  });

  it("returns the same run for a duplicate callback and reuses the same queue job ID", async () => {
    const existingRun = run();
    const createRun = vi
      .fn()
      .mockResolvedValueOnce({ run: existingRun, created: true })
      .mockResolvedValueOnce({ run: existingRun, created: false });
    const add = queueAdd();
    const application = buildApiApplication(configuredEnvironment, {
      runStore: { createRun } as unknown as RunRouteStore,
      runQueue: { add } satisfies RunQueue,
    });
    applications.push(application);
    const body = payload();

    const first = await application.app.inject({
      method: "POST",
      url: "/api/v1/release-hooks/spark-x-agent",
      payload: body,
      headers: signedHeaders(body),
    });
    const duplicate = await application.app.inject({
      method: "POST",
      url: "/api/v1/release-hooks/spark-x-agent",
      payload: body,
      headers: signedHeaders(body),
    });

    expect(first.statusCode).toBe(202);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true, run: { id: runId } });
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ jobId: runId }),
      expect.objectContaining({ jobId: runId }),
    ]);
  });

  it("rejects a release task that is reused for another tested commit", async () => {
    const createRun = vi.fn(() => Promise.resolve({ run: run(), created: false }));
    const add = queueAdd();
    const application = buildApiApplication(configuredEnvironment, {
      runStore: { createRun } as unknown as RunRouteStore,
      runQueue: { add } satisfies RunQueue,
    });
    applications.push(application);
    const body = payload("b".repeat(40));

    const response = await application.app.inject({
      method: "POST",
      url: "/api/v1/release-hooks/spark-x-agent",
      payload: body,
      headers: signedHeaders(body),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "RELEASE_HOOK_CONFLICT" });
    expect(add).not.toHaveBeenCalled();
  });

  it.each([
    ["missing signature", undefined, 0],
    ["invalid signature", "sha256=" + "0".repeat(64), 0],
    ["stale timestamp", undefined, 301],
  ])("rejects %s before persistence", async (_name, signature, ageSeconds) => {
    const createRun = vi.fn();
    const application = buildApiApplication(configuredEnvironment, {
      runStore: { createRun } as unknown as RunRouteStore,
    });
    applications.push(application);
    const body = payload();
    const timestamp = Math.floor(Date.now() / 1_000) - ageSeconds;
    const headers: Record<string, string> = signedHeaders(body, timestamp);
    if (signature === undefined && ageSeconds === 0) {
      delete headers["x-spark-release-signature"];
    } else if (signature !== undefined) {
      headers["x-spark-release-signature"] = signature;
    }

    const response = await application.app.inject({
      method: "POST",
      url: "/api/v1/release-hooks/spark-x-agent",
      payload: body,
      headers,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "RELEASE_HOOK_UNAUTHORIZED" });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("fails closed when the release hook is not configured", async () => {
    const createRun = vi.fn();
    const application = buildApiApplication(baseEnvironment, {
      runStore: { createRun } as unknown as RunRouteStore,
    });
    applications.push(application);
    const body = payload();

    const response = await application.app.inject({
      method: "POST",
      url: "/api/v1/release-hooks/spark-x-agent",
      payload: body,
      headers: signedHeaders(body),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "RELEASE_HOOK_DISABLED" });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("fails startup for partial or weak release hook configuration", () => {
    expect(() =>
      buildApiApplication({
        ...baseEnvironment,
        PLATFORM_RELEASE_WEBHOOK_SECRET: "too-short",
        PLATFORM_SPARK_X_AGENT_SYSTEM_ID: systemId,
        PLATFORM_SPARK_X_AGENT_ENVIRONMENT_ID: environmentId,
        PLATFORM_SPARK_X_AGENT_CORE_SUITE_ID: suiteId,
      }),
    ).toThrow("at least 32 UTF-8 bytes");
    expect(() =>
      buildApiApplication({
        ...baseEnvironment,
        PLATFORM_RELEASE_WEBHOOK_SECRET: secret,
      }),
    ).toThrow("configuration must be complete");
  });
});
