import { createDecipheriv, createHash, randomUUID } from "node:crypto";

import {
  gateResults,
  dependencyNames,
  platformVersion,
  runStatuses,
  type ArtifactAvailability,
  type ArtifactKind,
  type ArtifactRecord,
  type CaseResult,
  type CleanupJobRecord,
  type CleanupStatus,
  type DependencyHealth,
  type DependencyName,
  type GateResult,
  type HealthResponse,
  type RunEvent,
  type RunFailure,
  type RunStatus,
  type RunSummary,
  type ResourceLedgerRecord,
  type ServiceName,
  type StepRunRecord,
  type TestRunCaseRecord,
  type TestRunDetail,
  type TestRunRecord,
} from "@spark-x-test/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { Client as MinioClient } from "minio";
import { Pool } from "pg";

interface RunRow {
  readonly id: string;
  readonly sequence_number: string | number;
  readonly trigger_type: TestRunRecord["triggerType"];
  readonly trigger_source: string;
  readonly idempotency_key: string;
  readonly priority: number;
  readonly system_id: string;
  readonly environment_id: string;
  readonly suite_id: string;
  readonly system_name: string;
  readonly environment_name: string;
  readonly suite_name: string;
  readonly tested_version: string;
  readonly platform_version: string;
  readonly snapshot: RunExecutionSnapshot;
  readonly status: RunStatus;
  readonly gate_result: GateResult | null;
  readonly summary: RunSummary;
  readonly cancellation_requested: boolean;
  readonly first_failure: RunFailure | null;
  readonly worker_id: string | null;
  readonly worker_image_digest: string | null;
  readonly executor_version: string | null;
  readonly queued_at: Date | string;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly updated_at: Date | string;
}

interface RunCaseRow {
  readonly id: string;
  readonly run_id: string;
  readonly case_id: string;
  readonly case_version_id: string;
  readonly case_name: string;
  readonly version: number;
  readonly iteration: number;
  readonly sort_order: number;
  readonly status: TestRunCaseRecord["status"];
  readonly result: CaseResult | null;
  readonly attempts: number;
  readonly flaky: boolean;
  readonly first_failure: RunFailure | null;
  readonly cleanup_status: CleanupStatus;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly duration_ms: number | null;
}

interface StepRow {
  readonly id: string;
  readonly run_case_id: string;
  readonly attempt: number;
  readonly step_path: string;
  readonly step_id: string;
  readonly action: string;
  readonly phase: StepRunRecord["phase"];
  readonly status: StepRunRecord["status"];
  readonly result: CaseResult | null;
  readonly input_summary: Readonly<Record<string, unknown>>;
  readonly output_summary: Readonly<Record<string, unknown>> | null;
  readonly error: RunFailure | null;
  readonly started_at: Date | string;
  readonly finished_at: Date | string | null;
  readonly duration_ms: number | null;
}

interface ArtifactRow {
  readonly id: string;
  readonly run_id: string;
  readonly run_case_id: string | null;
  readonly step_run_id: string | null;
  readonly attempt: number | null;
  readonly kind: ArtifactKind;
  readonly object_key: string;
  readonly size_bytes: string | number;
  readonly sha256: string;
  readonly redacted: boolean;
  readonly locked: boolean;
  readonly retained_until: Date | string | null;
  readonly created_at: Date | string;
}

interface RunEventRow {
  readonly id: string | number;
  readonly run_id: string;
  readonly event_type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly created_at: Date | string;
}

interface ResourceRow {
  readonly id: string;
  readonly run_id: string;
  readonly run_case_id: string;
  readonly resource_type: string;
  readonly system_resource_id: string;
  readonly created_step_run_id: string | null;
  readonly cleanup_definition: Readonly<Record<string, unknown>>;
  readonly cleanup_status: ResourceLedgerRecord["cleanupStatus"];
  readonly last_error: RunFailure | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface CleanupJobRow {
  readonly id: string;
  readonly run_id: string;
  readonly status: CleanupJobRecord["status"];
  readonly attempts: number;
  readonly outcome_summary: RunSummary;
  readonly gate_result: GateResult;
  readonly first_failure: RunFailure | null;
  readonly last_error: RunFailure | null;
  readonly created_at: Date | string;
  readonly started_at: Date | string | null;
  readonly finished_at: Date | string | null;
  readonly updated_at: Date | string;
}

export interface RunSnapshotCase {
  readonly runCaseId: string;
  readonly caseId: string;
  readonly caseVersionId: string;
  readonly name: string;
  readonly version: number;
  readonly sortOrder: number;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface RunExecutionSnapshot {
  readonly environment: Readonly<{
    id: string;
    baseUrl: string;
    actionLevel: "read" | "write" | "dangerous";
    adapterKey?: string;
    allowlist: readonly Readonly<{
      protocol: "http" | "https";
      host: string;
      ports: readonly number[];
      pathPrefixes?: readonly string[];
    }>[];
  }>;
  readonly suite: Readonly<{ id: string; name: string; diagnosticRetries: number }>;
  readonly cases: readonly RunSnapshotCase[];
}

export interface CreateRunInput {
  readonly triggerType: TestRunRecord["triggerType"];
  readonly triggerSource: string;
  readonly idempotencyKey: string;
  readonly priority: number;
  readonly systemId: string;
  readonly environmentId: string;
  readonly suiteId: string;
  readonly testedVersion: string;
}

export interface SecretVariableReference {
  readonly name: string;
  readonly secretRef: string;
}

export interface CleanupWorkItem {
  readonly id: string;
  readonly runId: string;
  readonly attempts: number;
  readonly summary: RunSummary;
  readonly gateResult: GateResult;
  readonly firstFailure: RunFailure | null;
  readonly snapshot: RunExecutionSnapshot;
}

export interface ArtifactUpload {
  readonly kind: "screenshot" | "trace";
  readonly data: Uint8Array;
  readonly contentType: "image/png" | "application/zip";
  readonly extension: "png" | "zip";
}

export interface ArtifactObjectStore {
  putObject(
    bucket: string,
    objectKey: string,
    data: Buffer,
    size: number,
    metadata?: Readonly<Record<string, string>>,
  ): Promise<unknown>;
  removeObject(bucket: string, objectKey: string): Promise<unknown>;
  statObject(bucket: string, objectKey: string): Promise<unknown>;
  getObject(bucket: string, objectKey: string): Promise<NodeJS.ReadableStream>;
}

export interface ArtifactContent {
  readonly artifact: ArtifactRecord;
  readonly stream: NodeJS.ReadableStream;
}

export class ArtifactAccessError extends Error {
  readonly code:
    | "ARTIFACT_NOT_FOUND"
    | "ARTIFACT_EXPIRED"
    | "ARTIFACT_OBJECT_MISSING"
    | "ARTIFACT_STORAGE_UNAVAILABLE";
  readonly statusCode: 404 | 410 | 503;

