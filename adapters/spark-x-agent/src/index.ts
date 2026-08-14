import type { AdapterManifest } from "@spark-x-test/adapter-sdk";
import {
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
  version: "0.2.0",
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

export const sparkXAgentAdapterPhase = "conversation-p0" as const;

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
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
  if (action === "adapter:spark-x-agent/conversation.assert-recent") {
    const expectedTitle = requiredString(params, "title", variables, 200);
    const response = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath("/conversations?page=1&per_page=100&status=active") },
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
    return { conversationId, listed: true, recentPosition: position, messageCount };
  }

  const response = await authenticatedRequest(
    environment,
    token,
    { method: "DELETE", path: actionPath(`/conversations/${encodeURIComponent(conversationId)}`) },
    remainingOptions(),
  );
  if (response.status === 404) {
    return { conversationId, deleted: true, alreadyMissing: true };
  }
  accepted(response, "SPARK_X_AGENT_CONVERSATION_DELETE_FAILED");
  return { conversationId, deleted: true };
}
