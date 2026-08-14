import { createHash } from "node:crypto";

import type { AdapterManifest } from "@spark-x-test/adapter-sdk";
import {
  assertHttpTargetAllowed,
  executeHttpRequest,
  ExecutorFailure,
  interpolateString,
  type HttpExecutionEnvironment,
  type HttpExecutionResult,
} from "@spark-x-test/executors";

export const sparkXAgentActions = [
  "adapter:spark-x-agent/conversation.create",
  "adapter:spark-x-agent/conversation.assert-recent",
  "adapter:spark-x-agent/conversation.delete",
  "adapter:spark-x-agent/chat.ask",
  "adapter:spark-x-agent/chat.assert-history",
  "adapter:spark-x-agent/tool.assert-safe-catalog",
  "adapter:spark-x-agent/tool.invoke-safe",
  "adapter:spark-x-agent/tool.assert-history",
] as const;

export type SparkXAgentAction = (typeof sparkXAgentActions)[number];

export interface SparkXAgentExecutionOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

const conversationActionCapabilities = [
  {
    key: "conversation.create",
    name: "创建会话",
    description: "使用受控登录凭据创建带运行标识的星火 Agent 会话。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "conversation.delete",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "title"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["conversationId", "title"],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        title: { type: "string" },
      },
    },
  },
  {
    key: "conversation.assert-recent",
    name: "校验最近会话",
    description: "验证新会话出现在最近会话列表的首个非置顶位置。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "title"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["conversationId", "listed", "recentPosition", "messageCount"],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        listed: { const: true },
        recentPosition: { type: "integer", minimum: 0 },
        messageCount: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    key: "chat.ask",
    name: "发送对话并校验回复",
    description: "向已登记测试会话发送带运行标识的受控消息，并校验完整 SSE 回复。",
    actionLevel: "write",
    defaultTimeoutMs: 120_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "message", "expectedText"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        message: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedText: { type: "string", minLength: 1, maxLength: 5_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "done",
        "expectedTextMatched",
        "contentEventCount",
        "statusEventCount",
        "assistantPreviewEventCount",
        "toolEventCount",
        "skillEventCount",
        "reviewEventCount",
        "streamBytes",
        "streamedContentLength",
        "finalContentLength",
        "finalContentSha256",
        "truncated",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        done: { const: true },
        expectedTextMatched: { const: true },
        contentEventCount: { type: "integer", minimum: 1 },
        statusEventCount: { type: "integer", minimum: 0 },
        assistantPreviewEventCount: { type: "integer", minimum: 0 },
        toolEventCount: { type: "integer", minimum: 0 },
        skillEventCount: { type: "integer", minimum: 0 },
        reviewEventCount: { type: "integer", minimum: 0 },
        streamBytes: { type: "integer", minimum: 1, maximum: 1_000_000 },
        streamedContentLength: { type: "integer", minimum: 1 },
        finalContentLength: { type: "integer", minimum: 1 },
        finalContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        truncated: { const: false },
        stopReason: { type: "string" },
        durationMs: { type: "number", minimum: 0 },
      },
    },
  },
  {
    key: "chat.assert-history",
    name: "校验对话历史",
    description: "重新登录并校验用户消息、助手回复和终止原因已完整持久化。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "expectedUserText",
        "expectedAssistantText",
        "expectedAssistantSha256",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        expectedUserText: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedAssistantText: {
          type: "string",
          minLength: 1,
          maxLength: 5_000,
        },
        expectedAssistantSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "expectedUserTextMatched",
        "expectedAssistantTextMatched",
        "assistantContentLength",
        "assistantContentSha256",
        "assistantFinishReason",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        messageCount: { type: "integer", minimum: 2 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 1 },
        expectedUserTextMatched: { const: true },
        expectedAssistantTextMatched: { const: true },
        assistantContentLength: { type: "integer", minimum: 1 },
        assistantContentSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
        },
        assistantFinishReason: { const: "stop" },
        assistantTurnStatus: { type: "string" },
      },
    },
  },
  {
    key: "tool.assert-safe-catalog",
    name: "校验安全工具目录",
    description:
      "校验当前用户可见的 builtin-demo 只读工具目录与管理员登记目录一致，且不暴露连接凭据。",
    actionLevel: "read",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "serverName",
        "visible",
        "running",
        "credentialFieldsAbsent",
        "advertisedToolCount",
        "enabledDiscoveredToolCount",
        "expectedToolsMatched",
        "catalogSha256",
      ],
      properties: {
        serverName: { const: "builtin-demo" },
        visible: { const: true },
        running: { const: true },
        credentialFieldsAbsent: { const: true },
        advertisedToolCount: { const: 3 },
        enabledDiscoveredToolCount: { const: 3 },
        expectedToolsMatched: { const: true },
        catalogSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "tool.invoke-safe",
    name: "调用并校验安全工具",
    description:
      "通过受控对话只调用已允许的 builtin-demo 只读工具，并校验名称、参数、结果和最终回复。",
    actionLevel: "write",
    defaultTimeoutMs: 120_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "message",
        "expectedText",
        "expectedToolName",
        "expectedArgumentsJson",
        "expectedResultJson",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        message: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedText: { type: "string", minLength: 1, maxLength: 5_000 },
        expectedToolName: { type: "string", minLength: 1, maxLength: 200 },
        expectedArgumentsJson: { type: "string", minLength: 2, maxLength: 20_000 },
        expectedResultJson: { type: "string", minLength: 2, maxLength: 20_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "done",
        "expectedTextMatched",
        "expectedToolNameMatched",
        "argumentsMatched",
        "resultMatched",
        "toolCallCount",
        "toolResultCount",
        "reviewEventCount",
        "toolCallIdSha256",
        "argumentsSha256",
        "resultSha256",
        "finalContentLength",
        "finalContentSha256",
        "streamBytes",
        "truncated",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        done: { const: true },
        expectedTextMatched: { const: true },
        expectedToolNameMatched: { const: true },
        argumentsMatched: { const: true },
        resultMatched: { const: true },
        toolCallCount: { const: 1 },
        toolResultCount: { const: 1 },
        reviewEventCount: { const: 0 },
        toolCallIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        argumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        resultSha256: { type: "string", minLength: 64, maxLength: 64 },
        finalContentLength: { type: "integer", minimum: 1 },
        finalContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        streamBytes: { type: "integer", minimum: 1, maximum: 1_000_000 },
        truncated: { const: false },
      },
    },
  },
  {
    key: "tool.assert-history",
    name: "校验工具调用历史",
    description: "重新登录并校验工具调用、工具结果、公开执行轨迹和最终助手回复已一致持久化。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "expectedUserText",
        "expectedAssistantText",
        "expectedAssistantSha256",
        "expectedToolName",
        "expectedArgumentsSha256",
        "expectedResultSha256",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        expectedUserText: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedAssistantText: { type: "string", minLength: 1, maxLength: 5_000 },
        expectedAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
        expectedToolName: { type: "string", minLength: 1, maxLength: 200 },
        expectedArgumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        expectedResultSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "toolMessageCount",
        "toolCallCount",
        "toolResultCount",
        "traceToolCallCount",
        "traceToolResultCount",
        "expectedUserTextMatched",
        "expectedAssistantTextMatched",
        "expectedToolNameMatched",
        "argumentsSha256",
        "resultSha256",
        "assistantContentLength",
        "assistantContentSha256",
        "assistantFinishReason",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        messageCount: { type: "integer", minimum: 4 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 2 },
        toolMessageCount: { const: 1 },
        toolCallCount: { const: 1 },
        toolResultCount: { const: 1 },
        traceToolCallCount: { const: 1 },
        traceToolResultCount: { const: 1 },
        expectedUserTextMatched: { const: true },
        expectedAssistantTextMatched: { const: true },
        expectedToolNameMatched: { const: true },
        argumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        resultSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantContentLength: { type: "integer", minimum: 1 },
        assistantContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantFinishReason: { const: "stop" },
      },
    },
  },
  {
    key: "conversation.delete",
    name: "删除会话",
    description: "重新登录后按会话 ID 执行幂等清理，可用于 finally 与独立补偿任务。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["conversationId", "deleted"],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        deleted: { type: "boolean" },
        alreadyMissing: { type: "boolean" },
      },
    },
  },
] as const;

