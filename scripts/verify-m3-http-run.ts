import { randomBytes, randomUUID } from "node:crypto";

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
  readonly steps: readonly Readonly<{ status: string; phase: string }>[];
}

const apiBase = process.env.M3_SMOKE_API_URL ?? "http://127.0.0.1:4100/api/v1";
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
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

async function waitForRun(id: string): Promise<RunRecord> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = (await api<RunRecord>(`/runs/${id}`)).body;
    if (run.status === "completed") return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`run ${id} did not complete within 30 seconds`);
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
      baseUrl: "http://api:4100/",
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

  console.info(
    JSON.stringify({
      status: "passed",
      scenario: "m3-http-run-evidence-loop",
      assertions: 17,
      passingRunId: passingRun.id,
      failingRunId: failingRun.id,
    }),
  );
} finally {
  try {
    await cleanup();
  } finally {
    await pool.end();
  }
}
