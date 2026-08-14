import { describe, expect, it, vi } from "vitest";

import {
  type ArtifactObjectStore,
  createPlatformDependencies,
  loadPlatformConfig,
  runDependencyProbe,
  serializeRunIdempotencyLockKey,
  TestRunStore,
} from "./index.js";

const baseEnvironment = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/platform",
  REDIS_URL: "redis://localhost:6379/0",
  MINIO_ENDPOINT: "localhost",
  MINIO_PORT: "9000",
  MINIO_USE_SSL: "false",
  MINIO_ACCESS_KEY: "local-key",
  MINIO_SECRET_KEY: "local-secret",
  MINIO_BUCKET: "test-artifacts",
};

describe("platform service configuration", () => {
  it("loads explicit dependency configuration", () => {
    const config = loadPlatformConfig(baseEnvironment);
    expect(config.minio.port).toBe(9000);
    expect(config.minio.useSSL).toBe(false);
    expect(config.workerIdentity).toBeUndefined();
  });

  it("rejects an invalid MinIO port", () => {
    expect(() => loadPlatformConfig({ ...baseEnvironment, MINIO_PORT: "0" })).toThrow(
      "Invalid MINIO_PORT",
    );
  });

  it("requires database configuration", () => {
    const missingDatabase: NodeJS.ProcessEnv = { ...baseEnvironment };
    delete missingDatabase.DATABASE_URL;
    expect(() => loadPlatformConfig(missingDatabase)).toThrow("DATABASE_URL");
  });

  it("keeps operational error listeners installed for dependency loss", async () => {
    const dependencies = createPlatformDependencies(loadPlatformConfig(baseEnvironment));
    expect(dependencies.postgres.listenerCount("error")).toBeGreaterThan(0);
    expect(dependencies.redis.listenerCount("error")).toBeGreaterThan(0);
    await dependencies.close();
  });

  it("bounds a dependency probe that never settles", async () => {
    const health = await runDependencyProbe(() => new Promise(() => undefined), 10);
    expect(health.status).toBe("error");
    expect(health.error).toContain("timed out after 10ms");
    expect(health.latencyMs).toBeLessThan(100);
  });
});