export const sparkXAgentAdapterManifest: AdapterManifest = {
  manifestVersion: "1.0",
  key: "spark-x-agent",
  name: "星火 Agent",
  version: "0.4.0",
  protocolVersion: "1.0",
  platformRange: ">=0.1.0 <0.2.0",
  environmentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: { baseUrl: { type: "string", format: "uri" } },
  },
  capabilities: {
    actions: conversationActionCapabilities,
    assertions: [],
    fixtures: [],
    telemetry: [],
  },
};

export const sparkXAgentAdapterPhase = "core-smoke-tools" as const;

const maxChatStreamBytes = 1_000_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const safeToolServerName = "builtin-demo";
const safeToolCatalog = ["calculator", "echo", "time"] as const;
const safeQualifiedToolNames = new Set(
  safeToolCatalog.map((name) => `${safeToolServerName}__${name}`),
);
const privateCatalogFields = [
  "command",
  "args",
  "env",
  "address",
  "cwd",
  "filesystem_path",
  "last_error",
] as const;

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBoundedJson(
  value: unknown,
  failure: () => ExecutorFailure,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): void {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > 2_000) throw failure();
  if (typeof value === "number" && !Number.isFinite(value)) throw failure();
  if (typeof value === "string" && value.length > 20_000) throw failure();
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw failure();
    value.forEach((item) => assertBoundedJson(item, failure, depth + 1, budget));
    return;
  }
  const object = objectValue(value);
  if (object === null) return;
  const entries = Object.entries(object);
  if (entries.length > 1_000) throw failure();
  entries.forEach(([key, item]) => {
    if (key.length > 500) throw failure();
    assertBoundedJson(item, failure, depth + 1, budget);
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = objectValue(value);
  if (object !== null) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function structuredObject(
  value: unknown,
  code: string,
  message: string,
  classification: "product_failed" | "test_failed",
): Readonly<Record<string, unknown>> {
  const failure = (): ExecutorFailure => new ExecutorFailure({ code, message, classification });
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > 20_000) throw failure();
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new ExecutorFailure({ code, message, classification }, error);
    }
  }
  const object = objectValue(parsed);
  if (object === null) throw failure();
  assertBoundedJson(object, failure);
  return object;
}

