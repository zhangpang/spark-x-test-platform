import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Client as MinioClient } from "minio";
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
  readonly cases: readonly Readonly<{ id: string; result: string | null }>[];
  readonly steps: readonly Readonly<{
    id: string;
    runCaseId: string;
    attempt: number;
    action: string;
    status: string;
  }>[];
}

interface ArtifactRecord extends RecordWithId {
  readonly runId: string;
  readonly runCaseId: string | null;
  readonly stepRunId: string | null;
  readonly attempt: number | null;
  readonly kind: "screenshot" | "trace";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly redacted: boolean;
  readonly availability: "available" | "expired" | "missing";
}

const apiBase = process.env.M3_BROWSER_API_URL ?? "http://127.0.0.1:4100/api/v1";
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") throw new Error("DATABASE_URL is required");
const configuredBucket = process.env.MINIO_BUCKET;
if (configuredBucket === undefined || configuredBucket === "") {
  throw new Error("MINIO_BUCKET is required");
}
const bucket: string = configuredBucket;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT ?? "minio",
  port: Number(process.env.MINIO_PORT ?? "9000"),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY ?? "",
  secretKey: process.env.MINIO_SECRET_KEY ?? "",
});
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let systemId = process.env.M3_BROWSER_CLEANUP_SYSTEM_ID;

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

async function waitForRun(id: string): Promise<RunRecord> {
  const deadline = Date.now() + 60_000;
  let last: RunRecord | undefined;
  while (Date.now() < deadline) {
    last = (await api<RunRecord>(`/runs/${id}`)).body;
    if (last.status === "completed") return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`browser run did not complete: ${JSON.stringify(last)}`);
}

async function expectArtifactError(id: string, code: string): Promise<void> {
  const response = await fetch(`${apiBase}/artifacts/${id}/content`);
  const body = (await response.json()) as Readonly<{ code?: string }>;
  check(response.status === 410, `${code} did not return HTTP 410`);
  check(body.code === code, `expected ${code}, received ${String(body.code)}`);
}

