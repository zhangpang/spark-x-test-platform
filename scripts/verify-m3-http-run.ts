import { randomBytes, randomUUID } from "node:crypto";

import { Queue } from "bullmq";
import { Pool } from "pg";

interface RecordWithId {
  readonly id: string;
}

interface CaseRecord extends RecordWithId {
  readonly currentDraftVersionId: string;
}

interface RunRecord extends RecordWithId {
  readonly status: string;
  readonly gateResult: string | null;
  readonly summary: Readonly<Record<string, number>>;
  readonly firstFailure: Readonly<{ code: string }> | null;
  readonly cases: readonly Readonly<{
    result: string | null;
    cleanupStatus: string;
  }>[];
  readonly steps: readonly Readonly<{
    status: string;
    phase: string;
    action: string;
    outputSummary: Readonly<Record<string, unknown>> | null;
  }>[];
  readonly resources: readonly Readonly<{
    cleanupStatus: string;
    systemResourceId: string;
  }>[];
  readonly cleanupJob: Readonly<{
    id: string;
    status: string;
    attempts: number;
    lastError: Readonly<{
      code: string;
      message: string;
      classification: string;
    }> | null;
  }> | null;
}

const apiBase = process.env.M3_SMOKE_API_URL ?? "http://127.0.0.1:4100/api/v1";
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL is required");
const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined || redisUrl === "") throw new Error("REDIS_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const cleanupQueue = new Queue(`${process.env.PLATFORM_QUEUE_NAME ?? "test-runs"}-cleanup`, {
  connection: { url: redisUrl },
});
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const createdIds: string[] = [];
let systemId: string | undefined;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function api<T>(
  path: string,
  options: Readonly<{
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  }> = {},
): Promise<Readonly<{ status: number; body: T }>> {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": options.idempotencyKey }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const body = (text === "" ? null : JSON.parse(text)) as T;
  if (!response.ok) throw new Error(`API ${path} returned HTTP ${response.status}: ${text}`);
  return { status: response.status, body };
}

function httpDefinition(
  systemKey: string,
  moduleKey: string,
  name: string,
  expectedStatus: number,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name,
      systemKey,
      moduleKey,
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      tags: ["m3-smoke", "http"],
    },
    inputs: [
      {
        name: "smoke-token",
        type: "string",
        required: true,
        secretRef: "m3-smoke-token",
      },
    ],
    execution: {
      stepTimeoutMs: 5_000,
      caseTimeoutMs: 15_000,
      diagnosticRetries: 0,
    },
    resourceLocks: [],
    steps: [
      {
        id: "api-health",
        name: "读取 API 健康状态",
        kind: "action",
        action: "http:request",
        params: {
          method: "GET",
          path: "/api/v1/healthz",
          headers: { "x-m3-smoke-token": "${case.smoke-token}" },
        },
        capture: { "response-status": "$.status", "response-body": "$.body" },
        assertions: [
          {
            type: "status:equals",
            actual: "${step.response-status}",
            expected: expectedStatus,
            severity: "hard",
          },
        ],
      },
    ],
    finally: [],
  };
}

function waitHttpDefinition(
  systemKey: string,
  moduleKey: string,
  name: string,
  expectedStatus: number,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name,
      systemKey,
      moduleKey,
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      tags: ["m3-smoke", "wait-http"],
    },
    inputs: [
      {
        name: "smoke-token",
        type: "string",
        required: true,
        secretRef: "m3-smoke-token",
      },
    ],
    execution: {
      stepTimeoutMs: expectedStatus === 200 ? 2_000 : 400,
      caseTimeoutMs: expectedStatus === 200 ? 3_000 : 1_000,
      diagnosticRetries: 0,
    },
    resourceLocks: [],
    steps: [
      {
        id: "wait-api-health",
        name: "轮询 API 健康状态",
        kind: "action",
        action: "wait:http",
        params: {
          path: "/api/v1/healthz",
          headers: { "x-m3-smoke-token": "${case.smoke-token}" },
          intervalMs: 100,
          condition: { path: "$.status", operator: "equals", expected: expectedStatus },
        },
        capture: { "response-status": "$.lastResponse.status" },
        assertions: [],
      },
    ],
    finally: [],
  };
}