function expectedJsonObject(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const value = requiredString(params, name, variables, 20_000);
  return structuredObject(
    value,
    "SPARK_X_AGENT_PARAMETER_INVALID",
    `星火 Agent 适配器参数 ${name} 必须是受限 JSON 对象。`,
    "test_failed",
  );
}

function requiredSha256(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
): string {
  const value = requiredString(params, name, variables, 64);
  if (!sha256Pattern.test(value)) {
    throw assertionFailure(
      "SPARK_X_AGENT_PARAMETER_INVALID",
      `星火 Agent 适配器参数 ${name} 必须是 64 位小写 SHA-256。`,
    );
  }
  return value;
}

function requiredSafeToolName(
  params: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
): string {
  const value = requiredString(params, "expectedToolName", variables, 200);
  if (!safeQualifiedToolNames.has(value)) {
    throw assertionFailure(
      "SPARK_X_AGENT_TOOL_NOT_ALLOWED",
      "当前星火 Agent 工具回归动作只允许 builtin-demo 只读工具。",
    );
  }
  return value;
}

function requiredString(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
  maxLength: number,
): string {
  const value = params[name];
  if (typeof value !== "string") {
    throw new ExecutorFailure({
      code: "SPARK_X_AGENT_PARAMETER_INVALID",
      message: `星火 Agent 适配器缺少字符串参数 ${name}。`,
      classification: "test_failed",
    });
  }
  const interpolated = interpolateString(value, variables);
  if (interpolated.trim() === "" || interpolated.length > maxLength) {
    throw new ExecutorFailure({
      code: "SPARK_X_AGENT_PARAMETER_INVALID",
      message: `星火 Agent 适配器参数 ${name} 为空或超过安全长度。`,
      classification: "test_failed",
    });
  }
  return interpolated;
}

function apiFailure(code: string, message: string, status?: number): ExecutorFailure {
  return new ExecutorFailure({
    code,
    message,
    classification: status === 401 || status === 403 ? "environment_failed" : "product_failed",
  });
}

function assertionFailure(code: string, message: string): ExecutorFailure {
  return new ExecutorFailure({ code, message, classification: "test_failed" });
}

function environmentFailure(code: string, message: string): ExecutorFailure {
  return new ExecutorFailure({ code, message, classification: "environment_failed" });
}

function dataEnvelope(body: unknown, code: string): Readonly<Record<string, unknown>> {
  const envelope = objectValue(body);
  const data = envelope === null ? null : objectValue(envelope.data);
  if (envelope?.success !== true || data === null) {
    throw apiFailure(code, "星火 Agent 返回了不完整的结构化响应。");
  }
  return data;
}

function accepted(response: HttpExecutionResult, code: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw apiFailure(code, `星火 Agent 接口返回 HTTP ${response.status}。`, response.status);
  }
}

function actionPath(suffix: string): string {
  return `/trade/api${suffix}`;
}

async function executeSparkXAgentRequest(
  environment: HttpExecutionEnvironment,
  parameters: Parameters<typeof executeHttpRequest>[1],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch | undefined,
): Promise<HttpExecutionResult> {
  return executeHttpRequest(
    environment,
    parameters,
    {},
    {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      ...(fetcher === undefined ? {} : { fetcher }),
    },
  );
}

async function login(
  environment: HttpExecutionEnvironment,
  username: string,
  password: string,
  options: SparkXAgentExecutionOptions,
): Promise<string> {
  const response = await executeSparkXAgentRequest(
    environment,
    {
      method: "POST",
      path: actionPath("/auth/login"),
      headers: { "Content-Type": "application/json" },
      body: { username, password },
    },
    options.timeoutMs,
    options.signal,
    options.fetcher,
  );
  accepted(response, "SPARK_X_AGENT_AUTH_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_AUTH_RESPONSE_INVALID");
  if (typeof data.token !== "string" || data.token.length < 16) {
    throw apiFailure(
      "SPARK_X_AGENT_AUTH_RESPONSE_INVALID",
      "星火 Agent 登录响应未提供有效的内存访问令牌。",
    );
  }
  return data.token;
}

async function authenticatedRequest(
  environment: HttpExecutionEnvironment,
  token: string,
  parameters: Parameters<typeof executeHttpRequest>[1],
  options: SparkXAgentExecutionOptions,
): Promise<HttpExecutionResult> {
  return executeSparkXAgentRequest(
    environment,
    {
      ...parameters,
      headers: { ...parameters.headers, Authorization: `Bearer ${token}` },
    },
    options.timeoutMs,
    options.signal,
    options.fetcher,
  );
}

