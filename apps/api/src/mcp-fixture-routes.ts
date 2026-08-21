import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { ControlPlaneError, badRequest } from "./control-plane/errors.js";

export const mcpFixtureAuthorization = "Bearer spark-x-test-platform-noncredential-mcp-fixture";
export const mcpFixturePathV1 = "/fixtures/mcp/read-only/v1";
export const mcpFixturePathV2 = "/fixtures/mcp/read-only/v2";
export const mcpFixtureToolName = "lookup_fixture";

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedRequestKeys = new Set(["jsonrpc", "id", "method", "params"]);
const requestMethods = new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "prompts/list",
  "tools/call",
]);

type FixtureVersion = "v1" | "v2";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>> | null;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function authorize(request: FastifyRequest): string {
  if (headerValue(request.headers.authorization) !== mcpFixtureAuthorization) {
    throw new ControlPlaneError("MCP_FIXTURE_UNAUTHORIZED", "MCP 夹具认证失败。", 401);
  }
  const runId = headerValue(request.headers["x-spark-x-run-id"]);
  if (runId === undefined || !runIdPattern.test(runId)) {
    throw new ControlPlaneError(
      "MCP_FIXTURE_RUN_ID_REQUIRED",
      "MCP 夹具必须绑定有效运行标识。",
      400,
    );
  }
  return runId.toLowerCase();
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function requestValue(body: unknown): JsonRpcRequest {
  const request = objectValue(body);
  if (request === null) throw badRequest("MCP 夹具请求必须是单个 JSON-RPC 对象。");
  if (Object.keys(request).some((key) => !allowedRequestKeys.has(key))) {
    throw badRequest("MCP 夹具请求包含未支持字段。");
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    throw badRequest("MCP 夹具 JSON-RPC 版本或方法无效。");
  }
  const notification = request.method === "notifications/initialized";
  if (!notification && !requestMethods.has(request.method)) {
    throw badRequest("MCP 夹具方法不在固定白名单内。");
  }
  if (
    (!notification &&
      (typeof request.id !== "number" || !Number.isSafeInteger(request.id) || request.id < 0)) ||
    (notification && request.id !== undefined)
  ) {
    throw badRequest("MCP 夹具请求标识与方法类型不匹配。");
  }
  if (
    request.params !== undefined &&
    request.params !== null &&
    objectValue(request.params) === null
  ) {
    throw badRequest("MCP 夹具参数必须是对象或 null。");
  }
  return request as unknown as JsonRpcRequest;
}

function sessionId(runId: string, version: FixtureVersion): string {
  return `spark-x-mcp-${version}-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

function assertSession(
  request: FastifyRequest,
  input: JsonRpcRequest,
  runId: string,
  version: FixtureVersion,
): string {
  const expected = sessionId(runId, version);
  const actual = headerValue(request.headers["mcp-session-id"]);
  if (input.method === "initialize") {
    if (actual !== undefined) throw badRequest("MCP 初始化请求不得复用旧会话。");
    return expected;
  }
  if (actual !== expected) {
    throw new ControlPlaneError("MCP_FIXTURE_SESSION_INVALID", "MCP 夹具会话无效。", 401);
  }
  return expected;
}

function toolDescriptor(version: FixtureVersion): Readonly<Record<string, unknown>> {
  return {
    name: mcpFixtureToolName,
    description:
      version === "v1"
        ? "Read one deterministic fixture record (revision one)."
        : "Read one deterministic fixture record (revision two).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["reference", "limit"],
      properties: {
        reference: { type: "string", pattern: "^MCP-FIXTURE:[0-9a-f-]{36}$" },
        limit: { type: "integer", minimum: 1, maximum: 1 },
        ...(version === "v1"
          ? {}
          : { revision_hint: { type: "string", const: "v2", default: "v2" } }),
      },
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

function toolCallResult(
  params: Readonly<Record<string, unknown>> | null | undefined,
  runId: string,
  version: FixtureVersion,
): Readonly<Record<string, unknown>> {
  const name = params?.name;
  const argumentsValue = objectValue(params?.arguments);
  const allowedArgumentKeys =
    version === "v1"
      ? new Set(["reference", "limit"])
      : new Set(["reference", "limit", "revision_hint"]);
  if (
    name !== mcpFixtureToolName ||
    argumentsValue === null ||
    argumentsValue.reference !== `MCP-FIXTURE:${runId}` ||
    argumentsValue.limit !== 1 ||
    Object.keys(argumentsValue).some((key) => !allowedArgumentKeys.has(key)) ||
    (version === "v2" &&
      argumentsValue.revision_hint !== undefined &&
      argumentsValue.revision_hint !== "v2")
  ) {
    throw badRequest("MCP 夹具工具名或参数超出固定边界。");
  }
  const structuredContent = {
    success: true,
    fixture_version: version,
    reference: `MCP-FIXTURE:${runId}`,
    record_count: 1,
    record: {
      status: "stable",
      revision: version === "v1" ? 1 : 2,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  };
}

function responseFor(
  input: JsonRpcRequest,
  runId: string,
  version: FixtureVersion,
): Readonly<Record<string, unknown>> {
  let result: Readonly<Record<string, unknown>>;
  switch (input.method) {
    case "initialize":
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `spark-x-test-platform-mcp-fixture-${version}`, version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = { tools: [toolDescriptor(version)] };
      break;
    case "resources/list":
      result = { resources: [] };
      break;
    case "prompts/list":
      result = { prompts: [] };
      break;
    case "tools/call":
      result = toolCallResult(input.params, runId, version);
      break;
    default:
      throw badRequest("MCP 夹具请求方法无效。");
  }
  return { jsonrpc: "2.0", id: input.id, result };
}

function registerVersionRoute(
  app: FastifyInstance,
  prefix: string,
  path: string,
  version: FixtureVersion,
): void {
  app.post(`${prefix}${path}`, { bodyLimit: 128_000 }, async (request, reply) => {
    const runId = authorize(request);
    const input = requestValue(request.body);
    const session = assertSession(request, input, runId, version);
    if (input.method === "notifications/initialized") {
      return reply.code(202).header("Mcp-Session-Id", session).send();
    }
    return reply
      .code(200)
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header("Mcp-Session-Id", session)
      .send(responseFor(input, runId, version));
  });
}

export function registerMcpFixtureRoutes(
  app: FastifyInstance,
  enabled: boolean,
  prefix: string,
): void {
  if (!enabled) return;
  registerVersionRoute(app, prefix, mcpFixturePathV1, "v1");
  registerVersionRoute(app, prefix, mcpFixturePathV2, "v2");
}