async function createPublishedCase(
  moduleId: string,
  environmentId: string,
  systemKey: string,
  moduleKey: string,
  name: string,
  expectedStatus: number,
): Promise<string> {
  const created = await api<CaseRecord>("/test-cases", {
    method: "POST",
    body: {
      moduleId,
      definition: httpDefinition(systemKey, moduleKey, name, expectedStatus),
      changeNote: "M3 release smoke",
    },
  });
  createdIds.push(created.body.id, created.body.currentDraftVersionId);
  const validation = await api<{ readonly valid: boolean }>(
    `/test-case-versions/${created.body.currentDraftVersionId}/validations`,
    { method: "POST", body: { environmentId } },
  );
  check(validation.body.valid, `${name} did not pass static validation`);
  await api(`/test-cases/${created.body.id}/publish`, {
    method: "POST",
    body: { versionId: created.body.currentDraftVersionId },
  });
  return created.body.id;
}

async function createPublishedWaitCase(
  moduleId: string,
  environmentId: string,
  systemKey: string,
  moduleKey: string,
  name: string,
  expectedStatus: number,
): Promise<string> {
  const created = await api<CaseRecord>("/test-cases", {
    method: "POST",
    body: {
      moduleId,
      definition: waitHttpDefinition(systemKey, moduleKey, name, expectedStatus),
      changeNote: "M3 wait executor release smoke",
    },
  });
  createdIds.push(created.body.id, created.body.currentDraftVersionId);
  const validation = await api<{ readonly valid: boolean }>(
    `/test-case-versions/${created.body.currentDraftVersionId}/validations`,
    { method: "POST", body: { environmentId } },
  );
  check(validation.body.valid, `${name} did not pass static validation`);
  await api(`/test-cases/${created.body.id}/publish`, {
    method: "POST",
    body: { versionId: created.body.currentDraftVersionId },
  });
  return created.body.id;
}

async function createPublishedResourceCase(
  moduleId: string,
  environmentId: string,
  systemKey: string,
  moduleKey: string,
): Promise<string> {
  const definition = {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "M3 compensation recovery",
      systemKey,
      moduleKey,
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      tags: ["m3-smoke", "resource-safety"],
    },
    inputs: [],
    execution: {
      stepTimeoutMs: 5_000,
      caseTimeoutMs: 15_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["m3-resource:${run.id}"],
    steps: [
      {
        id: "register-resource",
        name: "登记合成外部资源",
        kind: "action",
        action: "http:request",
        params: { method: "GET", path: "/api/v1/healthz" },
        resource: {
          type: "m3-smoke-resource",
          id: "${run.id}",
          cleanup: {
            action: "http:request",
            params: {
              method: "GET",
              path: "/api/v1/healthz?resource=${resource.id}",
            },
          },
        },
      },
    ],
    finally: [
      {
        id: "force-compensation",
        name: "模拟首次清理失败",
        kind: "action",
        action: "http:request",
        params: { method: "GET", path: "/api/v1/healthz" },
        capture: { "cleanup-status": "$.status" },
        assertions: [
          {
            type: "status:equals",
            actual: "${step.cleanup-status}",
            expected: 204,
            severity: "hard",
          },
        ],
      },
    ],
  };
  const created = await api<CaseRecord>("/test-cases", {
    method: "POST",
    body: { moduleId, definition, changeNote: "M3 resource safety release smoke" },
  });
  createdIds.push(created.body.id, created.body.currentDraftVersionId);
  const validation = await api<{ readonly valid: boolean }>(
    `/test-case-versions/${created.body.currentDraftVersionId}/validations`,
    { method: "POST", body: { environmentId } },
  );
  check(validation.body.valid, "resource compensation case did not pass static validation");
  await api(`/test-cases/${created.body.id}/publish`, {
    method: "POST",
    body: { versionId: created.body.currentDraftVersionId },
  });
  return created.body.id;
}

