import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";

interface RecordWithId {
  readonly id: string;
}

interface CaseRecord extends RecordWithId {
  readonly currentDraftVersionId: string;
}

interface ValidationRecord {
  readonly valid: boolean;
  readonly issues: readonly Readonly<{ code: string }>[];
}

interface RunRecord extends RecordWithId {
  readonly status: string;
  readonly gateResult: string | null;
  readonly summary: Readonly<Record<string, number>>;
  readonly firstFailure: Readonly<{ code: string; stepId?: string }> | null;
  readonly cases: readonly Readonly<{ result: string | null; cleanupStatus: string }>[];
  readonly steps: readonly Readonly<{
    stepId: string;
    action: string;
    phase: string;
    status: string;
    inputSummary: Readonly<Record<string, unknown>> | null;
    outputSummary: Readonly<Record<string, unknown>> | null;
  }>[];
}

const apiBase = process.env.M3_JSON_API_URL ?? "http://127.0.0.1:4100/api/v1";
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
  options: Readonly<{ method?: string; body?: unknown; idempotencyKey?: string }> = {},
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

function definition(
  systemKey: string,
  moduleKey: string,
  mode: "passing" | "failing" | "invalid",
): Readonly<Record<string, unknown>> {
  const base = {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: `M3 JSON ${mode}`,
      systemKey,
      moduleKey,
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      tags: ["m3-smoke", "json-variable"],
    },
    inputs: [],
    execution: { stepTimeoutMs: 5_000, caseTimeoutMs: 20_000, diagnosticRetries: 0 },
    resourceLocks: [],
  };
  if (mode === "invalid") {
    return {
      ...base,
      steps: [
        {
          id: "unsafe-json",
          name: "拒绝动态 JSON 表达式",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.future-body}",
            path: "$.items[?(@.ready)]",
            operator: "equals",
            expected: true,
            script: "return value",
          },
        },
      ],
      finally: [],
    };
  }
  return {
    ...base,
    steps: [
      {
        id: "read-health",
        name: "读取结构化健康响应",
        kind: "action",
        action: "http:request",
        params: { method: "GET", path: "/api/v1/healthz" },
        capture: { "health-body": "$.body" },
      },
      {
        id: "extract-status",
        name: "提取健康状态",
        kind: "action",
        action: "json:extract",
        params: { source: "${step.health-body}", path: "$.status" },
        capture: { "health-status": "$.value" },
      },
      {
        id: "assert-status",
        name: "断言健康状态",
        kind: "action",
        action: "json:assert",
        params: {
          source: "${step.health-body}",
          path: "$.status",
          operator: "equals",
          expected: mode === "passing" ? "${step.health-status}" : "unexpected-status",
        },
      },
      ...(mode === "passing"
        ? [
            {
              id: "use-status",
              name: "使用提取变量执行下游请求",
              kind: "action",
              action: "http:request",
              params: {
                method: "GET",
                path: "/api/v1/healthz?observed=${step.health-status}",
              },
            },
          ]
        : []),
    ],
    finally:
      mode === "failing"
        ? [
            {
              id: "cleanup-proof",
              name: "失败后执行 finally",
              kind: "action",
              action: "http:request",
              params: { method: "GET", path: "/api/v1/healthz?phase=finally" },
            },
          ]
        : [],
  };
}

async function createCase(
  moduleId: string,
  environmentId: string,
  systemKey: string,
  moduleKey: string,
  mode: "passing" | "failing" | "invalid",
): Promise<Readonly<{ caseId: string; validation: ValidationRecord }>> {
  const created = await api<CaseRecord>("/test-cases", {
    method: "POST",
    body: {
      moduleId,
      definition: definition(systemKey, moduleKey, mode),
      changeNote: `M3 JSON variable ${mode} verification`,
    },
  });
  createdIds.push(created.body.id, created.body.currentDraftVersionId);
  const validation = await api<ValidationRecord>(
    `/test-case-versions/${created.body.currentDraftVersionId}/validations`,
    { method: "POST", body: { environmentId } },
  );
  if (mode !== "invalid") {
    check(validation.body.valid, `${mode} JSON case did not pass static validation`);
    await api(`/test-cases/${created.body.id}/publish`, {
      method: "POST",
      body: { versionId: created.body.currentDraftVersionId },
    });
  }
  return { caseId: created.body.id, validation: validation.body };
}

async function createSuite(key: string, name: string, caseId: string): Promise<string> {
  if (systemId === undefined) throw new Error("verification system has not been created");
  const suite = await api<RecordWithId>("/test-suites", {
    method: "POST",
    body: {
      systemId,
      key,
      name,
      caseIds: [caseId],
      defaultConcurrency: 1,
      defaultDiagnosticRetries: 0,
    },
  });
  createdIds.push(suite.body.id);
  return suite.body.id;
}

