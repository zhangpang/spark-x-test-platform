import { apiVersion, platformVersion } from "@spark-x-test/contracts";
import { createServiceApplication, TestRunStore } from "@spark-x-test/service-runtime";
import { Queue } from "bullmq";

import { ControlPlaneError } from "./control-plane/errors.js";
import type { ControlPlaneRepository } from "./control-plane/model.js";
import {
  PostgresControlPlaneRepository,
  type SqlExecutor,
} from "./control-plane/postgres-store.js";
import { registerControlPlaneRoutes } from "./control-plane/routes.js";
import { SecretVault } from "./control-plane/secrets.js";
import { ControlPlaneService } from "./control-plane/service.js";
import { registerReleaseHookRoutes, resolveReleaseHookConfig } from "./release-hook-routes.js";
import { registerRunRoutes, type RunQueue, type RunRouteStore } from "./run-routes.js";

interface DatabaseError {
  readonly code?: string;
}

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as DatabaseError).code
    : undefined;
}

export function buildApiApplication(
  environment: NodeJS.ProcessEnv = process.env,
  options: Readonly<{
    repository?: ControlPlaneRepository;
    runQueue?: RunQueue;
    runStore?: RunRouteStore;
  }> = {},
) {
  const releaseHookConfig = resolveReleaseHookConfig(environment);
  const application = createServiceApplication("api", {
    environment,
    healthPrefix: `/api/${apiVersion}`,
    logger: environment.NODE_ENV !== "test",
  });
  const sql: SqlExecutor = {
    async query<Row>(text: string, values?: readonly unknown[]) {
      const result = await application.dependencies.postgres.query(
        text,
        values === undefined ? undefined : [...values],
      );
      return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
    },
    async transaction<Result>(work: (sql: SqlExecutor) => Promise<Result>) {
      const client = await application.dependencies.postgres.connect();
      const transactionSql: SqlExecutor = {
        async query<Row>(text: string, values?: readonly unknown[]) {
          const result = await client.query(text, values === undefined ? undefined : [...values]);
          return { rows: result.rows as readonly Row[], rowCount: result.rowCount };
        },
        transaction<NestedResult>(nestedWork: (sql: SqlExecutor) => Promise<NestedResult>) {
          return nestedWork(transactionSql);
        },
      };
      try {
        await client.query("begin");
        const result = await work(transactionSql);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
  const repository = options.repository ?? new PostgresControlPlaneRepository(sql);
  const controlPlane = new ControlPlaneService(
    repository,
    new SecretVault(environment.PLATFORM_SECRET_ENCRYPTION_KEY),
  );
  const runStore =
    options.runStore ??
    new TestRunStore(application.dependencies.postgres, undefined, {
      client: application.dependencies.minio,
      bucket: application.config.minio.bucket,
    });
  const queue =
    options.runQueue ??
    (environment.NODE_ENV === "test"
      ? { add: () => Promise.resolve() }
      : new Queue(`${application.config.queueName}-runs`, {
          connection: { url: application.config.redisUrl },
        }));

  application.app.get(`/api/${apiVersion}`, () => ({
    name: "spark-x-test-platform",
    version: platformVersion,
    apiVersion,
    phase: "M3-run-evidence-loop",
  }));

  registerControlPlaneRoutes(application.app, controlPlane, `/api/${apiVersion}`);
  registerRunRoutes(application.app, runStore, queue, `/api/${apiVersion}`);
  registerReleaseHookRoutes(
    application.app,
    runStore,
    queue,
    releaseHookConfig,
    `/api/${apiVersion}`,
  );

  if (queue instanceof Queue) {
    application.app.addHook("onClose", () => queue.close());
  }

  application.app.setErrorHandler((error, request, reply) => {
    if (error instanceof ControlPlaneError) {
      return reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        requestId: String(request.id),
        details: error.details,
      });
    }
    const code = databaseErrorCode(error);
    if (code === "23505") {
      return reply.code(409).send({
        code: "CONFLICT",
        message: "同一范围内已存在相同标识的资源。",
        requestId: String(request.id),
        details: [],
      });
    }
    if (code === "23503" || code === "23514" || code === "22P02") {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "请求引用或约束不合法。",
        requestId: String(request.id),
        details: [],
      });
    }
    request.log.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        databaseCode: code,
        requestId: String(request.id),
      },
      "control-plane request failed",
    );
    return reply.code(500).send({
      code: "INTERNAL_ERROR",
      message: "平台处理请求失败。",
      requestId: String(request.id),
      details: [],
    });
  });

  return application;
}