async function waitForRun(id: string): Promise<RunRecord> {
  const deadline = Date.now() + 30_000;
  let lastRun: RunRecord | undefined;
  while (Date.now() < deadline) {
    const run = (await api<RunRecord>(`/runs/${id}`)).body;
    lastRun = run;
    if (run.status === "completed") return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const diagnostic =
    lastRun === undefined
      ? { status: "not-observed" }
      : {
          status: lastRun.status,
          gateResult: lastRun.gateResult,
          summary: lastRun.summary,
          firstFailure: lastRun.firstFailure,
          cases: lastRun.cases,
          resources: lastRun.resources,
          cleanupJob: lastRun.cleanupJob,
        };
  let queueDiagnostic: Readonly<Record<string, unknown>> = { inspected: false };
  if (lastRun?.cleanupJob !== null && lastRun?.cleanupJob !== undefined) {
    try {
      const queuedJob = await cleanupQueue.getJob(lastRun.cleanupJob.id);
      queueDiagnostic =
        queuedJob === undefined
          ? { inspected: true, present: false }
          : {
              inspected: true,
              present: true,
              state: await queuedJob.getState(),
              attemptsMade: queuedJob.attemptsMade,
              failedReason: queuedJob.failedReason || null,
              workerCount: (await cleanupQueue.getWorkers()).length,
            };
    } catch {
      queueDiagnostic = { inspected: false, error: "queue-diagnostic-unavailable" };
    }
  }
  throw new Error(
    `run ${id} did not complete within 30 seconds: ${JSON.stringify({ ...diagnostic, queueDiagnostic })}`,
  );
}

async function createRun(
  suiteId: string,
  environmentId: string,
  idempotencyKey: string,
): Promise<Readonly<{ status: number; body: RunRecord }>> {
  if (systemId === undefined) throw new Error("smoke system has not been created");
  return api<RunRecord>("/runs", {
    method: "POST",
    idempotencyKey,
    body: {
      systemId,
      suiteId,
      environmentId,
      triggerType: "release",
      triggerSource: "m3-release-smoke",
      priority: 90,
      testedVersion: process.env.PLATFORM_VERSION ?? "release-smoke",
    },
  });
}

async function cleanup(): Promise<void> {
  if (systemId === undefined) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from test_runs where system_id = $1", [systemId]);
    await client.query("delete from test_suites where system_id = $1", [systemId]);
    await client.query(
      `update test_cases set current_draft_version_id = null, current_published_version_id = null
       where module_id in (select id from modules where system_id = $1)`,
      [systemId],
    );
    await client.query(
      `delete from test_case_versions
       where case_id in (
         select tc.id from test_cases tc join modules m on m.id = tc.module_id
         where m.system_id = $1
       )`,
      [systemId],
    );
    await client.query(
      "delete from test_cases where module_id in (select id from modules where system_id = $1)",
      [systemId],
    );
    await client.query("delete from secrets where system_id = $1", [systemId]);
    await client.query("delete from environments where system_id = $1", [systemId]);
    await client.query("delete from modules where system_id = $1", [systemId]);
    await client.query("delete from operation_audits where object_id = any($1::uuid[])", [
      createdIds,
    ]);
    await client.query("delete from systems where id = $1", [systemId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

try {
  const systemKey = `m3-smoke-${suffix}`;
  const system = await api<RecordWithId>("/systems", {
    method: "POST",
    body: { key: systemKey, name: `M3 Smoke ${suffix}`, concurrencyLimit: 2 },
  });
  systemId = system.body.id;
  createdIds.push(systemId);

  const moduleKey = "http-core";
  const module = await api<RecordWithId>(`/systems/${systemId}/modules`, {
    method: "POST",
    body: { key: moduleKey, name: "HTTP Core", sortOrder: 0 },
  });
  createdIds.push(module.body.id);

  const environment = await api<RecordWithId>(`/systems/${systemId}/environments`, {
    method: "POST",
    body: {
      key: "test",
      name: "Container Test",
      kind: "test",
      baseUrl: "http://api:4100/api/v1/",
      actionLevel: "read",
      allowlist: [{ protocol: "http", host: "api", ports: [4100], pathPrefixes: ["/api/v1/"] }],
      timezone: "Asia/Shanghai",
      concurrencyLimit: 2,
    },
  });
  createdIds.push(environment.body.id);

  const syntheticSecret = `m3-${randomUUID()}-${randomUUID()}`;
  const secret = await api<RecordWithId>("/secrets", {
    method: "POST",
    body: {
      systemId,
      environmentId: environment.body.id,
      key: "m3-smoke-token",
      value: syntheticSecret,
    },
  });
  createdIds.push(secret.body.id);

  const passingCaseId = await createPublishedCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
    "M3 passing HTTP run",
    200,
  );
  const failingCaseId = await createPublishedCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
    "M3 product failure",
    599,
  );
  const resourceCaseId = await createPublishedResourceCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
  );
  const passingWaitCaseId = await createPublishedWaitCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
    "M3 passing HTTP wait",
    200,
  );
  const failingWaitCaseId = await createPublishedWaitCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
    "M3 HTTP wait timeout",
    599,
  );

  const passingSuite = await api<RecordWithId>("/test-suites", {
    method: "POST",
    body: {
      systemId,
      key: "passing-http",
      name: "Passing HTTP",
      caseIds: [passingCaseId],
      defaultConcurrency: 1,
      defaultDiagnosticRetries: 0,
    },
  });
  createdIds.push(passingSuite.body.id);
  const failingSuite = await api<RecordWithId>("/test-suites", {
    method: "POST",
    body: {
      systemId,
      key: "failing-http",
      name: "Failing HTTP",
      caseIds: [failingCaseId],
      defaultConcurrency: 1,
      defaultDiagnosticRetries: 0,
    },
  });
  createdIds.push(failingSuite.body.id);
  const resourceSuite = await api<RecordWithId>("/test-suites", {
    method: "POST",
    body: {
      systemId,
      key: "resource-compensation",
      name: "Resource compensation",
      caseIds: [resourceCaseId],
      defaultConcurrency: 1,
      defaultDiagnosticRetries: 0,
    },
  });
  createdIds.push(resourceSuite.body.id);
  const passingWaitSuite = await api<RecordWithId>("/test-suites", {
    method: "POST",
    body: {
      systemId,
      key: "passing-http-wait",
      name: "Passing HTTP wait",
      caseIds: [passingWaitCaseId],
      defaultConcurrency: 1,
      defaultDiagnosticRetries: 0,
    },
  });
  createdIds.push(passingWaitSuite.body.id);
  const failingWaitSuite = await api<RecordWithId>("/test-suites", {
    method: "POST",
    body: {
      systemId,
      key: "failing-http-wait",
      name: "Failing HTTP wait",
      caseIds: [failingWaitCaseId],
      defaultConcurrency: 1,
      defaultDiagnosticRetries: 0,
    },
  });
  createdIds.push(failingWaitSuite.body.id);

  const idempotencyKey = randomUUID();
  const accepted = await createRun(passingSuite.body.id, environment.body.id, idempotencyKey);
  check(accepted.status === 202, "new run was not accepted with HTTP 202");
  const duplicate = await createRun(passingSuite.body.id, environment.body.id, idempotencyKey);
  check(duplicate.status === 200, "duplicate idempotency key did not return HTTP 200");
  check(duplicate.body.id === accepted.body.id, "duplicate request created a different run");

  const passingRun = await waitForRun(accepted.body.id);
  check(passingRun.gateResult === "passed", "passing run gate was not passed");
  check(passingRun.summary.passed === 1, "passing run summary was not aggregated");
  check(passingRun.cases[0]?.cleanupStatus === "not_required", "cleanup status is incorrect");
  check(passingRun.steps[0]?.status === "passed", "passing step evidence is missing");
  check(!JSON.stringify(passingRun).includes(syntheticSecret), "secret leaked into run evidence");

  const events = await fetch(`${apiBase}/runs/${passingRun.id}/events?after=0`).then((response) =>
    response.text(),
  );
  check(events.includes("event: run.completed"), "SSE stream is missing run.completed");
  check(events.includes("event: step.completed"), "SSE stream is missing step.completed");
  check(!events.includes(syntheticSecret), "secret leaked into SSE events");

  const failed = await createRun(failingSuite.body.id, environment.body.id, randomUUID());
  const failingRun = await waitForRun(failed.body.id);
  check(failingRun.gateResult === "blocked", "product failure did not block the gate");
  check(failingRun.summary.productFailed === 1, "product failure summary is incorrect");
  check(
    failingRun.firstFailure?.code === "STATUS_ASSERTION_FAILED",
    "first product failure was not preserved",
  );

  const acceptedWait = await createRun(
    passingWaitSuite.body.id,
    environment.body.id,
    randomUUID(),
  );
  const passingWaitRun = await waitForRun(acceptedWait.body.id);
  check(passingWaitRun.gateResult === "passed", "passing wait run gate was not passed");
  check(passingWaitRun.summary.passed === 1, "passing wait run summary was not aggregated");
  check(passingWaitRun.steps[0]?.action === "wait:http", "wait step action evidence is missing");
  check(
    passingWaitRun.steps[0]?.outputSummary?.matched === true,
    "wait step did not persist its matched result",
  );
  check(
    Number(passingWaitRun.steps[0]?.outputSummary?.attempts) >= 1,
    "wait step did not persist its attempt count",
  );
  check(
    !JSON.stringify(passingWaitRun).includes(syntheticSecret),
    "secret leaked into wait evidence",
  );

  const failedWait = await createRun(
    failingWaitSuite.body.id,
    environment.body.id,
    randomUUID(),
  );
  const failingWaitRun = await waitForRun(failedWait.body.id);
  check(failingWaitRun.gateResult === "blocked", "wait timeout did not block the gate");
  check(
    failingWaitRun.summary.productFailed === 1,
    "wait timeout was not classified as product failure",
  );
  check(
    failingWaitRun.firstFailure?.code === "WAIT_CONDITION_TIMEOUT",
    "wait timeout did not preserve its stable root failure",
  );

  const compensated = await createRun(resourceSuite.body.id, environment.body.id, randomUUID());
  const compensatedRun = await waitForRun(compensated.body.id);
  check(compensatedRun.gateResult === "inconclusive", "cleanup failure gate was not inconclusive");
  check(
    compensatedRun.summary.infrastructureFailed === 1,
    "cleanup failure was not classified as infrastructure failure",
  );
  check(compensatedRun.cases[0]?.cleanupStatus === "failed", "original cleanup failure was lost");
  check(compensatedRun.resources.length === 1, "created resource was not registered");
  check(
    compensatedRun.resources[0]?.cleanupStatus === "passed",
    "compensation did not clean resource",
  );
  check(compensatedRun.cleanupJob?.status === "succeeded", "cleanup job did not succeed");
  check((compensatedRun.cleanupJob?.attempts ?? 0) >= 1, "cleanup attempt was not recorded");
  const releasedLock = await pool.query<{ readonly release_reason: string | null }>(
    `select release_reason from resource_locks
     where run_id = $1 order by acquired_at desc limit 1`,
    [compensatedRun.id],
  );
  check(
    releasedLock.rows[0]?.release_reason === "compensation_succeeded",
    "resource lock was not released by compensation",
  );

  console.info(
    JSON.stringify({
      status: "passed",
      scenario: "m3-http-run-evidence-loop",
      assertions: 34,
      passingRunId: passingRun.id,
      failingRunId: failingRun.id,
      passingWaitRunId: passingWaitRun.id,
      failingWaitRunId: failingWaitRun.id,
      compensatedRunId: compensatedRun.id,
    }),
  );
} finally {
  try {
    await cleanup();
  } finally {
    await Promise.all([pool.end(), cleanupQueue.close()]);
  }
}