describe("artifact evidence persistence", () => {
  it("uploads bounded evidence and registers it with the step in one database transaction", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(() => Promise.resolve(client)) };
    const objects = {
      putObject: vi.fn(() => Promise.resolve()),
      removeObject: vi.fn(() => Promise.resolve()),
      statObject: vi.fn(() => Promise.resolve()),
      getObject: vi.fn(),
    } satisfies ArtifactObjectStore;
    const store = new TestRunStore(pool as never, undefined, {
      client: objects,
      bucket: "test-artifacts",
    });

    await store.recordStep("00000000-0000-4000-8000-000000000001", {
      id: "00000000-0000-4000-8000-000000000002",
      runCaseId: "00000000-0000-4000-8000-000000000003",
      attempt: 2,
      path: "steps[0]",
      stepId: "open-console",
      action: "browser:navigate",
      phase: "main",
      status: "passed",
      result: "passed",
      inputSummary: { action: "browser:navigate" },
      outputSummary: { status: 200 },
      startedAt: new Date(0).toISOString(),
      durationMs: 15,
      artifacts: [
        {
          kind: "screenshot",
          data: Buffer.from("png"),
          contentType: "image/png",
          extension: "png",
        },
      ],
    });

    expect(objects.putObject).toHaveBeenCalledWith(
      "test-artifacts",
      expect.stringContaining("/attempts/2/steps/00000000-0000-4000-8000-000000000002/"),
      Buffer.from("png"),
      3,
      expect.objectContaining({ "X-Amz-Meta-Redacted": "true" }),
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into artifacts"))).toBe(
      true,
    );
    expect(query).toHaveBeenLastCalledWith("commit");
  });

  it("removes an uploaded object when artifact metadata registration rolls back", async () => {
    const query = vi.fn((sql: string) => {
      if (sql.includes("insert into artifacts")) return Promise.reject(new Error("db failed"));
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(() => Promise.resolve(client)) };
    const objects = {
      putObject: vi.fn(() => Promise.resolve()),
      removeObject: vi.fn(() => Promise.resolve()),
      statObject: vi.fn(() => Promise.resolve()),
      getObject: vi.fn(),
    } satisfies ArtifactObjectStore;
    const store = new TestRunStore(pool as never, undefined, {
      client: objects,
      bucket: "test-artifacts",
    });

    await expect(
      store.recordStep("00000000-0000-4000-8000-000000000001", {
        id: "00000000-0000-4000-8000-000000000002",
        runCaseId: "00000000-0000-4000-8000-000000000003",
        attempt: 1,
        path: "steps[0]",
        stepId: "open-console",
        action: "browser:navigate",
        phase: "main",
        status: "passed",
        result: "passed",
        inputSummary: {},
        startedAt: new Date(0).toISOString(),
        durationMs: 15,
        artifacts: [
          {
            kind: "trace",
            data: Buffer.from("zip"),
            contentType: "application/zip",
            extension: "zip",
          },
        ],
      }),
    ).rejects.toThrow("db failed");

    expect(objects.removeObject).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]) => sql === "rollback")).toBe(true);
  });

  it("reports a missing MinIO object through stable artifact availability metadata", async () => {
    const pool = {
      query: vi.fn(() =>
        Promise.resolve({
          rows: [
            {
              id: "00000000-0000-4000-8000-000000000004",
              run_id: "00000000-0000-4000-8000-000000000001",
              run_case_id: "00000000-0000-4000-8000-000000000003",
              step_run_id: "00000000-0000-4000-8000-000000000002",
              attempt: 1,
              kind: "trace",
              object_key: "missing.zip",
              size_bytes: 3,
              sha256: "a".repeat(64),
              redacted: true,
              locked: false,
              retained_until: new Date(Date.now() + 60_000),
              created_at: new Date(0),
            },
          ],
        }),
      ),
    };
    const objects = {
      putObject: vi.fn(),
      removeObject: vi.fn(),
      statObject: vi.fn(() =>
        Promise.reject(Object.assign(new Error("missing"), { code: "NoSuchKey" })),
      ),
      getObject: vi.fn(),
    } satisfies ArtifactObjectStore;
    const store = new TestRunStore(pool as never, undefined, {
      client: objects,
      bucket: "test-artifacts",
    });

    await expect(store.listArtifacts("00000000-0000-4000-8000-000000000001")).resolves.toEqual([
      expect.objectContaining({ availability: "missing", attempt: 1 }),
    ]);
  });

  it("locks available evidence and records the retention change atomically", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000004",
      run_id: "00000000-0000-4000-8000-000000000001",
      run_case_id: "00000000-0000-4000-8000-000000000003",
      step_run_id: "00000000-0000-4000-8000-000000000002",
      attempt: 1,
      kind: "screenshot",
      object_key: "available.png",
      size_bytes: 3,
      sha256: "a".repeat(64),
      redacted: true,
      locked: false,
      retained_until: new Date(Date.now() + 60_000),
      created_at: new Date(0),
    } as const;
    const query = vi.fn((sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("select a.*")) return Promise.resolve({ rows: [row] });
      if (sql.includes("update artifacts")) {
        return Promise.resolve({ rows: [{ ...row, locked: true }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(() => Promise.resolve(client)) };
    const objects = {
      putObject: vi.fn(),
      removeObject: vi.fn(),
      statObject: vi.fn(() => Promise.resolve()),
      getObject: vi.fn(),
    } satisfies ArtifactObjectStore;
    const store = new TestRunStore(pool as never, undefined, {
      client: objects,
      bucket: "test-artifacts",
    });

    await expect(store.updateArtifactRetention(row.id, true)).resolves.toMatchObject({
      id: row.id,
      locked: true,
      availability: "available",
    });

    expect(objects.statObject).toHaveBeenCalledWith("test-artifacts", "available.png");
    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          String(sql).includes("artifact.retention_changed") &&
          Array.isArray(values) &&
          String(values[1]).includes('"locked":true'),
      ),
    ).toBe(true);
    expect(query).toHaveBeenLastCalledWith("commit");
  });

  it("does not resurrect expired evidence when a retention lock is requested", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000004",
      run_id: "00000000-0000-4000-8000-000000000001",
      run_case_id: null,
      step_run_id: null,
      attempt: null,
      kind: "trace",
      object_key: "expired.zip",
      size_bytes: 3,
      sha256: "a".repeat(64),
      redacted: true,
      locked: false,
      retained_until: new Date(Date.now() - 60_000),
      created_at: new Date(0),
    } as const;
    const query = vi.fn((sql: string) =>
      sql.includes("select a.*") ? Promise.resolve({ rows: [row] }) : Promise.resolve({ rows: [] }),
    );
    const client = { query, release: vi.fn() };
    const objects = {
      putObject: vi.fn(),
      removeObject: vi.fn(),
      statObject: vi.fn(),
      getObject: vi.fn(),
    } satisfies ArtifactObjectStore;
    const store = new TestRunStore(
      { connect: vi.fn(() => Promise.resolve(client)) } as never,
      undefined,
      { client: objects, bucket: "test-artifacts" },
    );

    await expect(store.updateArtifactRetention(row.id, true)).rejects.toMatchObject({
      code: "ARTIFACT_EXPIRED",
    });
    expect(objects.statObject).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("update artifacts"))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("rollback");
  });

  it("makes a locked artifact expire immediately when its elapsed retention is unlocked", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000004",
      run_id: "00000000-0000-4000-8000-000000000001",
      run_case_id: "00000000-0000-4000-8000-000000000003",
      step_run_id: "00000000-0000-4000-8000-000000000002",
      attempt: 1,
      kind: "screenshot",
      object_key: "locked.png",
      size_bytes: 3,
      sha256: "a".repeat(64),
      redacted: true,
      locked: true,
      retained_until: new Date(Date.now() - 60_000),
      created_at: new Date(0),
    } as const;
    const query = vi.fn((sql: string) => {
      if (sql.includes("select a.*")) return Promise.resolve({ rows: [row] });
      if (sql.includes("update artifacts")) {
        return Promise.resolve({ rows: [{ ...row, locked: false }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: vi.fn() };
    const objects = {
      putObject: vi.fn(),
      removeObject: vi.fn(),
      statObject: vi.fn(() => Promise.resolve()),
      getObject: vi.fn(),
    } satisfies ArtifactObjectStore;
    const store = new TestRunStore(
      { connect: vi.fn(() => Promise.resolve(client)) } as never,
      undefined,
      { client: objects, bucket: "test-artifacts" },
    );

    await expect(store.updateArtifactRetention(row.id, false)).resolves.toMatchObject({
      locked: false,
      availability: "expired",
    });
  });
});

describe("run idempotency locking", () => {
  it("serializes a PostgreSQL-safe and unambiguous advisory lock key", () => {
    const key = serializeRunIdempotencyLockKey("release", "system-id", "request-id");

    expect(key).not.toContain("\u0000");
    expect(JSON.parse(key)).toEqual(["release", "system-id", "request-id"]);
    expect(serializeRunIdempotencyLockKey("ab", "c", "d")).not.toBe(
      serializeRunIdempotencyLockKey("a", "bc", "d"),
    );
  });
});

describe("resource compensation persistence", () => {
  it("qualifies the cleanup timestamp when claiming a job through an UPDATE FROM query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new TestRunStore({ query } as never);

    await expect(store.claimCleanupJob("00000000-0000-4000-8000-000000000001")).resolves.toBeNull();

    const sql = query.mock.calls[0]?.[0] as string | undefined;
    expect(sql).toContain("started_at = coalesce(cj.started_at, now())");
    expect(sql).not.toContain("started_at = coalesce(started_at, now())");
  });
});
