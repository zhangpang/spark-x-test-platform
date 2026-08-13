import { randomUUID } from "node:crypto";

import { runStatuses, type RunStatus, type TestRunJob } from "@spark-x-test/contracts";
import { TestRunStore } from "@spark-x-test/service-runtime";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { badRequest, conflict, notFound } from "./control-plane/errors.js";

export interface RunQueue {
  add(name: string, data: TestRunJob, options: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export type RunRouteStore = Pick<
  TestRunStore,
  "listRuns" | "createRun" | "getRun" | "getRunDetail" | "requestCancellation" | "listEvents"
>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${name} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string, min = 1, max = 200): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw badRequest(`${name} 必须是长度 ${min} 到 ${max} 的字符串。`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!uuidPattern.test(result)) throw badRequest(`${name} 必须是 UUID。`);
  return result;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw badRequest(`${name} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value as number;
}

function routeParams(request: FastifyRequest): Record<string, unknown> {
  return objectValue(request.params, "路径参数");
}

function queryValues(request: FastifyRequest): Record<string, unknown> {
  return objectValue(request.query, "查询参数");
}

function runStatus(value: unknown): RunStatus {
  if (typeof value !== "string" || !runStatuses.includes(value as RunStatus)) {
    throw badRequest(`status 仅允许 ${runStatuses.join("、")}。`);
  }
  return value as RunStatus;
}

function createRunInput(body: unknown, idempotencyHeader?: string) {
  const input = objectValue(body, "请求体");
  const triggerType = input.triggerType ?? "manual";
  if (!(["manual", "schedule", "release", "api"] as const).includes(triggerType as never)) {
    throw badRequest("triggerType 不合法。");
  }
  return {
    triggerType: triggerType as "manual" | "schedule" | "release" | "api",
    triggerSource: stringValue(input.triggerSource ?? "web-console", "triggerSource"),
    idempotencyKey: stringValue(
      idempotencyHeader ?? input.idempotencyKey ?? randomUUID(),
      "idempotencyKey",
      8,
    ),
    priority: input.priority === undefined ? 50 : integer(input.priority, "priority", 1, 100),
    systemId: uuid(input.systemId, "systemId"),
    environmentId: uuid(input.environmentId, "environmentId"),
    suiteId: uuid(input.suiteId, "suiteId"),
    testedVersion:
      input.testedVersion === undefined ? "" : stringValue(input.testedVersion, "testedVersion", 0),
  } as const;
}

export function registerRunRoutes(
  app: FastifyInstance,
  store: RunRouteStore,
  queue: RunQueue,
  prefix: string,
): void {
  app.get(`${prefix}/runs`, async (request) => {
    const values = queryValues(request);
    return {
      items: await store.listRuns({
        ...(values.systemId === undefined ? {} : { systemId: uuid(values.systemId, "systemId") }),
        ...(values.status === undefined ? {} : { status: runStatus(values.status) }),
      }),
    };
  });

  app.post(`${prefix}/runs`, async (request, reply) => {
    let created;
    try {
      const idempotencyHeader = request.headers["idempotency-key"];
      created = await store.createRun(
        createRunInput(
          request.body,
          Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader,
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "RUN_CONTEXT_NOT_FOUND") {
        throw notFound("系统、环境或测试套件");
      }
      if (error instanceof Error && error.message === "RUN_SUITE_EMPTY") {
        throw conflict("测试套件没有可执行的已发布用例。");
      }
      throw error;
    }
    if (created.run.status === "queued") {
      const job: TestRunJob = {
        protocolVersion: "1.0",
        runId: created.run.id,
        queuedAt: created.run.queuedAt,
        priority: created.run.priority,
      };
      await queue.add("run.execute", job, {
        jobId: created.run.id,
        priority: 101 - created.run.priority,
        attempts: 1,
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      });
    }
    return reply.code(created.created ? 202 : 200).send(created.run);
  });

  app.get(`${prefix}/runs/:runId`, async (request) => {
    const detail = await store.getRunDetail(uuid(routeParams(request).runId, "runId"));
    if (detail === null) throw notFound("测试运行");
    return detail;
  });

  app.post(`${prefix}/runs/:runId/cancel`, async (request, reply) => {
    const run = await store.requestCancellation(uuid(routeParams(request).runId, "runId"));
    if (run === null) throw notFound("测试运行");
    if (run.status === "completed") throw conflict("测试运行已经结束，不能再取消。");
    return reply.code(202).send(run);
  });

  app.get(`${prefix}/runs/:runId/events`, async (request, reply) => {
    const runId = uuid(routeParams(request).runId, "runId");
    if ((await store.getRun(runId)) === null) throw notFound("测试运行");
    const values = queryValues(request);
    const headerId = request.headers["last-event-id"];
    const requestedAfter =
      values.after ?? (Array.isArray(headerId) ? headerId[0] : headerId) ?? "0";
    const after = Number(requestedAfter);
    if (!Number.isSafeInteger(after) || after < 0) throw badRequest("事件游标不合法。");
    const events = await store.listEvents(runId, after);
    reply.header("cache-control", "no-cache, no-transform");
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("x-accel-buffering", "no");
    return reply.send(
      `${events
        .map((event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("")}retry: 1500\n\n`,
    );
  });
}
