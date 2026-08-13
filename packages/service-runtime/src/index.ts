import { randomUUID } from "node:crypto";

import {
  dependencyNames,
  platformVersion,
  type DependencyHealth,
  type DependencyName,
  type HealthResponse,
  type ServiceName,
} from "@spark-x-test/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { Client as MinioClient } from "minio";
import { Pool } from "pg";

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
