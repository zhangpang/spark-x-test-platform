import { describe, expect, it } from "vitest";

import {
  createPlatformDependencies,
  loadPlatformConfig,
  runDependencyProbe,
  serializeRunIdempotencyLockKey,
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