async function createRun(suiteId: string, environmentId: string): Promise<RunRecord> {
  if (systemId === undefined) throw new Error("verification system has not been created");
  const accepted = await api<RunRecord>("/runs", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: {
      systemId,
      suiteId,
      environmentId,
      triggerType: "release",
      triggerSource: "m3-json-variable-verification",
      priority: 90,
      testedVersion: process.env.PLATFORM_VERSION ?? "candidate",
    },
  });
  check(accepted.status === 202, "JSON verification run was not accepted with HTTP 202");
  const deadline = Date.now() + 30_000;
  let last = accepted.body;
  while (Date.now() < deadline) {
    last = (await api<RunRecord>(`/runs/${accepted.body.id}`)).body;
    if (last.status === "completed") return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`run ${accepted.body.id} did not complete: ${JSON.stringify(last)}`);
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
  const systemKey = `m3-json-${suffix}`;
  const system = await api<RecordWithId>("/systems", {
    method: "POST",
    body: { key: systemKey, name: `M3 JSON ${suffix}`, concurrencyLimit: 2 },
  });
  systemId = system.body.id;
  createdIds.push(systemId);

  const moduleKey = "json-variable";
  const module = await api<RecordWithId>(`/systems/${systemId}/modules`, {
    method: "POST",
    body: { key: moduleKey, name: "JSON variable", sortOrder: 0 },
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

  const passing = await createCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
    "passing",
  );
  const failing = await createCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
    "failing",
  );
  const invalid = await createCase(
    module.body.id,
    environment.body.id,
    systemKey,
    moduleKey,
    "invalid",
  );
  check(!invalid.validation.valid, "unsafe JSON definition unexpectedly passed validation");
  const invalidCodes = invalid.validation.issues.map((issue) => issue.code);
  check(
    invalidCodes.includes("ARBITRARY_JSON_INPUT_FORBIDDEN"),
    "unsafe JSON parameter was not rejected",
  );
  check(
    invalidCodes.includes("JSON_SOURCE_REFERENCE_UNKNOWN"),
    "forward JSON variable reference was not rejected",
  );
  check(invalidCodes.includes("JSON_PATH_INVALID"), "dynamic JSONPath was not rejected");

  const passingSuiteId = await createSuite("passing-json", "Passing JSON", passing.caseId);
  const failingSuiteId = await createSuite("failing-json", "Failing JSON", failing.caseId);

  const passingRun = await createRun(passingSuiteId, environment.body.id);
  check(passingRun.gateResult === "passed", "passing JSON run gate was not passed");
  check(passingRun.summary.passed === 1, "passing JSON summary is incorrect");
  check(passingRun.cases[0]?.cleanupStatus === "not_required", "passing cleanup status is wrong");
  check(
    passingRun.steps.map((step) => step.action).join(",") ===
      "http:request,json:extract,json:assert,http:request",
    "JSON variable chain did not record the expected action order",
  );
  const extracted = passingRun.steps.find((step) => step.stepId === "extract-status");
  check(extracted?.outputSummary?.value === "ok", "JSON extracted value evidence is missing");
  const asserted = passingRun.steps.find((step) => step.stepId === "assert-status");
  check(asserted?.outputSummary?.matched === true, "JSON assertion evidence is missing");
  check(asserted?.outputSummary?.actual === "ok", "JSON assertion actual value is incorrect");
  const downstream = passingRun.steps.find((step) => step.stepId === "use-status");
  check(
    String(downstream?.outputSummary?.url).endsWith("?observed=ok"),
    "downstream HTTP step did not consume the extracted variable",
  );
  check(
    Object.keys(extracted?.outputSummary ?? {})
      .sort()
      .join(",") === "found,path,value",
    "JSON extract evidence included undeclared source fields",
  );

  const events = await fetch(`${apiBase}/runs/${passingRun.id}/events?after=0`).then((response) =>
    response.text(),
  );
  check(events.includes("event: run.completed"), "JSON run SSE is missing run.completed");
  check(events.includes("event: step.completed"), "JSON run SSE is missing step.completed");

  const failingRun = await createRun(failingSuiteId, environment.body.id);
  check(failingRun.gateResult === "blocked", "JSON assertion failure did not block the gate");
  check(failingRun.summary.productFailed === 1, "JSON failure summary is incorrect");
  check(
    failingRun.firstFailure?.code === "JSON_ASSERTION_FAILED",
    "JSON assertion root failure was not preserved",
  );
  check(
    failingRun.firstFailure?.stepId === "assert-status",
    "JSON assertion root failure lost its step association",
  );
  check(failingRun.cases[0]?.cleanupStatus === "passed", "finally did not complete after failure");
  check(
    failingRun.steps.some(
      (step) =>
        step.stepId === "cleanup-proof" && step.phase === "finally" && step.status === "passed",
    ),
    "finally step evidence is missing after JSON assertion failure",
  );

  console.info(
    JSON.stringify({
      status: "passed",
      scenario: "m3-json-variable-evidence-loop",
      assertions: 22,
      passingRunId: passingRun.id,
      failingRunId: failingRun.id,
      invalidValidationCodes: invalidCodes,
    }),
  );
} finally {
  try {
    await cleanup();
  } finally {
    await pool.end();
  }
}