  constructor(code: ArtifactAccessError["code"], statusCode: ArtifactAccessError["statusCode"]) {
    super(code);
    this.name = "ArtifactAccessError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

function mapRun(row: RunRow): TestRunRecord {
  return {
    id: row.id,
    sequenceNumber: Number(row.sequence_number),
    triggerType: row.trigger_type,
    triggerSource: row.trigger_source,
    idempotencyKey: row.idempotency_key,
    priority: row.priority,
    systemId: row.system_id,
    environmentId: row.environment_id,
    suiteId: row.suite_id,
    systemName: row.system_name,
    environmentName: row.environment_name,
    suiteName: row.suite_name,
    testedVersion: row.tested_version,
    platformVersion: row.platform_version,
    status: row.status,
    gateResult: row.gate_result,
    summary: row.summary,
    cancellationRequested: row.cancellation_requested,
    firstFailure: row.first_failure,
    workerId: row.worker_id,
    workerImageDigest: row.worker_image_digest,
    executorVersion: row.executor_version,
    queuedAt: isoTimestamp(row.queued_at),
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function mapRunCase(row: RunCaseRow): TestRunCaseRecord {
  return {
    id: row.id,
    runId: row.run_id,
    caseId: row.case_id,
    caseVersionId: row.case_version_id,
    caseName: row.case_name,
    version: row.version,
    iteration: row.iteration,
    sortOrder: row.sort_order,
    status: row.status,
    result: row.result,
    attempts: row.attempts,
    flaky: row.flaky,
    firstFailure: row.first_failure,
    cleanupStatus: row.cleanup_status,
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    durationMs: row.duration_ms,
  };
}

function mapStep(row: StepRow): StepRunRecord {
  return {
    id: row.id,
    runCaseId: row.run_case_id,
    attempt: row.attempt,
    stepPath: row.step_path,
    stepId: row.step_id,
    action: row.action,
    phase: row.phase,
    status: row.status,
    result: row.result,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    error: row.error,
    startedAt: isoTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    durationMs: row.duration_ms,
  };
}

function artifactPresentation(kind: ArtifactKind): Readonly<{
  contentType: string;
  extension: string;
}> {
  if (kind === "screenshot") return { contentType: "image/png", extension: "png" };
  if (kind === "trace") return { contentType: "application/zip", extension: "zip" };
  return { contentType: "application/octet-stream", extension: "bin" };
}

function mapArtifact(row: ArtifactRow, availability: ArtifactAvailability): ArtifactRecord {
  const presentation = artifactPresentation(row.kind);
  return {
    id: row.id,
    runId: row.run_id,
    runCaseId: row.run_case_id,
    stepRunId: row.step_run_id,
    attempt: row.attempt,
    kind: row.kind,
    fileName: `${row.kind}-${row.id}.${presentation.extension}`,
    contentType: presentation.contentType,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    redacted: row.redacted,
    locked: row.locked,
    retainedUntil: row.retained_until === null ? null : isoTimestamp(row.retained_until),
    availability,
    createdAt: isoTimestamp(row.created_at),
  };
}

function artifactExpired(row: ArtifactRow): boolean {
  return (
    !row.locked &&
    row.retained_until !== null &&
    (row.retained_until instanceof Date
      ? row.retained_until.getTime()
      : new Date(row.retained_until).getTime()) <= Date.now()
  );
}

function objectMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return ["NoSuchKey", "NotFound", "NoSuchObject"].includes(String(error.code));
}

function mapResource(row: ResourceRow): ResourceLedgerRecord {
  return {
    id: row.id,
    runId: row.run_id,
    runCaseId: row.run_case_id,
    resourceType: row.resource_type,
    systemResourceId: row.system_resource_id,
    createdStepRunId: row.created_step_run_id,
    cleanupDefinition: row.cleanup_definition,
    cleanupStatus: row.cleanup_status,
    lastError: row.last_error,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function mapCleanupJob(row: CleanupJobRow): CleanupJobRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: isoTimestamp(row.created_at),
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

const runSelection = `
  select r.*, s.name as system_name, e.name as environment_name, ts.name as suite_name
  from test_runs r
  join systems s on s.id = r.system_id
  join environments e on e.id = r.environment_id
  join test_suites ts on ts.id = r.suite_id`;

export function serializeRunIdempotencyLockKey(
  triggerSource: string,
  systemId: string,
  idempotencyKey: string,
): string {
  return JSON.stringify([triggerSource, systemId, idempotencyKey]);
}

export class TestRunStore {
  readonly #pool: Pool;
  readonly #secretKey?: Buffer;
  readonly #artifactStorage?: Readonly<{ client: ArtifactObjectStore; bucket: string }>;

  constructor(
    pool: Pool,
    encodedSecretKey?: string,
    artifactStorage?: Readonly<{ client: ArtifactObjectStore; bucket: string }>,
  ) {
    this.#pool = pool;
    if (artifactStorage !== undefined) this.#artifactStorage = artifactStorage;
    if (encodedSecretKey === undefined || encodedSecretKey.trim() === "") return;
    const decoded = Buffer.from(encodedSecretKey, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== encodedSecretKey.trim()) {
      throw new Error(
        "PLATFORM_SECRET_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key",
      );
    }
    this.#secretKey = decoded;
  }

  async createRun(
    input: CreateRunInput,
  ): Promise<Readonly<{ run: TestRunRecord; created: boolean }>> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        serializeRunIdempotencyLockKey(input.triggerSource, input.systemId, input.idempotencyKey),
      ]);
      const existing = await client.query<RunRow>(
        `${runSelection}
         where r.trigger_source = $1 and r.system_id = $2 and r.idempotency_key = $3`,
        [input.triggerSource, input.systemId, input.idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("commit");
        return { run: mapRun(existing.rows[0]), created: false };
      }
      const context = await client.query<{
        readonly system_name: string;
        readonly environment_name: string;
        readonly base_url: string;
        readonly action_level: RunExecutionSnapshot["environment"]["actionLevel"];
        readonly allowlist: RunExecutionSnapshot["environment"]["allowlist"];
        readonly adapter_key: string | null;
        readonly suite_name: string;
        readonly diagnostic_retries: number;
      }>(
        `select s.name as system_name, e.name as environment_name, e.base_url, e.action_level,
                e.allowlist, e.adapter_key, ts.name as suite_name,
                ts.default_diagnostic_retries as diagnostic_retries
         from systems s
         join environments e on e.system_id = s.id and e.id = $2 and e.status = 'active'
         join test_suites ts on ts.system_id = s.id and ts.id = $3
         where s.id = $1 and s.status = 'active'`,
        [input.systemId, input.environmentId, input.suiteId],
      );
      const runContext = context.rows[0];
      if (runContext === undefined) throw new Error("RUN_CONTEXT_NOT_FOUND");
      const cases = await client.query<{
        readonly case_id: string;
        readonly case_version_id: string;
        readonly name: string;
        readonly version: number;
        readonly definition: Readonly<Record<string, unknown>>;
        readonly sort_order: number;
      }>(
        `select tc.id as case_id, tcv.id as case_version_id, tc.name, tcv.version,
                tcv.definition, sc.sort_order
         from suite_cases sc
         join test_cases tc on tc.id = sc.case_id and tc.status = 'published'
         join test_case_versions tcv on tcv.id = tc.current_published_version_id
         where sc.suite_id = $1
         order by sc.sort_order, tc.id`,
        [input.suiteId],
      );
      if (cases.rows.length === 0) throw new Error("RUN_SUITE_EMPTY");

      const runId = randomUUID();
      const snapshotCases = cases.rows.map((item) => ({
        runCaseId: randomUUID(),
        caseId: item.case_id,
        caseVersionId: item.case_version_id,
        name: item.name,
        version: item.version,
        sortOrder: item.sort_order,
        definition: item.definition,
      }));
      const snapshot: RunExecutionSnapshot = {
        environment: {
          id: input.environmentId,
          baseUrl: runContext.base_url,
          actionLevel: runContext.action_level,
          allowlist: runContext.allowlist,
          ...(runContext.adapter_key === null ? {} : { adapterKey: runContext.adapter_key }),
        },
        suite: {
          id: input.suiteId,
          name: runContext.suite_name,
          diagnosticRetries: runContext.diagnostic_retries,
        },
        cases: snapshotCases,
      };
      const summary: RunSummary = {
        total: snapshotCases.length,
        queued: snapshotCases.length,
        running: 0,
        passed: 0,
        productFailed: 0,
        testFailed: 0,
        environmentFailed: 0,
        infrastructureFailed: 0,
        flaky: 0,
        cancelled: 0,
        skipped: 0,
      };
      await client.query(
        `insert into test_runs
           (id, trigger_type, trigger_source, idempotency_key, priority, system_id,
            environment_id, suite_id, tested_version, platform_version, snapshot, summary)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)`,
        [
          runId,
          input.triggerType,
          input.triggerSource,
          input.idempotencyKey,
          input.priority,
          input.systemId,
          input.environmentId,
          input.suiteId,
          input.testedVersion,
          platformVersion,
          JSON.stringify(snapshot),
          JSON.stringify(summary),
        ],
      );
      for (const item of snapshotCases) {
        await client.query(
          `insert into test_run_cases
             (id, run_id, case_id, case_version_id, iteration, sort_order)
           values ($1, $2, $3, $4, 1, $5)`,
          [item.runCaseId, runId, item.caseId, item.caseVersionId, item.sortOrder],
        );
      }
      await client.query(
        `insert into run_events (run_id, event_type, data)
         values ($1, 'run.queued', $2::jsonb)`,
        [runId, JSON.stringify({ status: "queued", total: snapshotCases.length })],
      );
      await client.query("commit");
      const created = await this.getRun(runId);
      if (created === null) throw new Error("CREATED_RUN_NOT_FOUND");
      return { run: created, created: true };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listRuns(
    filters: Readonly<{ systemId?: string; status?: RunStatus }> = {},
  ): Promise<readonly TestRunRecord[]> {
    const result = await this.#pool.query<RunRow>(
      `${runSelection}
       where ($1::uuid is null or r.system_id = $1)
         and ($2::text is null or r.status = $2)
       order by r.queued_at desc, r.id desc
       limit 200`,
      [filters.systemId ?? null, filters.status ?? null],
    );
    return result.rows.map(mapRun);
  }

  async getRun(id: string): Promise<TestRunRecord | null> {
    const result = await this.#pool.query<RunRow>(`${runSelection} where r.id = $1`, [id]);
    return result.rows[0] === undefined ? null : mapRun(result.rows[0]);
  }

  async getRunDetail(id: string): Promise<TestRunDetail | null> {
    const run = await this.getRun(id);
    if (run === null) return null;
    const [cases, steps, resources, cleanupJobs] = await Promise.all([
      this.#pool.query<RunCaseRow>(
        `select trc.*, tc.name as case_name, tcv.version
         from test_run_cases trc
         join test_cases tc on tc.id = trc.case_id
         join test_case_versions tcv on tcv.id = trc.case_version_id
         where trc.run_id = $1
         order by trc.sort_order, trc.iteration`,
        [id],
      ),
      this.#pool.query<StepRow>(
        `select sr.* from step_runs sr
         join test_run_cases trc on trc.id = sr.run_case_id
         where trc.run_id = $1
         order by trc.sort_order, sr.attempt, sr.started_at`,
        [id],
      ),
      this.#pool.query<ResourceRow>(
        `select * from resource_ledger where run_id = $1 order by created_at, id`,
        [id],
      ),
      this.#pool.query<CleanupJobRow>(`select * from cleanup_jobs where run_id = $1`, [id]),
    ]);
    return {
      ...run,
      cases: cases.rows.map(mapRunCase),
      steps: steps.rows.map(mapStep),
      resources: resources.rows.map(mapResource),
      cleanupJob: cleanupJobs.rows[0] === undefined ? null : mapCleanupJob(cleanupJobs.rows[0]),
    };
  }

