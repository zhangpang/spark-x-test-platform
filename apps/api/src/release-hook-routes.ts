import { createHmac, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { ControlPlaneError, badRequest, conflict, notFound } from "./control-plane/errors.js";
import { enqueueRun, type RunQueue, type RunRouteStore } from "./run-routes.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commitPattern = /^[0-9a-f]{40}$/;
const releaseTaskPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const signaturePattern = /^sha256=([0-9a-f]{64})$/;
const allowedClockSkewSeconds = 300;
const releasePriority = 75;

export interface ReleaseHookConfig {
  readonly secret: Buffer;
  readonly systemId: string;
  readonly environmentId: string;
  readonly suiteId: string;
}

interface ReleaseCompletedPayload {
  readonly event: "release.completed";
  readonly releaseTaskId: string;
  readonly testedVersion: string;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

export function resolveReleaseHookConfig(environment: NodeJS.ProcessEnv): ReleaseHookConfig | null {
  const secret = environment.PLATFORM_RELEASE_WEBHOOK_SECRET?.trim();
  const systemId = environment.PLATFORM_SPARK_X_AGENT_SYSTEM_ID?.trim();
  const environmentId = environment.PLATFORM_SPARK_X_AGENT_ENVIRONMENT_ID?.trim();
  const suiteId = environment.PLATFORM_SPARK_X_AGENT_CORE_SUITE_ID?.trim();
  const values = [secret, systemId, environmentId, suiteId];
  if (values.every((value) => value === undefined || value === "")) return null;
  if (values.some((value) => value === undefined || value === "")) {
    throw new Error("Spark X Agent release hook configuration must be complete");
  }
  if (Buffer.byteLength(secret as string, "utf8") < 32) {
    throw new Error("PLATFORM_RELEASE_WEBHOOK_SECRET must contain at least 32 UTF-8 bytes");
  }
  for (const [name, value] of [
    ["PLATFORM_SPARK_X_AGENT_SYSTEM_ID", systemId],
    ["PLATFORM_SPARK_X_AGENT_ENVIRONMENT_ID", environmentId],
    ["PLATFORM_SPARK_X_AGENT_CORE_SUITE_ID", suiteId],
  ] as const) {
    if (!uuidPattern.test(value as string)) throw new Error(`${name} must be a UUID`);
  }
  return {
    secret: Buffer.from(secret as string, "utf8"),
    systemId: systemId as string,
    environmentId: environmentId as string,
    suiteId: suiteId as string,
  };
}

function payloadValue(body: unknown): ReleaseCompletedPayload {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("请求体必须是对象。");
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  const expectedKeys = ["event", "releaseTaskId", "testedVersion"];
  if (keys.some((key) => !expectedKeys.includes(key))) {
    throw badRequest("发布回调请求包含未支持的字段。");
  }
  if (input.event !== "release.completed") {
    throw badRequest("event 仅允许 release.completed。");
  }
  if (typeof input.releaseTaskId !== "string" || !releaseTaskPattern.test(input.releaseTaskId)) {
    throw badRequest("releaseTaskId 格式不合法。");
  }
  if (typeof input.testedVersion !== "string" || !commitPattern.test(input.testedVersion)) {
    throw badRequest("testedVersion 必须是 40 位小写 Git Commit。");
  }
  return {
    event: "release.completed",
    releaseTaskId: input.releaseTaskId,
    testedVersion: input.testedVersion,
  };
}

function canonicalPayload(payload: ReleaseCompletedPayload): string {
  return JSON.stringify({
    event: payload.event,
    releaseTaskId: payload.releaseTaskId,
    testedVersion: payload.testedVersion,
  });
}

function authenticate(
  request: FastifyRequest,
  payload: ReleaseCompletedPayload,
  secret: Buffer,
  now: () => number,
): void {
  const timestamp = headerValue(request.headers["x-spark-release-timestamp"]);
  const signature = headerValue(request.headers["x-spark-release-signature"]);
  const seconds = timestamp === undefined ? Number.NaN : Number(timestamp);
  const signatureMatch = signature?.match(signaturePattern);
  const receivedHex = signatureMatch?.[1];
  const timestampValid =
    timestamp !== undefined &&
    /^\d{10}$/.test(timestamp) &&
    Number.isSafeInteger(seconds) &&
    Math.abs(Math.floor(now() / 1_000) - seconds) <= allowedClockSkewSeconds;
  if (!timestampValid || receivedHex === undefined) {
    throw new ControlPlaneError("RELEASE_HOOK_UNAUTHORIZED", "发布回调认证失败。", 401);
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${canonicalPayload(payload)}`, "utf8")
    .digest();
  const received = Buffer.from(receivedHex, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ControlPlaneError("RELEASE_HOOK_UNAUTHORIZED", "发布回调认证失败。", 401);
  }
}

export function registerReleaseHookRoutes(
  app: FastifyInstance,
  store: Pick<RunRouteStore, "createRun">,
  queue: RunQueue,
  config: ReleaseHookConfig | null,
  prefix: string,
  now: () => number = Date.now,
): void {
  app.post(`${prefix}/release-hooks/spark-x-agent`, async (request, reply) => {
    if (config === null) {
      throw new ControlPlaneError("RELEASE_HOOK_DISABLED", "星火 Agent 发布回调尚未配置。", 503);
    }
    const payload = payloadValue(request.body);
    authenticate(request, payload, config.secret, now);

    const triggerSource = `youlan:${payload.releaseTaskId}`;
    const idempotencyKey = `spark-x-agent-release:${payload.releaseTaskId}`;
    let created;
    try {
      created = await store.createRun({
        triggerType: "release",
        triggerSource,
        idempotencyKey,
        priority: releasePriority,
        systemId: config.systemId,
        environmentId: config.environmentId,
        suiteId: config.suiteId,
        testedVersion: payload.testedVersion,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "RUN_CONTEXT_NOT_FOUND") {
        throw notFound("星火 Agent 系统、环境或核心冒烟套件");
      }
      if (error instanceof Error && error.message === "RUN_SUITE_EMPTY") {
        throw conflict("星火 Agent 核心冒烟套件没有可执行的已发布用例。");
      }
      throw error;
    }

    const run = created.run;
    if (
      run.triggerType !== "release" ||
      run.triggerSource !== triggerSource ||
      run.idempotencyKey !== idempotencyKey ||
      run.systemId !== config.systemId ||
      run.environmentId !== config.environmentId ||
      run.suiteId !== config.suiteId ||
      run.testedVersion !== payload.testedVersion
    ) {
      throw new ControlPlaneError(
        "RELEASE_HOOK_CONFLICT",
        "发布任务已关联到不同的测试运行上下文。",
        409,
      );
    }

    await enqueueRun(run, queue);
    return reply.code(created.created ? 202 : 200).send({
      event: payload.event,
      releaseTaskId: payload.releaseTaskId,
      testedVersion: payload.testedVersion,
      duplicate: !created.created,
      run,
    });
  });
}