async function cleanup(targetSystemId: string): Promise<void> {
  const objectKeys = await pool.query<{ readonly object_key: string }>(
    `select object_key from artifacts
     where run_id in (select id from test_runs where system_id = $1)`,
    [targetSystemId],
  );
  if (objectKeys.rows.length > 0) {
    await minio.removeObjects(
      bucket,
      objectKeys.rows.map((row) => row.object_key),
    );
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const auditIds = await client.query<{ readonly id: string }>(
      `select id from systems where id = $1
       union select id from modules where system_id = $1
       union select id from environments where system_id = $1
       union select id from test_suites where system_id = $1
       union select tc.id from test_cases tc join modules m on m.id = tc.module_id where m.system_id = $1
       union select tcv.id from test_case_versions tcv join test_cases tc on tc.id = tcv.case_id
         join modules m on m.id = tc.module_id where m.system_id = $1`,
      [targetSystemId],
    );
    await client.query("delete from test_runs where system_id = $1", [targetSystemId]);
    await client.query("delete from test_suites where system_id = $1", [targetSystemId]);
    await client.query(
      `update test_cases set current_draft_version_id = null, current_published_version_id = null
       where module_id in (select id from modules where system_id = $1)`,
      [targetSystemId],
    );
    await client.query(
      `delete from test_case_versions where case_id in (
         select tc.id from test_cases tc join modules m on m.id = tc.module_id
         where m.system_id = $1
       )`,
      [targetSystemId],
    );
    await client.query(
      "delete from test_cases where module_id in (select id from modules where system_id = $1)",
      [targetSystemId],
    );
    await client.query("delete from secrets where system_id = $1", [targetSystemId]);
    await client.query("delete from environments where system_id = $1", [targetSystemId]);
    await client.query("delete from modules where system_id = $1", [targetSystemId]);
    await client.query("delete from operation_audits where object_id = any($1::uuid[])", [
      auditIds.rows.map((row) => row.id),
    ]);
    await client.query("delete from systems where id = $1", [targetSystemId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createFixture(): Promise<
  Readonly<{ run: RunRecord; artifacts: ArtifactRecord[]; syntheticSecret: string }>
> {
  const systemKey = `m3-browser-${suffix}`;
  const system = await api<RecordWithId>("/systems", {
    method: "POST",
    body: { key: systemKey, name: `M3 Browser ${suffix}`, concurrencyLimit: 1 },
  });
  systemId = system.body.id;
  const moduleKey = "browser-core";
  const module = await api<RecordWithId>(`/systems/${system.body.id}/modules`, {
    method: "POST",
    body: { key: moduleKey, name: "Browser Core", sortOrder: 0 },
  });
  const environment = await api<RecordWithId>(`/systems/${system.body.id}/environments`, {
    method: "POST",
    body: {
      key: "test",
      name: "Chromium Container Test",
      kind: "test",
      baseUrl: "http://web:8080/",
      actionLevel: "write",
      allowlist: [{ protocol: "http", host: "web", ports: [8080], pathPrefixes: ["/"] }],
      timezone: "Asia/Shanghai",
      concurrencyLimit: 1,
    },
  });
  const syntheticSecret = `m3-browser-${randomUUID()}-${randomUUID()}`;
  await api<RecordWithId>("/secrets", {
    method: "POST",
    body: {
      systemId: system.body.id,
      environmentId: environment.body.id,
      key: "m3-browser-token",
      value: syntheticSecret,
    },
  });
  const definition = {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "M3 Chromium structured evidence",
      systemKey,
      moduleKey,
      priority: "P0",
      classification: "blackbox",
      actionLevel: "write",
      tags: ["m3-browser", "chromium", "evidence"],
    },
    inputs: [
      {
        name: "browser-token",
        type: "string",
        required: true,
        secretRef: "m3-browser-token",
      },
    ],
    execution: { stepTimeoutMs: 15_000, caseTimeoutMs: 60_000, diagnosticRetries: 0 },
    resourceLocks: [],
    steps: [
      {
        id: "open-console",
        name: "打开测试平台",
        kind: "action",
        action: "browser:navigate",
        params: { path: "/", expectedStatus: 200, waitUntil: "domcontentloaded" },
        capture: { "page-title": "$.title" },
      },
      {
        id: "fill-secret",
        name: "以内存密钥填写受控表单",
        kind: "action",
        action: "browser:fill",
        params: {
          selector: 'input[placeholder="我的业务系统"]',
          value: "${case.browser-token}",
        },
      },
      {
        id: "assert-brand",
        name: "检查平台标识",
        kind: "action",
        action: "browser:assert-text",
        params: { selector: ".brand-lockup", text: "自动化测试平台", exact: false },
      },
    ],
    finally: [
      {
        id: "reset-browser",
        name: "重置浏览器上下文",
        kind: "action",
        action: "browser:navigate",
        params: { path: "/", expectedStatus: 200, waitUntil: "domcontentloaded" },
      },
    ],
  };
  const testCase = await api<CaseRecord>("/test-cases", {
    method: "POST",
    body: { moduleId: module.body.id, definition, changeNote: "M3 Chromium evidence smoke" },
  });
  const validation = await api<{ readonly valid: boolean; readonly issues: readonly unknown[] }>(
    `/test-case-versions/${testCase.body.currentDraftVersionId}/validations`,
    { method: "POST", body: { environmentId: environment.body.id } },
  );
  check(
    validation.body.valid,
    `browser case validation failed: ${JSON.stringify(validation.body)}`,
  );
  await api(`/test-cases/${testCase.body.id}/publish`, {
    method: "POST",
    body: { versionId: testCase.body.currentDraftVersionId },
  });
  const suite = await api<RecordWithId>("/test-suites", {
    method: "POST",
    body: {
      systemId: system.body.id,
      key: "browser-evidence",
      name: "Browser evidence",
      caseIds: [testCase.body.id],
      defaultConcurrency: 1,
      defaultDiagnosticRetries: 0,
    },
  });
  const accepted = await api<RunRecord>("/runs", {
    method: "POST",
    idempotencyKey: randomUUID(),
    body: {
      systemId: system.body.id,
      environmentId: environment.body.id,
      suiteId: suite.body.id,
      triggerType: "release",
      triggerSource: "m3-browser-smoke",
      priority: 95,
      testedVersion: process.env.PLATFORM_VERSION ?? "browser-smoke",
    },
  });
  check(accepted.status === 202, "browser run was not accepted");
  const run = await waitForRun(accepted.body.id);
  const artifacts = [
    ...(await api<{ readonly items: ArtifactRecord[] }>(`/runs/${run.id}/artifacts`)).body.items,
  ];
  return { run, artifacts, syntheticSecret };
}

try {
  if (systemId !== undefined && systemId !== "") {
    await cleanup(systemId);
    console.info(JSON.stringify({ status: "cleaned", systemId }));
  } else {
    const fixture = await createFixture();
    check(fixture.run.gateResult === "passed", "browser run gate did not pass");
    check(fixture.run.summary.passed === 1, "browser run summary was not passed");
    check(fixture.run.firstFailure === null, "browser run retained an unexpected failure");
    check(fixture.run.steps.length === 4, "browser run did not record main and finally steps");
    check(
      fixture.run.steps.every((step) => step.status === "passed"),
      "browser step failed",
    );
    check(fixture.artifacts.length === 8, "expected screenshot and trace for each browser step");
    for (const artifact of fixture.artifacts) {
      check(artifact.runId === fixture.run.id, "artifact run linkage is missing");
      check(artifact.runCaseId === fixture.run.cases[0]?.id, "artifact case linkage is missing");
      check(
        fixture.run.steps.some((step) => step.id === artifact.stepRunId),
        "artifact step linkage is missing",
      );
      check(artifact.attempt === 1, "artifact attempt linkage is missing");
      check(artifact.redacted, "artifact is not marked redacted");
      check(artifact.availability === "available", "artifact is not available");
      const response = await fetch(`${apiBase}/artifacts/${artifact.id}/content`);
      check(response.ok, `artifact ${artifact.id} could not be streamed`);
      const content = Buffer.from(await response.arrayBuffer());
      check(content.length === artifact.sizeBytes, "artifact size metadata does not match content");
      check(
        createHash("sha256").update(content).digest("hex") === artifact.sha256,
        "artifact SHA-256 does not match content",
      );
      check(
        response.headers.get("content-type")?.startsWith(artifact.contentType),
        "artifact content type is incorrect",
      );
      const secretVariants = [
        fixture.syntheticSecret,
        encodeURIComponent(fixture.syntheticSecret),
        Buffer.from(fixture.syntheticSecret).toString("base64"),
      ];
      check(
        secretVariants.every((variant) => !content.includes(Buffer.from(variant))),
        "artifact contains a secret value or encoded variant",
      );
      check(
        content.length >= 4 &&
          (content.readUInt32BE(0) === 0x89504e47 || content.readUInt32LE(0) === 0x04034b50),
        "artifact content does not have a PNG or ZIP signature",
      );
    }
    const events = await fetch(`${apiBase}/runs/${fixture.run.id}/events?after=0`).then(
      (response) => response.text(),
    );
    check(
      (events.match(/event: artifact\.created/g) ?? []).length === 8,
      "artifact SSE events missing",
    );

    if (process.env.M3_BROWSER_FAULT_PROBES !== "false") {
      const expiring = fixture.artifacts.find((artifact) => artifact.kind === "trace");
      const missing = fixture.artifacts.find((artifact) => artifact.kind === "screenshot");
      check(expiring !== undefined && missing !== undefined, "fault probe artifacts are missing");
      await pool.query(
        "update artifacts set retained_until = now() - interval '1 second' where id = $1",
        [expiring.id],
      );
      await expectArtifactError(expiring.id, "ARTIFACT_EXPIRED");
      const missingObject = await pool.query<{ readonly object_key: string }>(
        "select object_key from artifacts where id = $1",
        [missing.id],
      );
      check(missingObject.rows[0] !== undefined, "missing probe object key is unavailable");
      await minio.removeObject(bucket, missingObject.rows[0].object_key);
      await expectArtifactError(missing.id, "ARTIFACT_OBJECT_MISSING");
    }

    console.info(
      JSON.stringify({
        status: "passed",
        scenario: "m3-chromium-structured-evidence",
        assertions: 16,
        systemId,
        runId: fixture.run.id,
        artifactCount: fixture.artifacts.length,
        retained: process.env.M3_BROWSER_KEEP_FIXTURE === "true",
      }),
    );
  }
} finally {
  try {
    if (
      systemId !== undefined &&
      systemId !== "" &&
      process.env.M3_BROWSER_KEEP_FIXTURE !== "true" &&
      process.env.M3_BROWSER_CLEANUP_SYSTEM_ID === undefined
    ) {
      await cleanup(systemId);
    }
  } finally {
    await pool.end();
  }
}