  async listArtifacts(runId: string): Promise<readonly ArtifactRecord[]> {
    const result = await this.#pool.query<ArtifactRow>(
      `select a.*, sr.attempt
       from artifacts a
       left join step_runs sr on sr.id = a.step_run_id
       where a.run_id = $1
       order by a.created_at, a.id`,
      [runId],
    );
    return Promise.all(
      result.rows.map(async (row) => {
        if (artifactExpired(row)) return mapArtifact(row, "expired");
        const storage = this.#artifactStorage;
        if (storage === undefined) return mapArtifact(row, "missing");
        try {
          await storage.client.statObject(storage.bucket, row.object_key);
          return mapArtifact(row, "available");
        } catch (error) {
          if (objectMissing(error)) return mapArtifact(row, "missing");
          throw new ArtifactAccessError("ARTIFACT_STORAGE_UNAVAILABLE", 503);
        }
      }),
    );
  }

  async getArtifactContent(id: string): Promise<ArtifactContent> {
    const result = await this.#pool.query<ArtifactRow>(
      `select a.*, sr.attempt
       from artifacts a
       left join step_runs sr on sr.id = a.step_run_id
       where a.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ArtifactAccessError("ARTIFACT_NOT_FOUND", 404);
    if (artifactExpired(row)) throw new ArtifactAccessError("ARTIFACT_EXPIRED", 410);
    const storage = this.#artifactStorage;
    if (storage === undefined) {
      throw new ArtifactAccessError("ARTIFACT_STORAGE_UNAVAILABLE", 503);
    }
    try {
      await storage.client.statObject(storage.bucket, row.object_key);
      return {
        artifact: mapArtifact(row, "available"),
        stream: await storage.client.getObject(storage.bucket, row.object_key),
      };
    } catch (error) {
      if (objectMissing(error)) throw new ArtifactAccessError("ARTIFACT_OBJECT_MISSING", 410);
      if (error instanceof ArtifactAccessError) throw error;
      throw new ArtifactAccessError("ARTIFACT_STORAGE_UNAVAILABLE", 503);
    }
  }

  async updateArtifactRetention(id: string, locked: boolean): Promise<ArtifactRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ArtifactRow>(
        `select a.*, sr.attempt
         from artifacts a
         left join step_runs sr on sr.id = a.step_run_id
         where a.id = $1
         for update of a`,
        [id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ArtifactAccessError("ARTIFACT_NOT_FOUND", 404);
      if (locked && artifactExpired(row)) {
        throw new ArtifactAccessError("ARTIFACT_EXPIRED", 410);
      }
      if (!locked && artifactExpired(row)) {
        await client.query("commit");
        return mapArtifact(row, "expired");
      }

      const storage = this.#artifactStorage;
      if (storage === undefined) {
        throw new ArtifactAccessError("ARTIFACT_STORAGE_UNAVAILABLE", 503);
      }
      try {
        await storage.client.statObject(storage.bucket, row.object_key);
      } catch (error) {
        if (objectMissing(error)) {
          throw new ArtifactAccessError("ARTIFACT_OBJECT_MISSING", 410);
        }
        throw new ArtifactAccessError("ARTIFACT_STORAGE_UNAVAILABLE", 503);
      }

      if (row.locked === locked) {
        await client.query("commit");
        return mapArtifact(row, "available");
      }

      const updated = await client.query<ArtifactRow>(
        `update artifacts
         set locked = $2
         where id = $1
         returning *, $3::integer as attempt`,
        [id, locked, row.attempt],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) throw new ArtifactAccessError("ARTIFACT_NOT_FOUND", 404);
      await client.query(
        `insert into run_events (run_id, event_type, data)
         values ($1, 'artifact.retention_changed', $2::jsonb)`,
        [
          row.run_id,
          JSON.stringify({
            artifactId: row.id,
            locked,
            retainedUntil: row.retained_until === null ? null : isoTimestamp(row.retained_until),
          }),
        ],
      );
      await client.query("commit");
      return mapArtifact(updatedRow, artifactExpired(updatedRow) ? "expired" : "available");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(runId: string, afterId = 0): Promise<readonly RunEvent[]> {
    const result = await this.#pool.query<RunEventRow>(
      `select * from run_events where run_id = $1 and id > $2 order by id limit 500`,
      [runId, afterId],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      runId: row.run_id,
      type: row.event_type,
      data: row.data,
      createdAt: isoTimestamp(row.created_at),
    }));
  }

  async requestCancellation(id: string): Promise<TestRunRecord | null> {
    const result = await this.#pool.query(
      `update test_runs
       set cancellation_requested = true,
           status = case when status in ('preparing', 'running') then 'cancelling' else status end,
           updated_at = now()
       where id = $1 and status <> 'completed'`,
      [id],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.appendEvent(id, "run.cancellation_requested", {});
    }
    return this.getRun(id);
  }

  async claimRun(id: string, workerId: string): Promise<RunExecutionSnapshot | null> {
    const result = await this.#pool.query<{
      readonly snapshot: RunExecutionSnapshot;
      readonly cancellation_requested: boolean;
    }>(
      `update test_runs
       set status = case when cancellation_requested then 'cancelling' else 'preparing' end,
           worker_id = $2,
           worker_image_digest = (select image_digest from workers where id = $2),
           executor_version = (select executor_version from workers where id = $2),
           worker_heartbeat_at = now(),
           started_at = coalesce(started_at, now()), updated_at = now()
       where id = $1 and status = 'queued'
       returning snapshot, cancellation_requested`,
      [id, workerId],
    );
    const claimed = result.rows[0];
    if (claimed === undefined) return null;
    await this.appendEvent(
      id,
      claimed.cancellation_requested ? "run.cancelling" : "run.preparing",
      {
        workerId,
      },
    );
    return claimed.snapshot;
  }

  async setRunStatus(id: string, status: RunStatus): Promise<boolean> {
    if (!runStatuses.includes(status)) throw new Error(`Invalid run status: ${status}`);
    const result = await this.#pool.query(
      `update test_runs set status = $2, updated_at = now(),
         finished_at = case when $2 = 'completed' then now() else finished_at end
       where id = $1 and (
         (status = 'queued' and $2 in ('preparing', 'cancelling')) or
         (status = 'preparing' and $2 in ('running', 'cancelling', 'interrupted')) or
         (status = 'running' and $2 in ('cancelling', 'cleaning', 'interrupted')) or
         (status = 'cancelling' and $2 in ('cleaning', 'interrupted')) or
         (status = 'cleaning' and $2 in ('completed', 'compensation_pending', 'interrupted')) or
         (status = 'interrupted' and $2 in ('compensation_pending', 'completed')) or
         (status = 'compensation_pending' and $2 = 'completed')
       )`,
      [id, status],
    );
    if ((result.rowCount ?? 0) === 0) {
      if (status === "running" && (await this.isCancellationRequested(id))) return false;
      throw new Error("INVALID_RUN_TRANSITION");
    }
    await this.appendEvent(id, `run.${status}`, { status });
    return true;
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    const result = await this.#pool.query<{ readonly cancellation_requested: boolean }>(
      "select cancellation_requested from test_runs where id = $1",
      [id],
    );
    return result.rows[0]?.cancellation_requested ?? true;
  }

  async resolveSecretVariables(
    runId: string,
    references: readonly SecretVariableReference[],
  ): Promise<Readonly<Record<string, string>>> {
    if (references.length === 0) return {};
    if (this.#secretKey === undefined) throw new Error("SECRET_VAULT_UNAVAILABLE");
    const resolved = await this.#pool.query<{
      readonly name: string;
      readonly encrypted_value: Buffer;
      readonly encryption_iv: Buffer;
      readonly authentication_tag: Buffer;
    }>(
      `select requested.name, selected.encrypted_value, selected.encryption_iv,
              selected.authentication_tag
       from test_runs r
       cross join lateral jsonb_to_recordset($2::jsonb)
         as requested(name text, "secretRef" text)
       join lateral (
         select s.encrypted_value, s.encryption_iv, s.authentication_tag
         from secrets s
         where s.system_id = r.system_id
           and s.key = requested."secretRef"
           and (s.environment_id = r.environment_id or s.environment_id is null)
         order by (s.environment_id = r.environment_id) desc nulls last, s.version desc
         limit 1
       ) selected on true
       where r.id = $1`,
      [runId, JSON.stringify(references)],
    );
    if (resolved.rows.length !== references.length) throw new Error("SECRET_REFERENCE_NOT_FOUND");
    try {
      return Object.fromEntries(
        resolved.rows.map((secret) => {
          const decipher = createDecipheriv(
            "aes-256-gcm",
            this.#secretKey as Buffer,
            secret.encryption_iv,
          );
          decipher.setAuthTag(secret.authentication_tag);
          const plaintext = Buffer.concat([
            decipher.update(secret.encrypted_value),
            decipher.final(),
          ]).toString("utf8");
          return [`case.${secret.name}`, plaintext];
        }),
      );
    } catch {
      throw new Error("SECRET_DECRYPTION_FAILED");
    }
  }

  async heartbeat(id: string, workerId: string): Promise<void> {
    await Promise.all([
      this.#pool.query(
        `update test_runs set worker_heartbeat_at = now(), updated_at = now()
         where id = $1 and worker_id = $2 and status <> 'completed'`,
        [id, workerId],
      ),
      this.#pool.query("update workers set last_seen_at = now() where id = $1", [workerId]),
      this.#pool.query(
        `update resource_locks
         set heartbeat_at = now(), leased_until = now() + interval '30 seconds'
         where run_id = $1 and released_at is null`,
        [id],
      ),
    ]);
  }

  async acquireResourceLocks(
    runId: string,
    runCaseId: string,
    requestedKeys: readonly string[],
    leaseMs = 30_000,
  ): Promise<boolean> {
    const keys = [...new Set(requestedKeys)].sort();
    if (keys.length === 0) return true;
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      for (const key of keys) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify(key),
        ]);
        await client.query(
          `update resource_locks
           set released_at = now(), release_reason = 'expired'
           where lock_key = $1 and released_at is null and leased_until <= now()`,
          [key],
        );
        const conflict = await client.query<{ readonly id: string }>(
          `select id from resource_locks
           where lock_key = $1 and released_at is null and run_case_id <> $2
           limit 1`,
          [key, runCaseId],
        );
        if (conflict.rows[0] !== undefined) {
          await client.query("rollback");
          return false;
        }
        const own = await client.query<{ readonly id: string }>(
          `update resource_locks
           set leased_until = now() + ($3::integer * interval '1 millisecond'), heartbeat_at = now()
           where lock_key = $1 and run_case_id = $2 and released_at is null
           returning id`,
          [key, runCaseId, leaseMs],
        );
        if (own.rows[0] === undefined) {
          await client.query(
            `insert into resource_locks
               (id, lock_key, run_id, run_case_id, leased_until)
             values ($1, $2, $3, $4, now() + ($5::integer * interval '1 millisecond'))`,
            [randomUUID(), key, runId, runCaseId, leaseMs],
          );
        }
      }
      await client.query("commit");
      await this.appendEvent(runId, "resource_locks.acquired", { runCaseId, keys });
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseResourceLocks(
    runId: string,
    runCaseId: string | null,
    reason: "cleaned" | "no_side_effect" | "cancelled" | "compensation_succeeded",
  ): Promise<void> {
    const result = await this.#pool.query(
      `update resource_locks
       set released_at = now(), release_reason = $3
       where run_id = $1 and released_at is null and ($2::uuid is null or run_case_id = $2)`,
      [runId, runCaseId, reason],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.appendEvent(runId, "resource_locks.released", { runCaseId, reason });
    }
  }

  async renewResourceLocks(runId: string): Promise<void> {
    await this.#pool.query(
      `update resource_locks
       set heartbeat_at = now(), leased_until = now() + interval '30 seconds'
       where run_id = $1 and released_at is null`,
      [runId],
    );
  }

  async registerResource(
    runId: string,
    input: Readonly<{
      id: string;
      runCaseId: string;
      resourceType: string;
      systemResourceId: string;
      createdStepRunId: string;
      cleanupDefinition: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void> {
    await this.#pool.query(
      `insert into resource_ledger
         (id, run_id, run_case_id, resource_type, system_resource_id,
          created_step_run_id, cleanup_definition)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (run_id, resource_type, system_resource_id) do nothing`,
      [
        input.id,
        runId,
        input.runCaseId,
        input.resourceType,
        input.systemResourceId,
        input.createdStepRunId,
        JSON.stringify(input.cleanupDefinition),
      ],
    );
    await this.appendEvent(runId, "resource.registered", {
      runCaseId: input.runCaseId,
      resourceType: input.resourceType,
      systemResourceId: input.systemResourceId,
    });
  }

  async markCaseResources(
    runId: string,
    runCaseId: string,
    status: ResourceLedgerRecord["cleanupStatus"],
    lastError: RunFailure | null = null,
  ): Promise<number> {
    const result = await this.#pool.query(
      `update resource_ledger
       set cleanup_status = $3, last_error = $4::jsonb, updated_at = now()
       where run_id = $1 and run_case_id = $2 and cleanup_status <> 'passed'`,
      [runId, runCaseId, status, lastError === null ? null : JSON.stringify(lastError)],
    );
    return result.rowCount ?? 0;
  }

  async prepareCompensation(
    runId: string,
    summary: RunSummary,
    gateResult: GateResult,
    firstFailure: RunFailure | null,
  ): Promise<CleanupJobRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const run = await client.query(
        `update test_runs
         set status = 'compensation_pending', summary = $2::jsonb, gate_result = $3,
             first_failure = $4::jsonb, updated_at = now()
         where id = $1 and status = 'cleaning'
         returning id`,
        [
          runId,
          JSON.stringify(summary),
          gateResult,
          firstFailure === null ? null : JSON.stringify(firstFailure),
        ],
      );
      if (run.rows[0] === undefined) throw new Error("INVALID_RUN_TRANSITION");
      const cleanupJobId = randomUUID();
      const cleanup = await client.query<CleanupJobRow>(
        `insert into cleanup_jobs
           (id, run_id, outcome_summary, gate_result, first_failure)
         values ($1, $2, $3::jsonb, $4, $5::jsonb)
         on conflict (run_id) do update set
           outcome_summary = excluded.outcome_summary,
           gate_result = excluded.gate_result,
           first_failure = excluded.first_failure,
           status = case when cleanup_jobs.status = 'succeeded' then 'succeeded' else 'queued' end,
           updated_at = now()
         returning *`,
        [
          cleanupJobId,
          runId,
          JSON.stringify(summary),
          gateResult,
          firstFailure === null ? null : JSON.stringify(firstFailure),
        ],
      );
      await client.query(
        `insert into run_events (run_id, event_type, data)
         values ($1, 'run.compensation_pending', $2::jsonb)`,
        [runId, JSON.stringify({ cleanupJobId: cleanup.rows[0]?.id })],
      );
      await client.query("commit");
      if (cleanup.rows[0] === undefined) throw new Error("CLEANUP_JOB_NOT_CREATED");
      return mapCleanupJob(cleanup.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimCleanupJob(id: string): Promise<CleanupWorkItem | null> {
    const result = await this.#pool.query<
      CleanupJobRow & { readonly snapshot: RunExecutionSnapshot }
    >(
      `update cleanup_jobs cj
       set status = 'running', attempts = attempts + 1,
           started_at = coalesce(cj.started_at, now()), updated_at = now(), last_error = null
       from test_runs r
       where cj.id = $1 and cj.run_id = r.id and cj.status in ('queued', 'running', 'failed')
       returning cj.*, r.snapshot`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          runId: row.run_id,
          attempts: row.attempts,
          summary: row.outcome_summary,
          gateResult: row.gate_result,
          firstFailure: row.first_failure,
          snapshot: row.snapshot,
        };
  }

  async listResourcesForCleanup(runId: string): Promise<readonly ResourceLedgerRecord[]> {
    const result = await this.#pool.query<ResourceRow>(
      `select * from resource_ledger
       where run_id = $1 and cleanup_status in ('pending', 'running', 'failed')
       order by created_at desc, id desc`,
      [runId],
    );
    return result.rows.map(mapResource);
  }

  async markResourceCleanup(
    resourceId: string,
    status: ResourceLedgerRecord["cleanupStatus"],
    lastError: RunFailure | null = null,
  ): Promise<void> {
    await this.#pool.query(
      `update resource_ledger
       set cleanup_status = $2, last_error = $3::jsonb, updated_at = now()
       where id = $1`,
      [resourceId, status, lastError === null ? null : JSON.stringify(lastError)],
    );
  }

  async failCleanupJob(id: string, failure: RunFailure): Promise<void> {
    await this.#pool.query(
      `update cleanup_jobs
       set status = 'failed', last_error = $2::jsonb, updated_at = now()
       where id = $1 and status = 'running'`,
      [id, JSON.stringify(failure)],
    );
  }

  async completeCompensation(id: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      const cleanup = await client.query<CleanupJobRow>(
        `update cleanup_jobs
         set status = 'succeeded', last_error = null, finished_at = now(), updated_at = now()
         where id = $1 and status = 'running'
         returning *`,
        [id],
      );
      const row = cleanup.rows[0];
      if (row === undefined) throw new Error("CLEANUP_JOB_NOT_RUNNING");
      const run = await client.query(
        `update test_runs
         set status = 'completed', summary = $2::jsonb, gate_result = $3,
             first_failure = $4::jsonb, finished_at = now(), updated_at = now()
         where id = $1 and status = 'compensation_pending'
         returning id`,
        [
          row.run_id,
          JSON.stringify(row.outcome_summary),
          row.gate_result,
          row.first_failure === null ? null : JSON.stringify(row.first_failure),
        ],
      );
      if (run.rows[0] === undefined) throw new Error("INVALID_RUN_TRANSITION");
      await client.query(
        `update resource_locks
         set released_at = now(), release_reason = 'compensation_succeeded'
         where run_id = $1 and released_at is null`,
        [row.run_id],
      );
      await client.query(
        `insert into run_events (run_id, event_type, data)
         values ($1, 'run.completed', $2::jsonb)`,
        [
          row.run_id,
          JSON.stringify({
            summary: row.outcome_summary,
            gateResult: row.gate_result,
            firstFailure: row.first_failure,
            compensation: "succeeded",
          }),
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async startCase(runId: string, runCaseId: string, attempt: number): Promise<void> {
    await this.#pool.query(
      `update test_run_cases
       set status = 'running', attempts = $3, started_at = coalesce(started_at, now())
       where id = $2 and run_id = $1`,
      [runId, runCaseId, attempt],
    );
    await this.#refreshRunSummary(runId);
    await this.appendEvent(runId, "case.started", { runCaseId, attempt });
  }

  async recordStep(
    runId: string,
    input: Readonly<{
      id: string;
      runCaseId: string;
      attempt: number;
      path: string;
      stepId: string;
      action: string;
      phase: "main" | "finally";
      status: StepRunRecord["status"];
      result: CaseResult;
      inputSummary: Readonly<Record<string, unknown>>;
      outputSummary?: Readonly<Record<string, unknown>>;
      error?: RunFailure;
      startedAt: string;
      durationMs: number;
      artifacts?: readonly ArtifactUpload[];
    }>,
  ): Promise<void> {
    const artifacts = input.artifacts ?? [];
    if (artifacts.length > 0) {
      const storage = this.#artifactStorage;
      if (storage === undefined) throw new Error("ARTIFACT_STORAGE_NOT_CONFIGURED");
      const prepared = artifacts.map((artifact) => {
        const maximum = artifact.kind === "screenshot" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
        if (artifact.data.byteLength === 0 || artifact.data.byteLength > maximum) {
          throw new Error("ARTIFACT_SIZE_LIMIT_EXCEEDED");
        }
        const id = randomUUID();
        return {
          ...artifact,
          id,
          data: Buffer.from(artifact.data),
          objectKey: `runs/${runId}/cases/${input.runCaseId}/attempts/${input.attempt}/steps/${input.id}/${id}.${artifact.extension}`,
          sha256: createHash("sha256").update(artifact.data).digest("hex"),
          retainedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
        };
      });
      const uploaded: string[] = [];
      const client = await this.#pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into step_runs
             (id, run_case_id, attempt, step_path, step_id, action, phase, status, result,
              input_summary, output_summary, error, started_at, finished_at, duration_ms)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
                   $12::jsonb, $13, now(), $14)`,
          [
            input.id,
            input.runCaseId,
            input.attempt,
            input.path,
            input.stepId,
            input.action,
            input.phase,
            input.status,
            input.result,
            JSON.stringify(input.inputSummary),
            input.outputSummary === undefined ? null : JSON.stringify(input.outputSummary),
            input.error === undefined ? null : JSON.stringify(input.error),
            input.startedAt,
            input.durationMs,
          ],
        );
        for (const artifact of prepared) {
          await storage.client.putObject(
            storage.bucket,
            artifact.objectKey,
            artifact.data,
            artifact.data.length,
            {
              "Content-Type": artifact.contentType,
              "X-Amz-Meta-Artifact-Kind": artifact.kind,
              "X-Amz-Meta-Redacted": "true",
            },
          );
          uploaded.push(artifact.objectKey);
          await client.query(
            `insert into artifacts
               (id, run_id, run_case_id, step_run_id, kind, object_key, size_bytes,
                sha256, redacted, retained_until)
             values ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
            [
              artifact.id,
              runId,
              input.runCaseId,
              input.id,
              artifact.kind,
              artifact.objectKey,
              artifact.data.length,
              artifact.sha256,
              artifact.retainedUntil,
            ],
          );
          await client.query(
            `insert into run_events (run_id, event_type, data)
             values ($1, 'artifact.created', $2::jsonb)`,
            [
              runId,
              JSON.stringify({
                artifactId: artifact.id,
                runCaseId: input.runCaseId,
                stepRunId: input.id,
                attempt: input.attempt,
                kind: artifact.kind,
                sizeBytes: artifact.data.length,
                redacted: true,
              }),
            ],
          );
        }
        await client.query(
          `insert into run_events (run_id, event_type, data)
           values ($1, 'step.completed', $2::jsonb)`,
          [
            runId,
            JSON.stringify({
              runCaseId: input.runCaseId,
              stepId: input.stepId,
              attempt: input.attempt,
              phase: input.phase,
              result: input.result,
            }),
          ],
        );
        await client.query("commit");
        return;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        await Promise.allSettled(
          uploaded.map((objectKey) => storage.client.removeObject(storage.bucket, objectKey)),
        );
        throw error;
      } finally {
        client.release();
      }
    }
    await this.#pool.query(
      `insert into step_runs
         (id, run_case_id, attempt, step_path, step_id, action, phase, status, result,
          input_summary, output_summary, error, started_at, finished_at, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
               $12::jsonb, $13, now(), $14)`,
      [
        input.id,
        input.runCaseId,
        input.attempt,
        input.path,
        input.stepId,
        input.action,
        input.phase,
        input.status,
        input.result,
        JSON.stringify(input.inputSummary),
        input.outputSummary === undefined ? null : JSON.stringify(input.outputSummary),
        input.error === undefined ? null : JSON.stringify(input.error),
        input.startedAt,
        input.durationMs,
      ],
    );
    await this.appendEvent(runId, "step.completed", {
      runCaseId: input.runCaseId,
      stepId: input.stepId,
      attempt: input.attempt,
      phase: input.phase,
      result: input.result,
    });
  }

  async finishCase(
    runId: string,
    runCaseId: string,
    result: CaseResult,
    cleanupStatus: CleanupStatus,
    firstFailure: RunFailure | null,
    startedAt: number,
    flaky = false,
  ): Promise<void> {
    await this.#pool.query(
      `update test_run_cases
       set status = 'completed', result = $3, flaky = $4, first_failure = $5::jsonb,
           cleanup_status = $6, finished_at = now(),
           duration_ms = greatest(0, floor(extract(epoch from (clock_timestamp() - to_timestamp($7::double precision / 1000.0))) * 1000)::integer)
       where id = $2 and run_id = $1`,
      [
        runId,
        runCaseId,
        result,
        flaky,
        firstFailure === null ? null : JSON.stringify(firstFailure),
        cleanupStatus,
        startedAt,
      ],
    );
    await this.#refreshRunSummary(runId);
    await this.appendEvent(runId, "case.completed", { runCaseId, result, cleanupStatus, flaky });
  }

  async completeRun(
    id: string,
    summary: RunSummary,
    gateResult: GateResult,
    firstFailure: RunFailure | null,
  ): Promise<void> {
    if (!gateResults.includes(gateResult)) throw new Error(`Invalid gate result: ${gateResult}`);
    const result = await this.#pool.query(
      `update test_runs
       set status = 'completed', summary = $2::jsonb, gate_result = $3,
           first_failure = $4::jsonb, finished_at = now(), updated_at = now()
       where id = $1 and status in ('cleaning', 'interrupted', 'compensation_pending')`,
      [
        id,
        JSON.stringify(summary),
        gateResult,
        firstFailure === null ? null : JSON.stringify(firstFailure),
      ],
    );
    if ((result.rowCount ?? 0) === 0) throw new Error("INVALID_RUN_TRANSITION");
    await this.appendEvent(id, "run.completed", { summary, gateResult, firstFailure });
  }

  async appendEvent(
    runId: string,
    type: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#pool.query(
      `insert into run_events (run_id, event_type, data) values ($1, $2, $3::jsonb)`,
      [runId, type, JSON.stringify(data)],
    );
  }

  async #refreshRunSummary(runId: string): Promise<void> {
    await this.#pool.query(
      `with counts as (
         select count(*)::integer as total,
                count(*) filter (where status = 'queued')::integer as queued,
                count(*) filter (where status = 'running')::integer as running,
                count(*) filter (where result = 'passed')::integer as passed,
                count(*) filter (where result = 'product_failed')::integer as product_failed,
                count(*) filter (where result = 'test_failed')::integer as test_failed,
                count(*) filter (where result = 'environment_failed')::integer as environment_failed,
                count(*) filter (where result = 'infrastructure_failed')::integer as infrastructure_failed,
                count(*) filter (where result = 'flaky')::integer as flaky,
                count(*) filter (where result = 'cancelled')::integer as cancelled,
                count(*) filter (where result = 'skipped')::integer as skipped
         from test_run_cases where run_id = $1
       )
       update test_runs
       set summary = jsonb_build_object(
             'total', counts.total,
             'queued', counts.queued,
             'running', counts.running,
             'passed', counts.passed,
             'productFailed', counts.product_failed,
             'testFailed', counts.test_failed,
             'environmentFailed', counts.environment_failed,
             'infrastructureFailed', counts.infrastructure_failed,
             'flaky', counts.flaky,
             'cancelled', counts.cancelled,
             'skipped', counts.skipped
           ),
           updated_at = now()
       from counts where test_runs.id = $1`,
      [runId],
    );
  }

  async registerWorker(
    id: string,
    input: Readonly<{
      identity?: string;
      imageDigest: string;
      executorVersion: string;
      concurrencySlots: number;
      capabilities: readonly string[];
    }>,
  ): Promise<void> {
    await this.#pool.query(
      `insert into workers
         (id, identity, image_digest, executor_version, capabilities, concurrency_slots)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       on conflict (id) do update set identity = excluded.identity,
         image_digest = excluded.image_digest, executor_version = excluded.executor_version,
         capabilities = excluded.capabilities, concurrency_slots = excluded.concurrency_slots,
         status = 'online', last_seen_at = now()`,
      [
        id,
        input.identity ?? null,
        input.imageDigest,
        input.executorVersion,
        JSON.stringify(input.capabilities),
        input.concurrencySlots,
      ],
    );
  }
}

export interface PlatformConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly minio: {
    readonly endPoint: string;
    readonly port: number;
    readonly useSSL: boolean;
    readonly accessKey: string;
    readonly secretKey: string;
    readonly bucket: string;
  };
  readonly queueName: string;
  readonly workerIdentity?: string;
}

export interface PlatformDependencies {
  readonly postgres: Pool;
  readonly redis: Redis;
  readonly minio: MinioClient;
  close(): Promise<void>;
}

export interface ServiceApplication {
  readonly app: FastifyInstance;
  readonly config: PlatformConfig;
  readonly dependencies: PlatformDependencies;
}

function requiredEnvironment(name: string, environment: NodeJS.ProcessEnv): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid ${name}: expected an integer from 1 to 65535`);
  }
  return parsed;
}

function parseBoolean(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${name}: expected true or false`);
}

export function loadPlatformConfig(environment: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const nodeEnv = environment.NODE_ENV ?? "development";
  if (!(["development", "test", "production"] as const).includes(nodeEnv as never)) {
    throw new Error(`Invalid NODE_ENV: ${nodeEnv}`);
  }

  const workerIdentity = environment.WORKER_IDENTITY?.trim();
  return {
    nodeEnv: nodeEnv as PlatformConfig["nodeEnv"],
    logLevel: environment.LOG_LEVEL ?? "info",
    databaseUrl: requiredEnvironment("DATABASE_URL", environment),
    redisUrl: requiredEnvironment("REDIS_URL", environment),
    minio: {
      endPoint: requiredEnvironment("MINIO_ENDPOINT", environment),
      port: parsePort("MINIO_PORT", environment.MINIO_PORT ?? "9000"),
      useSSL: parseBoolean("MINIO_USE_SSL", environment.MINIO_USE_SSL ?? "false"),
      accessKey: requiredEnvironment("MINIO_ACCESS_KEY", environment),
      secretKey: requiredEnvironment("MINIO_SECRET_KEY", environment),
      bucket: requiredEnvironment("MINIO_BUCKET", environment),
    },
    queueName: environment.PLATFORM_QUEUE_NAME ?? "test-runs",
    ...(workerIdentity === undefined || workerIdentity === "" ? {} : { workerIdentity }),
  };
}

export function createPlatformDependencies(config: PlatformConfig): PlatformDependencies {
  const postgres = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 2_000,
    max: 5,
  });
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const minio = new MinioClient(config.minio);

  // Both clients emit operational connection errors outside individual probe promises.
  // Keep a listener installed so dependency loss degrades readiness instead of terminating
  // the process through EventEmitter's unhandled `error` behavior.
  postgres.on("error", () => undefined);
  redis.on("error", () => undefined);

  return {
    postgres,
    redis,
    minio,
    async close() {
      if (redis.status === "wait" || redis.status === "end") {
        redis.disconnect();
        await postgres.end();
        return;
      }
      await Promise.allSettled([postgres.end(), redis.quit()]);
    },
  };
}

export async function runDependencyProbe(
  probe: () => Promise<unknown>,
  timeoutMs = 2_000,
): Promise<DependencyHealth> {
  const startedAt = performance.now();
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Dependency probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { status: "ok", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      status: "error",
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "Unknown dependency error",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function checkDependencies(
  dependencies: PlatformDependencies,
  config: PlatformConfig,
): Promise<Record<DependencyName, DependencyHealth>> {
  const [postgres, redis, minio] = await Promise.all([
    runDependencyProbe(async () => dependencies.postgres.query("select 1")),
    runDependencyProbe(async () => {
      if (dependencies.redis.status === "wait") await dependencies.redis.connect();
      await dependencies.redis.ping();
    }),
    runDependencyProbe(async () => {
      const exists = await dependencies.minio.bucketExists(config.minio.bucket);
      if (!exists) throw new Error(`Required bucket does not exist: ${config.minio.bucket}`);
    }),
  ]);
  return { postgres, redis, minio };
}

export async function writeServiceHeartbeat(
  dependencies: PlatformDependencies,
  service: ServiceName,
  instanceId: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await dependencies.postgres.query(
    `insert into service_heartbeats (service_name, instance_id, platform_version, metadata, last_seen_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (service_name, instance_id)
     do update set platform_version = excluded.platform_version,
                   metadata = excluded.metadata,
                   last_seen_at = excluded.last_seen_at`,
    [service, instanceId, platformVersion, JSON.stringify(metadata)],
  );
}

export function createServiceApplication(
  service: ServiceName,
  options: {
    readonly healthPrefix?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly logger?: boolean;
  } = {},
): ServiceApplication {
  const config = loadPlatformConfig(options.environment);
  const dependencies = createPlatformDependencies(config);
  const app = Fastify({
    logger: options.logger ?? config.nodeEnv !== "test",
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });
  const prefix = options.healthPrefix ?? "";

  app.get(
    `${prefix}/healthz`,
    (): HealthResponse => ({
      status: "ok",
      service,
      version: platformVersion,
      time: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  );

  app.get(`${prefix}/readyz`, async (_request, reply): Promise<HealthResponse> => {
    const health = await checkDependencies(dependencies, config);
    const isReady = dependencyNames.every((name) => health[name].status === "ok");
    if (!isReady) reply.code(503);
    return {
      status: isReady ? "ok" : "degraded",
      service,
      version: platformVersion,
      time: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: health,
    };
  });

  app.addHook("onClose", () => dependencies.close());
  return { app, config, dependencies };
}

export async function listen(app: FastifyInstance, port: number, host = "0.0.0.0"): Promise<void> {
  await app.listen({ port, host });
}