interface SparkXAgentToolCallTrace {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface SparkXAgentToolResultTrace {
  readonly id: string;
  readonly name: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly success: boolean;
}

interface SparkXAgentChatResult {
  readonly conversationId: string;
  readonly contentEventCount: number;
  readonly statusEventCount: number;
  readonly assistantPreviewEventCount: number;
  readonly toolEventCount: number;
  readonly skillEventCount: number;
  readonly reviewEventCount: number;
  readonly toolCalls: readonly SparkXAgentToolCallTrace[];
  readonly toolResults: readonly SparkXAgentToolResultTrace[];
  readonly streamBytes: number;
  readonly streamedContent: string;
  readonly finalContent: string;
  readonly truncated: boolean;
  readonly stopReason?: string;
  readonly durationMs?: number;
}

function parseChatStream(text: string, streamBytes: number): SparkXAgentChatResult {
  let conversationId: string | undefined;
  let streamedContent = "";
  let finalContent: string | undefined;
  let truncated = false;
  let doneEventCount = 0;
  let contentEventCount = 0;
  let statusEventCount = 0;
  let assistantPreviewEventCount = 0;
  let toolEventCount = 0;
  let skillEventCount = 0;
  let reviewEventCount = 0;
  const toolCalls: SparkXAgentToolCallTrace[] = [];
  const toolResults: SparkXAgentToolResultTrace[] = [];
  let stopReason: string | undefined;
  let durationMs: number | undefined;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("data:")) continue;
    const rawData = line.slice(5).trimStart();
    if (rawData === "") continue;
    let payload: Readonly<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(rawData) as unknown;
      const record = objectValue(parsed);
      if (record === null) throw new Error("SSE payload is not an object");
      payload = record;
    } catch (error) {
      throw new ExecutorFailure(
        {
          code: "SPARK_X_AGENT_CHAT_STREAM_INVALID",
          message: "星火 Agent 对话流包含无法解析的结构化事件。",
          classification: "product_failed",
        },
        error,
      );
    }
    const event = payload.event;
    const data = objectValue(payload.data) ?? {};
    if (event === "conversation_id") {
      if (typeof data.conversation_id === "string") conversationId = data.conversation_id;
    } else if (event === "content") {
      if (typeof data.content !== "string") {
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_STREAM_INVALID",
          "星火 Agent 内容事件缺少字符串增量。",
        );
      }
      contentEventCount += 1;
      streamedContent += data.content;
    } else if (event === "status" || event === "progress" || event === "heartbeat") {
      statusEventCount += 1;
    } else if (event === "assistant_preview") {
      assistantPreviewEventCount += 1;
    } else if (event === "tool_call") {
      toolEventCount += 1;
      if (
        typeof data.id !== "string" ||
        data.id.trim() === "" ||
        data.id.length > 512 ||
        typeof data.name !== "string" ||
        data.name.trim() === "" ||
        data.name.length > 200
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具调用事件缺少受限标识或工具名称。",
        );
      }
      toolCalls.push({
        id: data.id,
        name: data.name,
        arguments: structuredObject(
          data.arguments,
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具调用事件缺少受限结构化参数。",
          "product_failed",
        ),
      });
    } else if (event === "tool_result") {
      toolEventCount += 1;
      if (
        typeof data.id !== "string" ||
        data.id.trim() === "" ||
        data.id.length > 512 ||
        typeof data.name !== "string" ||
        data.name.trim() === "" ||
        data.name.length > 200 ||
        typeof data.success !== "boolean"
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具结果事件缺少受限标识、名称或成功状态。",
        );
      }
      toolResults.push({
        id: data.id,
        name: data.name,
        result: structuredObject(
          data.result,
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具结果事件缺少受限结构化结果。",
          "product_failed",
        ),
        success: data.success,
      });
    } else if (event === "skill") {
      skillEventCount += 1;
    } else if (event === "review_required") {
      reviewEventCount += 1;
    } else if (event === "done") {
      doneEventCount += 1;
      truncated = data.truncated === true;
      if (typeof data.final_content === "string") finalContent = data.final_content;
      if (typeof data.stop_reason === "string") stopReason = data.stop_reason;
      if (typeof data.duration_ms === "number" && Number.isFinite(data.duration_ms)) {
        durationMs = Math.max(0, data.duration_ms);
      }
    } else if (event === "error") {
      throw apiFailure("SPARK_X_AGENT_CHAT_STREAM_ERROR", "星火 Agent 对话流返回了终止错误事件。");
    }
  }

  if (doneEventCount === 0) {
    throw apiFailure("SPARK_X_AGENT_CHAT_STREAM_INCOMPLETE", "星火 Agent 对话流在完整结果前中断。");
  }
  if (doneEventCount !== 1) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_TERMINAL_DUPLICATED",
      "星火 Agent 对话流返回了重复的终态事件。",
    );
  }
  if (conversationId === undefined || !uuidPattern.test(conversationId)) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_CONVERSATION_INVALID",
      "星火 Agent 对话流未返回有效会话标识。",
    );
  }
  if (truncated) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_TRUNCATED",
      "星火 Agent 对话结果已截断，不能作为回归证据。",
    );
  }
  if (
    contentEventCount === 0 ||
    streamedContent === "" ||
    finalContent === undefined ||
    finalContent === ""
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_CONTENT_INCOMPLETE",
      "星火 Agent 对话流未返回完整的非空助手回复。",
    );
  }
  return {
    conversationId,
    contentEventCount,
    statusEventCount,
    assistantPreviewEventCount,
    toolEventCount,
    skillEventCount,
    reviewEventCount,
    toolCalls,
    toolResults,
    streamBytes,
    streamedContent,
    finalContent,
    truncated,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

async function readBoundedChatStream(
  response: Response,
): Promise<Readonly<{ text: string; bytes: number }>> {
  if (response.body === null) {
    throw apiFailure("SPARK_X_AGENT_CHAT_STREAM_MISSING", "星火 Agent 没有返回可读取的对话流。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxChatStreamBytes) {
        await reader.cancel();
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_STREAM_TOO_LARGE",
          "星火 Agent 对话流超过 1000000 字节安全上限。",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } finally {
    reader.releaseLock();
  }
}

async function streamChat(
  environment: HttpExecutionEnvironment,
  token: string,
  expectedConversationId: string,
  message: string,
  options: SparkXAgentExecutionOptions,
): Promise<SparkXAgentChatResult> {
  let target = new URL(actionPath("/chat"), environment.baseUrl);
  assertHttpTargetAllowed(target, environment.allowlist);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Spark X Agent chat timed out")),
    options.timeoutMs,
  );
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await (options.fetcher ?? fetch)(target, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message, conversation_id: expectedConversationId }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new ExecutorFailure({
            code: "INVALID_REDIRECT",
            message: "星火 Agent 对话重定向缺少目标地址。",
            classification: "environment_failed",
          });
        }
        if (redirect === 5) {
          throw new ExecutorFailure({
            code: "TOO_MANY_REDIRECTS",
            message: "星火 Agent 对话重定向次数超过上限。",
            classification: "environment_failed",
          });
        }
        target = new URL(location, target);
        assertHttpTargetAllowed(target, environment.allowlist);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_REQUEST_FAILED",
          `星火 Agent 对话接口返回 HTTP ${response.status}。`,
          response.status,
        );
      }
      const stream = await readBoundedChatStream(response);
      const result = parseChatStream(stream.text, stream.bytes);
      if (result.conversationId !== expectedConversationId) {
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_CONVERSATION_MISMATCH",
          "星火 Agent 对话流返回了非预期的会话标识。",
        );
      }
      return result;
    }
    throw new ExecutorFailure({
      code: "INVALID_REDIRECT",
      message: "星火 Agent 对话重定向无有效结果。",
      classification: "environment_failed",
    });
  } catch (error) {
    if (error instanceof ExecutorFailure) throw error;
    if (controller.signal.aborted) {
      const externallyCancelled =
        options.signal?.aborted === true &&
        options.signal.reason instanceof Error &&
        ["Run cancellation requested", "Cancellation state unavailable"].includes(
          options.signal.reason.message,
        );
      throw new ExecutorFailure(
        {
          code: externallyCancelled ? "EXECUTION_CANCELLED" : "SPARK_X_AGENT_CHAT_TIMEOUT",
          message: externallyCancelled ? "运行已取消。" : "星火 Agent 对话请求超时。",
          classification: "environment_failed",
        },
        error,
      );
    }
    throw new ExecutorFailure(
      {
        code: "SPARK_X_AGENT_CHAT_NETWORK_ERROR",
        message: "星火 Agent 对话目标无法访问。",
        classification: "environment_failed",
      },
      error,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function executeSparkXAgentAction(
  action: string,
  environment: HttpExecutionEnvironment,
  params: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
  options: SparkXAgentExecutionOptions,
): Promise<Readonly<Record<string, unknown>>> {
  if (!sparkXAgentActions.includes(action as SparkXAgentAction)) {
    throw new ExecutorFailure({
      code: "SPARK_X_AGENT_ACTION_NOT_AVAILABLE",
      message: `星火 Agent 适配器动作 ${action} 未注册。`,
      classification: "test_failed",
    });
  }
  const startedAt = performance.now();
  const remainingOptions = (): SparkXAgentExecutionOptions => {
    const timeoutMs = Math.floor(options.timeoutMs - (performance.now() - startedAt));
    if (timeoutMs <= 0) {
      throw new ExecutorFailure({
        code: "SPARK_X_AGENT_ACTION_TIMEOUT",
        message: "星火 Agent 适配器动作超过步骤超时预算。",
        classification: "environment_failed",
      });
    }
    return {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    };
  };
  const username = requiredString(params, "username", variables, 200);
  const password = requiredString(params, "password", variables, 4_096);
  const token = await login(environment, username, password, remainingOptions());

  if (action === "adapter:spark-x-agent/tool.assert-safe-catalog") {
    const visibleResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath("/mcp/servers") },
      remainingOptions(),
    );
    accepted(visibleResponse, "SPARK_X_AGENT_TOOL_CATALOG_FAILED");
    const visibleData = dataEnvelope(
      visibleResponse.body,
      "SPARK_X_AGENT_TOOL_CATALOG_RESPONSE_INVALID",
    );
    const visibleItems = Array.isArray(visibleData.items)
      ? visibleData.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const visibleServer = visibleItems.find((item) => item.name === safeToolServerName);
    if (
      visibleServer === undefined ||
      typeof visibleServer.id !== "string" ||
      !uuidPattern.test(visibleServer.id) ||
      visibleServer.is_enabled !== true ||
      visibleServer.status !== "running" ||
      visibleServer.tools_count !== safeToolCatalog.length
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_SAFE_TOOL_CATALOG_UNAVAILABLE",
        "builtin-demo 安全工具目录未以运行中状态完整暴露给当前用户。",
      );
    }
    if (privateCatalogFields.some((field) => Object.hasOwn(visibleServer, field))) {
      throw apiFailure(
        "SPARK_X_AGENT_TOOL_CATALOG_LEAKED_PRIVATE_FIELDS",
        "星火 Agent 用户工具目录暴露了管理员连接配置字段。",
      );
    }
    const adminResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/admin/mcp/servers/${encodeURIComponent(visibleServer.id)}/tools`),
      },
      remainingOptions(),
    );
    accepted(adminResponse, "SPARK_X_AGENT_TOOL_CATALOG_FAILED");
    const adminData = dataEnvelope(
      adminResponse.body,
      "SPARK_X_AGENT_TOOL_CATALOG_RESPONSE_INVALID",
    );
    const enabledTools = Array.isArray(adminData.items)
      ? adminData.items
          .map(objectValue)
          .filter(
            (item): item is Readonly<Record<string, unknown>> =>
              item !== null && item.is_enabled === true && item.is_discovered === true,
          )
      : [];
    const names = enabledTools
      .map((item) => item.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
    const expectedNames = [...safeToolCatalog].sort();
    if (
      names.length !== enabledTools.length ||
      canonicalJson(names) !== canonicalJson(expectedNames) ||
      enabledTools.some(
        (item) =>
          item.is_write === true ||
          item.requires_review === true ||
          !["low", "read"].includes(String(item.risk_level)),
      )
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_SAFE_TOOL_CATALOG_MISMATCH",
        "builtin-demo 当前启用工具、风险等级或复核策略与只读基线不一致。",
      );
    }
    return {
      serverName: safeToolServerName,
      visible: true,
      running: true,
      credentialFieldsAbsent: true,
      advertisedToolCount: visibleServer.tools_count,
      enabledDiscoveredToolCount: enabledTools.length,
      expectedToolsMatched: true,
      catalogSha256: sha256(canonicalJson(names)),
    };
  }

  if (action === "adapter:spark-x-agent/tool.invoke-safe") {
    const conversationId = requiredString(params, "conversationId", variables, 100);
    const message = requiredString(params, "message", variables, 20_000);
    const expectedText = requiredString(params, "expectedText", variables, 5_000);
    const expectedToolName = requiredSafeToolName(params, variables);
    const expectedArguments = expectedJsonObject(params, "expectedArgumentsJson", variables);
    const expectedResult = expectedJsonObject(params, "expectedResultJson", variables);
    if (message.includes("\u0000")) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "星火 Agent 工具对话消息不能包含空字符。",
      );
    }
    const result = await streamChat(
      environment,
      token,
      conversationId,
      message,
      remainingOptions(),
    );
    if (!result.finalContent.includes(expectedText)) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_FINAL_RESPONSE_FAILED",
        "星火 Agent 工具调用后的最终回复未包含预期运行标识或结果。",
      );
    }
    if (
      result.toolCalls.length !== 1 ||
      result.toolResults.length !== 1 ||
      result.reviewEventCount !== 0
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_CARDINALITY_FAILED",
        "安全工具回归必须且只能产生一组无需人工复核的工具调用与结果。",
      );
    }
    const call = result.toolCalls[0];
    const toolResult = result.toolResults[0];
    if (
      call === undefined ||
      toolResult === undefined ||
      call.name !== expectedToolName ||
      toolResult.name !== expectedToolName ||
      call.id !== toolResult.id ||
      toolResult.success !== true
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_IDENTITY_FAILED",
        "安全工具调用与结果的名称、调用标识或成功状态不一致。",
      );
    }
    const argumentsCanonical = canonicalJson(call.arguments);
    const resultCanonical = canonicalJson(toolResult.result);
    if (argumentsCanonical !== canonicalJson(expectedArguments)) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_ARGUMENTS_FAILED",
        "模型提交给安全工具的参数与预期绑定不一致。",
      );
    }
    if (resultCanonical !== canonicalJson(expectedResult)) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RESULT_FAILED",
        "安全工具的结构化结果与预期结果不一致。",
      );
    }
    return {
      conversationId: result.conversationId,
      done: true,
      expectedTextMatched: true,
      expectedToolNameMatched: true,
      argumentsMatched: true,
      resultMatched: true,
      toolCallCount: result.toolCalls.length,
      toolResultCount: result.toolResults.length,
      reviewEventCount: result.reviewEventCount,
      toolCallIdSha256: sha256(call.id),
      argumentsSha256: sha256(argumentsCanonical),
      resultSha256: sha256(resultCanonical),
      finalContentLength: result.finalContent.length,
      finalContentSha256: sha256(result.finalContent),
      streamBytes: result.streamBytes,
      truncated: false,
    };
  }

  if (action === "adapter:spark-x-agent/chat.ask") {
    const conversationId = requiredString(params, "conversationId", variables, 100);
    const message = requiredString(params, "message", variables, 20_000);
    const expectedText = requiredString(params, "expectedText", variables, 5_000);
    if (message.includes("\u0000")) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "星火 Agent 对话消息不能包含空字符。",
      );
    }
    const result = await streamChat(
      environment,
      token,
      conversationId,
      message,
      remainingOptions(),
    );
    if (!result.finalContent.includes(expectedText)) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_EXPECTATION_FAILED",
        "星火 Agent 完整回复未包含预期运行标识。",
      );
    }
    const finalContentSha256 = createHash("sha256").update(result.finalContent).digest("hex");
    return {
      conversationId: result.conversationId,
      done: true,
      expectedTextMatched: true,
      contentEventCount: result.contentEventCount,
      statusEventCount: result.statusEventCount,
      assistantPreviewEventCount: result.assistantPreviewEventCount,
      toolEventCount: result.toolEventCount,
      skillEventCount: result.skillEventCount,
      reviewEventCount: result.reviewEventCount,
      streamBytes: result.streamBytes,
      streamedContentLength: result.streamedContent.length,
      finalContentLength: result.finalContent.length,
      finalContentSha256,
      truncated: false,
      ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    };
  }

  if (action === "adapter:spark-x-agent/conversation.create") {
    const title = requiredString(params, "title", variables, 200);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/conversations"),
        headers: { "Content-Type": "application/json" },
        body: { title },
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CONVERSATION_CREATE_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_CONVERSATION_RESPONSE_INVALID");
    if (typeof data.id !== "string" || typeof data.title !== "string") {
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_RESPONSE_INVALID",
        "星火 Agent 创建会话响应缺少会话标识或标题。",
      );
    }
    return { conversationId: data.id, title: data.title };
  }

  const conversationId = requiredString(params, "conversationId", variables, 100);
  if (action === "adapter:spark-x-agent/tool.assert-history") {
    const expectedUserText = requiredString(params, "expectedUserText", variables, 20_000);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    const expectedAssistantSha256 = requiredSha256(params, "expectedAssistantSha256", variables);
    const expectedToolName = requiredSafeToolName(params, variables);
    const expectedArgumentsSha256 = requiredSha256(params, "expectedArgumentsSha256", variables);
    const expectedResultSha256 = requiredSha256(params, "expectedResultSha256", variables);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(
          `/conversations/${encodeURIComponent(conversationId)}/messages?page=1&per_page=100`,
        ),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_TOOL_HISTORY_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID");
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    if (items.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_TRUNCATED",
        "星火 Agent 工具调用历史包含已截断的公开消息。",
      );
    }
    const userMessages = items.filter((item) => item.role === "user");
    const assistantMessages = items.filter((item) => item.role === "assistant");
    const toolMessages = items.filter((item) => item.role === "tool");
    const calls = assistantMessages.flatMap((item) =>
      Array.isArray(item.tool_calls)
        ? item.tool_calls
            .map(objectValue)
            .filter((call): call is Readonly<Record<string, unknown>> => call !== null)
        : [],
    );
    const finalAssistants = assistantMessages.filter(
      (item) =>
        item.finish_reason === "stop" &&
        typeof item.content === "string" &&
        (!Array.isArray(item.tool_calls) || item.tool_calls.length === 0),
    );
    if (
      userMessages.length !== 1 ||
      assistantMessages.length !== 2 ||
      toolMessages.length !== 1 ||
      calls.length !== 1 ||
      finalAssistants.length !== 1
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_CARDINALITY_FAILED",
        "工具回归历史必须包含一条用户消息、一次工具调用、一条工具结果和一条最终回复。",
      );
    }
    const userContent = userMessages[0]?.content;
    const call = calls[0];
    const toolMessage = toolMessages[0];
    const finalAssistant = finalAssistants[0];
    const functionValue = call === undefined ? null : objectValue(call.function);
    if (
      typeof userContent !== "string" ||
      userContent !== expectedUserText ||
      call === undefined ||
      typeof call.id !== "string" ||
      functionValue === null ||
      functionValue.name !== expectedToolName ||
      toolMessage === undefined ||
      toolMessage.tool_call_id !== call.id ||
      typeof toolMessage.content !== "string" ||
      finalAssistant === undefined ||
      typeof finalAssistant.content !== "string" ||
      !finalAssistant.content.includes(expectedAssistantText)
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_IDENTITY_FAILED",
        "工具回归历史的用户消息、工具身份、结果关联或最终回复不一致。",
      );
    }
    const argumentsObject = structuredObject(
      functionValue.arguments,
      "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
      "星火 Agent 工具调用历史缺少受限结构化参数。",
      "product_failed",
    );
    const resultObject = structuredObject(
      toolMessage.content,
      "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
      "星火 Agent 工具结果历史缺少受限结构化结果。",
      "product_failed",
    );
    const argumentsSha256 = sha256(canonicalJson(argumentsObject));
    const resultSha256 = sha256(canonicalJson(resultObject));
    const assistantContentSha256 = sha256(finalAssistant.content);
    if (
      argumentsSha256 !== expectedArgumentsSha256 ||
      resultSha256 !== expectedResultSha256 ||
      assistantContentSha256 !== expectedAssistantSha256
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_HASH_MISMATCH",
        "工具参数、结果或最终回复的持久化哈希与流式证据不一致。",
      );
    }
    const traceEvents = items.flatMap((item) =>
      Array.isArray(item.public_execution_trace)
        ? item.public_execution_trace
            .map(objectValue)
            .filter((event): event is Readonly<Record<string, unknown>> => event !== null)
        : [],
    );
    const traceCalls = traceEvents.filter((event) => event.kind === "tool_call");
    const traceResults = traceEvents.filter((event) => event.kind === "tool_result");
    if (
      traceCalls.length !== 1 ||
      traceResults.length !== 1 ||
      traceCalls[0]?.id !== call.id ||
      traceCalls[0]?.name !== expectedToolName ||
      traceResults[0]?.id !== call.id ||
      traceResults[0]?.name !== expectedToolName ||
      traceResults[0]?.success !== true ||
      sha256(
        canonicalJson(
          structuredObject(
            traceCalls[0]?.arguments,
            "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
            "星火 Agent 公开执行轨迹缺少结构化工具参数。",
            "product_failed",
          ),
        ),
      ) !== expectedArgumentsSha256 ||
      sha256(
        canonicalJson(
          structuredObject(
            traceResults[0]?.result,
            "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
            "星火 Agent 公开执行轨迹缺少结构化工具结果。",
            "product_failed",
          ),
        ),
      ) !== expectedResultSha256
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_TRACE_FAILED",
        "工具调用公开执行轨迹与消息历史不一致。",
      );
    }
    return {
      conversationId,
      messageCount: items.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolMessageCount: toolMessages.length,
      toolCallCount: calls.length,
      toolResultCount: toolMessages.length,
      traceToolCallCount: traceCalls.length,
      traceToolResultCount: traceResults.length,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      expectedToolNameMatched: true,
      argumentsSha256,
      resultSha256,
      assistantContentLength: finalAssistant.content.length,
      assistantContentSha256,
      assistantFinishReason: "stop",
    };
  }
  if (action === "adapter:spark-x-agent/chat.assert-history") {
    const expectedUserText = requiredString(params, "expectedUserText", variables, 20_000);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    const expectedAssistantSha256 = requiredString(
      params,
      "expectedAssistantSha256",
      variables,
      64,
    );
    if (!sha256Pattern.test(expectedAssistantSha256)) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "星火 Agent 助手回复哈希必须是 64 位小写 SHA-256。",
      );
    }
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(
          `/conversations/${encodeURIComponent(conversationId)}/messages?page=1&per_page=100`,
        ),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CHAT_HISTORY_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_CHAT_HISTORY_RESPONSE_INVALID");
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const publicMessages = items.filter(
      (item) => item.role === "user" || item.role === "assistant",
    );
    if (publicMessages.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_CHAT_HISTORY_TRUNCATED",
        "星火 Agent 对话历史包含已截断的公开消息。",
      );
    }
    const userMessages = publicMessages.filter((item) => item.role === "user");
    const assistantMessages = publicMessages.filter((item) => item.role === "assistant");
    const assistant = assistantMessages[0];
    if (userMessages.length !== 1 || assistantMessages.length !== 1 || assistant === undefined) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_HISTORY_CARDINALITY_FAILED",
        "新建对话必须且只能持久化一条用户消息和一条助手回复。",
      );
    }
    const userContent = userMessages[0]?.content;
    const assistantContent = assistant.content;
    if (typeof userContent !== "string" || userContent !== expectedUserText) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_USER_HISTORY_ASSERTION_FAILED",
        "星火 Agent 持久化的用户消息与发送内容不一致。",
      );
    }
    if (typeof assistantContent !== "string" || !assistantContent.includes(expectedAssistantText)) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_ASSISTANT_HISTORY_ASSERTION_FAILED",
        "星火 Agent 持久化的助手回复未包含预期运行标识。",
      );
    }
    const assistantContentSha256 = createHash("sha256").update(assistantContent).digest("hex");
    if (assistantContentSha256 !== expectedAssistantSha256) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_HISTORY_HASH_MISMATCH",
        "星火 Agent 持久化的助手回复与流式最终回复不一致。",
      );
    }
    if (assistant.finish_reason !== "stop") {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_FINISH_REASON_FAILED",
        "星火 Agent 助手回复没有以 stop 正常结束。",
      );
    }
    return {
      conversationId,
      messageCount: publicMessages.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      assistantContentLength: assistantContent.length,
      assistantContentSha256,
      assistantFinishReason: "stop",
      ...(typeof assistant.turn_status === "string"
        ? { assistantTurnStatus: assistant.turn_status }
        : {}),
    };
  }
  if (action === "adapter:spark-x-agent/conversation.assert-recent") {
    const expectedTitle = requiredString(params, "title", variables, 200);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath("/conversations?page=1&per_page=100&status=active"),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CONVERSATION_LIST_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_CONVERSATION_RESPONSE_INVALID");
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const position = items.findIndex((item) => item?.id === conversationId);
    const firstUnpinned = items.findIndex((item) => item?.is_pinned !== true);
    const found = position < 0 ? null : items[position];
    if (
      position < 0 ||
      firstUnpinned < 0 ||
      position !== firstUnpinned ||
      found?.title !== expectedTitle
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_RECENT_CONVERSATION_ASSERTION_FAILED",
        "新建会话未出现在最近会话列表的首个非置顶位置，或标题不一致。",
      );
    }
    const rawMessageCount = found?.message_count;
    const messageCount =
      typeof rawMessageCount === "number" && Number.isInteger(rawMessageCount)
        ? rawMessageCount
        : 0;
    return {
      conversationId,
      listed: true,
      recentPosition: position,
      messageCount,
    };
  }

  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "DELETE",
      path: actionPath(`/conversations/${encodeURIComponent(conversationId)}`),
    },
    remainingOptions(),
  );
  if (response.status === 404) {
    return { conversationId, deleted: true, alreadyMissing: true };
  }
  accepted(response, "SPARK_X_AGENT_CONVERSATION_DELETE_FAILED");
  return { conversationId, deleted: true };
}
