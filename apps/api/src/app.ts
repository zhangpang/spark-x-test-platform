import { apiVersion, platformVersion } from "@spark-x-test/contracts";
import { createServiceApplication } from "@spark-x-test/service-runtime";

import { ControlPlaneError } from "./control-plane/errors.js";
import type { ControlPlaneRepository } from "./control-plane/model.js";
import {
  PostgresControlPlaneRepository,
  type SqlExecutor,
} from "./control-plane/postgres-store.js";
import { registerControlPlaneRoutes } from "./control-plane/routes.js";
import { SecretVault } from "./control-plane/secrets.js";
import { ControlPlaneService } from "./control-plane/service.js";

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
  options: Readonly<{ repository?: ControlPlaneRepository }> = {},
) {
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
  };
  const repository = options.repository ?? new PostgresControlPlaneRepository(sql);
  const controlPlane = new ControlPlaneService(
    repository,
    new SecretVault(environment.PLATFORM_SECRET_ENCRYPTION_KEY),
  );

  application.app.get(`/api/${apiVersion}`, () => ({
    name: "spark-x-test-platform",
    version: platformVersion,
    apiVersion,
    phase: "M2-test-asset-control-plane",
  }));

  registerControlPlaneRoutes(application.app, controlPlane, `/api/${apiVersion}`);

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
