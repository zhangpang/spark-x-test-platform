import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

interface IdentifiedRecord {
  readonly id: string;
}

interface SystemRecord extends IdentifiedRecord {
  readonly key: string;
}

interface ModuleRecord extends IdentifiedRecord {
  readonly key: string;
}

interface EnvironmentRecord extends IdentifiedRecord {
  readonly key: string;
}

interface CaseRecord extends IdentifiedRecord {
  readonly moduleId: string;
  readonly name: string;
  readonly status: string;
  readonly currentDraftVersionId: string | null;
  readonly currentPublishedVersionId: string | null;
}

interface CaseVersionRecord extends IdentifiedRecord {
  readonly version: number;
  readonly definition: Readonly<Record<string, unknown>>;
}

interface SuiteRecord extends IdentifiedRecord {
  readonly systemId: string;
  readonly key: string;
}

interface RunDetail extends IdentifiedRecord {
  readonly status: string;
  readonly gateResult: string | null;
  readonly testedVersion: string;
  readonly summary: Readonly<Record<string, number>>;
  readonly firstFailure: Readonly<{ code: string; message: string }> | null;
  readonly cases: readonly Readonly<{
    result: string | null;
    cleanupStatus: string;
  }>[];
  readonly steps: readonly Readonly<{
    stepId: string;
    action: string;
    phase: string;
    status: string;
    outputSummary: Readonly<Record<string, unknown>> | null;
  }>[];
  readonly resources: readonly Readonly<{
    resourceType: string;
    cleanupStatus: string;
    cleanupDefinition: Readonly<Record<string, unknown>>;
  }>[];
  readonly cleanupJob: Readonly<{ status: string }> | null;
}

const apiBase = process.env.SPARK_X_TEST_PLATFORM_API_URL ?? "http://127.0.0.1:4100/api/v1";
const runSmoke = process.env.SPARK_X_AGENT_RUN_SMOKE === "true";
const runContextSmoke = process.env.SPARK_X_AGENT_RUN_CONTEXT_SMOKE === "true";
const runCancelSmoke = process.env.SPARK_X_AGENT_RUN_CANCEL_SMOKE === "true";
const runConversationReopenSmoke =
  process.env.SPARK_X_AGENT_RUN_CONVERSATION_REOPEN_SMOKE === "true";
const runConversationPaginationSmoke =
  process.env.SPARK_X_AGENT_RUN_CONVERSATION_PAGINATION_SMOKE === "true";
const runConversationDeleteSmoke =
  process.env.SPARK_X_AGENT_RUN_CONVERSATION_DELETE_SMOKE === "true";
const runKnowledgeSmoke = process.env.SPARK_X_AGENT_RUN_KNOWLEDGE_SMOKE === "true";
const runKnowledgeRetrievalSmoke =
  process.env.SPARK_X_AGENT_RUN_KNOWLEDGE_RETRIEVAL_SMOKE === "true";
const runKnowledgeIsolationSmoke =
  process.env.SPARK_X_AGENT_RUN_KNOWLEDGE_ISOLATION_SMOKE === "true";
const runSkillSmoke = process.env.SPARK_X_AGENT_RUN_SKILL_SMOKE === "true";
const runMcpSmoke = process.env.SPARK_X_AGENT_RUN_MCP_SMOKE === "true";
const expectMcpUnavailable = process.env.SPARK_X_AGENT_EXPECT_MCP_UNAVAILABLE === "true";
const runAutomationSmoke = process.env.SPARK_X_AGENT_RUN_AUTOMATION_SMOKE === "true";
const useExistingSecrets = process.env.SPARK_X_AGENT_USE_EXISTING_SECRETS === "true";
const testedVersion = process.env.SPARK_X_AGENT_TESTED_VERSION?.trim() || "test-environment";
const adminUsername = process.env.SPARK_X_AGENT_ADMIN_USERNAME?.trim() || "admin";
const passwordFile = process.env.SPARK_X_AGENT_ADMIN_PASSWORD_FILE?.trim();
const trustedSkillPublicationSha256 =
  "a5de94a8db8803916c772c214ac22e6d2c8cdca3e1555d97f013fdf4585803cc";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readPassword(): Promise<string> {
  const raw =
    passwordFile === undefined || passwordFile === ""
      ? readFileSync(0, "utf8")
      : await readFile(passwordFile, "utf8");
  const password = raw.replace(/[\r\n]+$/u, "");
  check(password.length > 0, "Spark X Agent administrator password is missing");
  return password;
}

async function api<T>(
  path: string,
  options: Readonly<{
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  }> = {},
): Promise<Readonly<{ status: number; body: T }>> {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.idempotencyKey === undefined
        ? {}
        : { "idempotency-key": options.idempotencyKey }),
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const body = (text === "" ? null : JSON.parse(text)) as T;
  if (!response.ok) {
    throw new Error(`Platform API ${path} returned HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, body };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function ensureSystem(): Promise<SystemRecord> {
  const systems = (await api<{ readonly items: SystemRecord[] }>("/systems")).body.items;
  const existing = systems.find((system) => system.key === "spark-x-agent");
  if (existing !== undefined) {
    return (
      await api<SystemRecord>(`/systems/${existing.id}`, {
        method: "PATCH",
        body: {
          name: "星火 Agent",
          description: "星火 Agent 自动化业务回归资产（测试环境）",
          concurrencyLimit: 1,
          status: "active",
        },
      })
    ).body;
  }
  return (
    await api<SystemRecord>("/systems", {
      method: "POST",
      body: {
        key: "spark-x-agent",
        name: "星火 Agent",
        description: "星火 Agent 自动化业务回归资产（测试环境）",
        concurrencyLimit: 1,
      },
    })
  ).body;
}

const moduleDefinitions = [
  ["chat", "对话主链路"],
  ["tools", "工具调用"],
  ["knowledge-base", "知识库"],
  ["skills", "Skill"],
  ["mcp", "MCP"],
  ["automations", "自动任务"],
  ["recent-conversations", "最近会话"],
] as const;

async function ensureModules(systemId: string): Promise<Map<string, ModuleRecord>> {
  const modules = await api<ModuleRecord[]>(`/systems/${systemId}/modules`).then(
    (response) => response.body,
  );
  const byKey = new Map(modules.map((module) => [module.key, module]));
  for (const [index, [key, name]] of moduleDefinitions.entries()) {
    if (byKey.has(key)) continue;
    const created = await api<ModuleRecord>(`/systems/${systemId}/modules`, {
      method: "POST",
      body: { key, name, sortOrder: index },
    });
    byKey.set(key, created.body);
  }
  return byKey;
}

async function ensureEnvironment(systemId: string): Promise<EnvironmentRecord> {
  const desired = {
    name: "星火 Agent 测试环境",
    kind: "test",
    baseUrl: "http://192.168.110.136/trade/",
    actionLevel: "dangerous",
    allowlist: [
      {
        protocol: "http",
        host: "192.168.110.136",
        ports: [80],
        pathPrefixes: ["/trade/", "/trade-domain-api/"],
      },
    ],
    timezone: "Asia/Shanghai",
    concurrencyLimit: 1,
    adapterKey: "spark-x-agent",
    adapterConfig: {},
  } as const;
  const environments = await api<EnvironmentRecord[]>(`/systems/${systemId}/environments`).then(
    (response) => response.body,
  );
  const existing = environments.find((environment) => environment.key === "test");
  if (existing !== undefined) {
    return (
      await api<EnvironmentRecord>(`/environments/${existing.id}`, {
        method: "PATCH",
        body: { ...desired, status: "active" },
      })
    ).body;
  }
  return (
    await api<EnvironmentRecord>(`/systems/${systemId}/environments`, {
      method: "POST",
      body: { key: "test", ...desired },
    })
  ).body;
}

async function upsertSecrets(
  systemId: string,
  environmentId: string,
  password: string,
): Promise<void> {
  await api("/secrets", {
    method: "POST",
    body: {
      systemId,
      environmentId,
      key: "spark-x-agent-admin-username",
      value: adminUsername,
    },
  });
  await api("/secrets", {
    method: "POST",
    body: {
      systemId,
      environmentId,
      key: "spark-x-agent-admin-password",
      value: password,
    },
  });
}

function conversationDefinition(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "CONV-001 最近会话创建、排序与清理",
      description: "登录星火 Agent，创建带 run_id 的会话，校验最近会话排序，并在 finally 清理。",
      systemKey: "spark-x-agent",
      moduleKey: "recent-conversations",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "conversation", "p0", "regression"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 20_000,
      caseTimeoutMs: 90_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:recent-conversations"],
    steps: [
      {
        id: "create-conversation",
        name: "创建带运行标识的测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-regression-${run.id}",
        },
        capture: { "conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "assert-recent-conversation",
        name: "校验最近会话列表与标题",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.assert-recent",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
          title: "spark-x-regression-${run.id}",
          expectedMessageCount: 0,
        },
      },
    ],
    finally: [
      {
        id: "delete-conversation",
        name: "删除测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
        },
      },
    ],
  };
}

function conversationPaginationDefinition(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "CONV-003 会话重命名与分页稳定性",
      description:
        "创建三个运行隔离会话，重命名最早会话后以每页两条连续扫描两次，校验标题持久化、跨页无重复遗漏和顺序稳定，并逆序清理。",
      systemKey: "spark-x-agent",
      moduleKey: "recent-conversations",
      priority: "P1",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "conversation", "p1", "full-regression", "pagination", "rename"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 30_000,
      caseTimeoutMs: 150_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:recent-conversations"],
    steps: [
      {
        id: "create-pagination-oldest",
        name: "创建分页顺序中的最早会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-page-oldest-${run.id}",
        },
        capture: { "pagination-oldest-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.pagination-oldest-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "create-pagination-middle",
        name: "创建分页顺序中的中间会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-page-middle-${run.id}",
        },
        capture: { "pagination-middle-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.pagination-middle-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "create-pagination-newest",
        name: "创建分页顺序中的最新会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-page-newest-${run.id}",
        },
        capture: { "pagination-newest-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.pagination-newest-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "rename-and-assert-pagination",
        name: "重命名并连续校验两次跨页顺序",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.pagination-oldest-id}",
          title: "spark-x-page-renamed-${run.id}",
          expectedOrder: [
            "${step.pagination-oldest-id}",
            "${step.pagination-newest-id}",
            "${step.pagination-middle-id}",
          ],
        },
      },
    ],
    finally: [
      {
        id: "delete-pagination-newest",
        name: "删除分页最新会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.pagination-newest-id}",
        },
      },
      {
        id: "delete-pagination-middle",
        name: "删除分页中间会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.pagination-middle-id}",
        },
      },
      {
        id: "delete-pagination-oldest",
        name: "删除已重命名会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.pagination-oldest-id}",
        },
      },
    ],
  };
}

function conversationDeleteDefinition(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "CONV-004 会话删除与重复记录防护",
      description:
        "创建并唯一定位运行会话，执行软删除后验证活动列表零记录、删除列表唯一记录，再次删除并由 finally 完成幂等清理。",
      systemKey: "spark-x-agent",
      moduleKey: "recent-conversations",
      priority: "P1",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "conversation", "p1", "full-regression", "delete", "idempotency"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 20_000,
      caseTimeoutMs: 120_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:recent-conversations"],
    steps: [
      {
        id: "create-delete-conversation",
        name: "创建并登记待删除会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-delete-${run.id}",
        },
        capture: { "delete-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.delete-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "assert-delete-conversation-unique",
        name: "确认活动列表只有一条目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.assert-recent",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.delete-conversation-id}",
          title: "spark-x-delete-${run.id}",
          expectedMessageCount: 0,
        },
      },
      {
        id: "delete-conversation-main",
        name: "首次删除目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.delete-conversation-id}",
        },
      },
      {
        id: "assert-conversation-deleted-state",
        name: "校验活动列表缺失和删除列表唯一记录",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.assert-deleted-state",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.delete-conversation-id}",
        },
      },
      {
        id: "delete-conversation-again",
        name: "再次删除验证幂等结果",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.delete-conversation-id}",
        },
      },
    ],
    finally: [
      {
        id: "delete-conversation-finally",
        name: "由 finally 再次执行资源清理",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.delete-conversation-id}",
        },
      },
    ],
  };
}

function conversationReopenDefinition(): Readonly<Record<string, unknown>> {
  const marker = "spark-x-reopen-${run.id}";
  const firstMessage = `请记住会话恢复标识 ${marker}，并只回复这个标识。当前会话不绑定知识库或 Skill，不要调用工具。`;
  const secondMessage =
    "从最近会话重新打开后，请只回复上一轮的会话恢复标识；本轮校验号 ${run.id}。不要调用工具。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "CONV-002 从最近列表重新打开并继续会话",
      description:
        "首轮真实模型对话后从最近列表重新定位同一会话，通过历史接口校验持久化消息数，再用原会话续接第二轮并确认空知识库、Skill 和工具范围未漂移。",
      systemKey: "spark-x-agent",
      moduleKey: "recent-conversations",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "conversation", "p0", "core-smoke", "real-model", "reopen"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 120_000,
      caseTimeoutMs: 360_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:recent-conversations"],
    steps: [
      {
        id: "create-reopen-conversation",
        name: "创建并登记待重新打开的会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: marker,
        },
        capture: { "reopen-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.reopen-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "ask-reopen-first-turn",
        name: "写入首轮会话恢复标识",
        kind: "action",
        action: "adapter:spark-x-agent/chat.ask",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.reopen-conversation-id}",
          message: firstMessage,
          expectedText: marker,
        },
        capture: { "reopen-first-assistant-sha256": "$.finalContentSha256" },
      },
      {
        id: "reopen-from-recent-list",
        name: "从最近会话列表重新定位原会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.assert-recent",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.reopen-conversation-id}",
          title: marker,
          expectedMessageCount: 2,
        },
      },
      {
        id: "ask-reopen-second-turn",
        name: "用重新定位的原会话续接第二轮",
        kind: "action",
        action: "adapter:spark-x-agent/chat.ask",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.reopen-conversation-id}",
          message: secondMessage,
          expectedText: marker,
        },
        capture: { "reopen-second-assistant-sha256": "$.finalContentSha256" },
      },
      {
        id: "assert-reopen-history",
        name: "校验恢复后的两轮历史和空扩展范围",
        kind: "action",
        action: "adapter:spark-x-agent/chat.assert-context-history",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.reopen-conversation-id}",
          firstUserText: firstMessage,
          firstAssistantSha256: "${step.reopen-first-assistant-sha256}",
          secondUserText: secondMessage,
          secondExpectedText: marker,
          secondAssistantSha256: "${step.reopen-second-assistant-sha256}",
          forbiddenText: "spark-x-forbidden-scope-${run.id}",
        },
      },
    ],
    finally: [
      {
        id: "delete-reopen-conversation",
        name: "删除重新打开的测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.reopen-conversation-id}",
        },
      },
    ],
  };
}

function chatDefinition(): Readonly<Record<string, unknown>> {
  const message = "自动化回归标识 spark-x-chat-${run.id}。请只回复这个标识，不要调用任何工具。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "CHAT-001 流式对话、历史持久化与清理",
      description:
        "登录星火 Agent，发送带 run_id 的真实模型消息，校验完整 SSE 和历史落库，并在 finally 清理。",
      systemKey: "spark-x-agent",
      moduleKey: "chat",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "chat", "p0", "core-smoke", "real-model"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 120_000,
      caseTimeoutMs: 420_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:chat"],
    steps: [
      {
        id: "create-chat-conversation",
        name: "创建并登记对话测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-chat-${run.id}",
        },
        capture: { "conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "ask-chat",
        name: "发送带运行标识的真实模型消息并校验流式终态",
        kind: "action",
        action: "adapter:spark-x-agent/chat.ask",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
          message,
          expectedText: "spark-x-chat-${run.id}",
        },
        capture: { "assistant-sha256": "$.finalContentSha256" },
      },
      {
        id: "assert-chat-history",
        name: "校验用户消息与助手回复完整持久化",
        kind: "action",
        action: "adapter:spark-x-agent/chat.assert-history",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
          expectedUserText: message,
          expectedAssistantText: "spark-x-chat-${run.id}",
          expectedAssistantSha256: "${step.assistant-sha256}",
        },
      },
    ],
    finally: [
      {
        id: "delete-chat-conversation",
        name: "删除对话测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
        },
      },
    ],
  };
}

function chatContextDefinition(): Readonly<Record<string, unknown>> {
  const contextMarker = "spark-x-context-${run.id}";
  const decoyMarker = "spark-x-decoy-${run.id}";
  const decoyMessage = `独立干扰会话标识 ${decoyMarker}。请只回复这个标识，不要调用任何工具。`;
  const firstMessage = `请记住上下文标识 ${contextMarker}，并只回复这个标识，不要调用任何工具。`;
  const secondMessage = "请只回复上一轮的上下文标识；本轮校验号 ${run.id}。不要调用任何工具。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "CHAT-002 同一会话上下文续接与跨会话隔离",
      description:
        "建立独立干扰会话后，在主会话连续执行两轮真实模型对话，校验上下文续接、四条历史顺序、流式哈希和干扰标识完全隔离。",
      systemKey: "spark-x-agent",
      moduleKey: "chat",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "chat", "p0", "core-smoke", "real-model", "context-isolation"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 120_000,
      caseTimeoutMs: 480_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:chat-context"],
    steps: [
      {
        id: "create-decoy-conversation",
        name: "创建并登记独立干扰会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: decoyMarker,
        },
        capture: { "decoy-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.decoy-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "seed-decoy-conversation",
        name: "写入仅属于干扰会话的标识",
        kind: "action",
        action: "adapter:spark-x-agent/chat.ask",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.decoy-conversation-id}",
          message: decoyMessage,
          expectedText: decoyMarker,
        },
      },
      {
        id: "create-context-conversation",
        name: "创建并登记两轮上下文主会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: contextMarker,
        },
        capture: { "context-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.context-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "ask-context-first-turn",
        name: "写入主会话上下文标识",
        kind: "action",
        action: "adapter:spark-x-agent/chat.ask",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.context-conversation-id}",
          message: firstMessage,
          expectedText: contextMarker,
        },
        capture: { "context-first-assistant-sha256": "$.finalContentSha256" },
      },
      {
        id: "ask-context-second-turn",
        name: "重新使用同一会话并仅凭上下文取回标识",
        kind: "action",
        action: "adapter:spark-x-agent/chat.ask",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.context-conversation-id}",
          message: secondMessage,
          expectedText: contextMarker,
        },
        capture: { "context-second-assistant-sha256": "$.finalContentSha256" },
      },
      {
        id: "assert-context-history",
        name: "校验两轮历史、流式哈希和跨会话隔离",
        kind: "action",
        action: "adapter:spark-x-agent/chat.assert-context-history",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.context-conversation-id}",
          firstUserText: firstMessage,
          firstAssistantSha256: "${step.context-first-assistant-sha256}",
          secondUserText: secondMessage,
          secondExpectedText: contextMarker,
          secondAssistantSha256: "${step.context-second-assistant-sha256}",
          forbiddenText: decoyMarker,
        },
      },
    ],
    finally: [
      {
        id: "delete-context-conversation",
        name: "删除两轮上下文主会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.context-conversation-id}",
        },
      },
      {
        id: "delete-decoy-conversation",
        name: "删除独立干扰会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.decoy-conversation-id}",
        },
      },
    ],
  };
}

function chatCancelDefinition(): Readonly<Record<string, unknown>> {
  const marker = "spark-x-cancel-resume-${run.id}";
  const cancelMessage =
    "请生成一篇不少于五千字的长回答，用于用户停止生成回归。不要调用工具或 Skill。取消标识 ${run.id}。";
  const resumeMessage = `上一轮已经由用户停止，不要继续上一轮内容。请只回复恢复标识 ${marker}，不要调用工具或 Skill。`;
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "CHAT-003 用户停止生成与同会话续接",
      description:
        "用 V5 Turn 队列启动长回答，进入 active 后请求取消，确认取消输入无幽灵助手消息，再在同一会话完成独立续接。",
      systemKey: "spark-x-agent",
      moduleKey: "chat",
      priority: "P1",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "chat", "p1", "full-regression", "cancel", "resume", "real-model"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 300_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:chat"],
    steps: [
      {
        id: "create-cancel-conversation",
        name: "创建并登记取消回归会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: marker,
        },
        capture: { "cancel-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.cancel-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "cancel-active-turn-and-resume",
        name: "取消 active Turn 并完成同会话续接",
        kind: "action",
        action: "adapter:spark-x-agent/chat.cancel-and-resume",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.cancel-conversation-id}",
          requestId: "${run.id}",
          cancelMessage,
          resumeMessage,
          expectedText: marker,
        },
      },
      {
        id: "assert-cancel-conversation-recent",
        name: "校验取消与续接后的三条持久化消息",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.assert-recent",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.cancel-conversation-id}",
          title: marker,
          expectedMessageCount: 3,
        },
      },
    ],
    finally: [
      {
        id: "delete-cancel-conversation",
        name: "删除取消回归会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.cancel-conversation-id}",
        },
      },
    ],
  };
}

function toolCatalogDefinition(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "TOOL-001 内置只读工具目录与凭据边界",
      description:
        "校验普通用户只看到 builtin-demo 的三个只读工具，管理员目录风险策略一致且不返回连接凭据。",
      systemKey: "spark-x-agent",
      moduleKey: "tools",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      owner: "spark-x-test-platform",
      tags: ["adapter", "tool", "p0", "core-smoke", "read-only"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 20_000,
      caseTimeoutMs: 60_000,
      diagnosticRetries: 0,
    },
    resourceLocks: [],
    steps: [
      {
        id: "assert-safe-tool-catalog",
        name: "校验内置只读工具目录与凭据边界",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-safe-catalog",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
        },
      },
    ],
    finally: [],
  };
}

function toolInvocationDefinition(): Readonly<Record<string, unknown>> {
  const message =
    "自动化回归 ${run.id}：只调用一次 builtin-demo__calculator 计算 6×7，并回复 spark-x-tool-${run.id}:42。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "TOOL-002 安全工具调用、结果回填与历史证据",
      description:
        "创建带 run_id 的会话，调用一次内置只读计算器，校验参数、结果、最终回复和历史公开轨迹的哈希关联，并在 finally 清理。",
      systemKey: "spark-x-agent",
      moduleKey: "tools",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "tool", "p0", "core-smoke", "real-model", "read-only"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 120_000,
      caseTimeoutMs: 420_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:tools"],
    steps: [
      {
        id: "create-tool-conversation",
        name: "创建并登记工具测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-tool-${run.id}",
        },
        capture: { "conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "assert-safe-tool-precondition",
        name: "确认内置只读工具测试基线在线",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-safe-catalog",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
        },
      },
      {
        id: "invoke-safe-tool",
        name: "调用一次内置只读计算器并校验结构化结果",
        kind: "action",
        action: "adapter:spark-x-agent/tool.invoke-safe",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
          message,
          expectedText: "spark-x-tool-${run.id}:42",
          expectedToolName: "builtin-demo__calculator",
          expectedArgumentsJson: '{"operation":"multiply","a":6,"b":7}',
          expectedResultJson: '{"success":true,"operation":"multiply","a":6,"b":7,"result":42}',
        },
        capture: {
          "assistant-sha256": "$.finalContentSha256",
          "arguments-sha256": "$.argumentsSha256",
          "result-sha256": "$.resultSha256",
        },
      },
      {
        id: "assert-tool-history",
        name: "校验工具消息与公开轨迹完整持久化",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-history",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
          expectedUserText: message,
          expectedAssistantText: "spark-x-tool-${run.id}:42",
          expectedAssistantSha256: "${step.assistant-sha256}",
          expectedToolName: "builtin-demo__calculator",
          expectedArgumentsSha256: "${step.arguments-sha256}",
          expectedResultSha256: "${step.result-sha256}",
        },
      },
    ],
    finally: [
      {
        id: "delete-tool-conversation",
        name: "删除工具测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
        },
      },
    ],
  };
}

function toolResultDefinition(): Readonly<Record<string, unknown>> {
  const marker = "spark-x-tool-result-${run.id}";
  const message =
    "自动化回归 ${run.id}：只调用一次 builtin-demo__echo，参数 message 必须精确为 spark-x-tool-result-${run.id}；获得工具结果后，最终回复必须包含 spark-x-tool-result-${run.id}。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "TOOL-003 工具结果进入最终回答",
      description:
        "创建带 run_id 的会话，单次调用内置只读 echo，精确校验参数与结构化结果进入最终回答，并用公开历史轨迹关联全部哈希证据。",
      systemKey: "spark-x-agent",
      moduleKey: "tools",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "tool", "p0", "full-regression", "real-model", "result-mapping"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 120_000,
      caseTimeoutMs: 420_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:tools"],
    steps: [
      {
        id: "create-tool-result-conversation",
        name: "创建并登记工具结果测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-tool-result-${run.id}",
        },
        capture: { "tool-result-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.tool-result-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "assert-tool-result-precondition",
        name: "确认仅有内置只读工具可用",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-safe-catalog",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
        },
      },
      {
        id: "invoke-echo-tool",
        name: "单次调用 echo 并校验结果进入最终回答",
        kind: "action",
        action: "adapter:spark-x-agent/tool.invoke-safe",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.tool-result-conversation-id}",
          message,
          expectedText: marker,
          expectedToolName: "builtin-demo__echo",
          expectedArgumentsJson: '{"message":"spark-x-tool-result-${run.id}"}',
          expectedResultJson: '{"success":true,"echo":{"message":"spark-x-tool-result-${run.id}"}}',
        },
        capture: {
          "tool-result-assistant-sha256": "$.finalContentSha256",
          "tool-result-arguments-sha256": "$.argumentsSha256",
          "tool-result-result-sha256": "$.resultSha256",
        },
      },
      {
        id: "assert-tool-result-history",
        name: "校验 echo 结果、最终回答与公开轨迹持久化",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-history",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.tool-result-conversation-id}",
          expectedUserText: message,
          expectedAssistantText: marker,
          expectedAssistantSha256: "${step.tool-result-assistant-sha256}",
          expectedToolName: "builtin-demo__echo",
          expectedArgumentsSha256: "${step.tool-result-arguments-sha256}",
          expectedResultSha256: "${step.tool-result-result-sha256}",
        },
      },
    ],
    finally: [
      {
        id: "delete-tool-result-conversation",
        name: "删除工具结果测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.tool-result-conversation-id}",
        },
      },
    ],
  };
}

function toolFailureRecoveryDefinition(): Readonly<Record<string, unknown>> {
  const marker = "spark-x-tool-recovery-${run.id}";
  const message =
    "自动化回归 ${run.id}：第一步必须且只能调用一次 builtin-demo__calculator，参数精确为 operation=divide、a=7、b=0；观察到除零失败后，第二步必须且只能调用一次 builtin-demo__echo，参数 message 精确为 spark-x-tool-recovery-${run.id}；最终回复必须包含 spark-x-tool-recovery-${run.id}，不得调用其他工具。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "TOOL-004 工具失败、恢复与后续循环",
      description:
        "创建带 run_id 的会话，观察一次真实 calculator 除零失败后调用 echo 恢复，精确校验两段参数、结果、公开轨迹、最终回复和完整清理。",
      systemKey: "spark-x-agent",
      moduleKey: "tools",
      priority: "P1",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "tool", "p1", "full-regression", "failure", "recovery", "real-model"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 120_000,
      caseTimeoutMs: 420_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:tools"],
    steps: [
      {
        id: "create-tool-recovery-conversation",
        name: "创建并登记工具恢复测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-tool-recovery-${run.id}",
        },
        capture: { "tool-recovery-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.tool-recovery-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "assert-tool-recovery-precondition",
        name: "确认内置失败与恢复工具均在线",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-safe-catalog",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
        },
      },
      {
        id: "invoke-tool-failure-recovery",
        name: "观察真实工具失败并校验后续恢复",
        kind: "action",
        action: "adapter:spark-x-agent/tool.invoke-failure-recovery",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.tool-recovery-conversation-id}",
          message,
          expectedText: marker,
          failureArgumentsJson: '{"operation":"divide","a":7,"b":0}',
          failureResultJson: '{"success":false,"error":"division by zero"}',
          recoveryArgumentsJson: '{"message":"spark-x-tool-recovery-${run.id}"}',
          recoveryResultJson:
            '{"success":true,"echo":{"message":"spark-x-tool-recovery-${run.id}"}}',
        },
        capture: {
          "tool-recovery-assistant-sha256": "$.finalContentSha256",
          "tool-failure-arguments-sha256": "$.failureArgumentsSha256",
          "tool-failure-result-sha256": "$.failureResultSha256",
          "tool-recovery-arguments-sha256": "$.recoveryArgumentsSha256",
          "tool-recovery-result-sha256": "$.recoveryResultSha256",
        },
      },
      {
        id: "assert-tool-failure-recovery-history",
        name: "校验失败、恢复与公开轨迹完整持久化",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-failure-recovery-history",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.tool-recovery-conversation-id}",
          expectedUserText: message,
          expectedAssistantText: marker,
          expectedAssistantSha256: "${step.tool-recovery-assistant-sha256}",
          failureArgumentsSha256: "${step.tool-failure-arguments-sha256}",
          failureResultSha256: "${step.tool-failure-result-sha256}",
          recoveryArgumentsSha256: "${step.tool-recovery-arguments-sha256}",
          recoveryResultSha256: "${step.tool-recovery-result-sha256}",
        },
      },
    ],
    finally: [
      {
        id: "delete-tool-recovery-conversation",
        name: "删除工具恢复测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.tool-recovery-conversation-id}",
        },
      },
    ],
  };
}

function forbiddenToolDefinition(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "TOOL-005 禁止的工具与写操作",
      description:
        "只读核对模型目录精确等于三个受信任工具，管理员登记中无写入、需复核或高风险工具；用例不发起工具调用且不产生资源或副作用。",
      systemKey: "spark-x-agent",
      moduleKey: "tools",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      owner: "spark-x-test-platform",
      tags: ["adapter", "tool", "p0", "full-regression", "forbidden", "read-only"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 20_000,
      caseTimeoutMs: 60_000,
      diagnosticRetries: 0,
    },
    resourceLocks: [],
    steps: [
      {
        id: "assert-forbidden-tool-boundary",
        name: "校验禁止工具、写操作与私有配置均未暴露",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-safe-catalog",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
        },
      },
    ],
    finally: [],
  };
}

function knowledgeBaseDefinition(): Readonly<Record<string, unknown>> {
  const title = "spark-x-kb-${run.id}.pdf";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "KB-001 固定 PDF 入库、解析证据与完整清理",
      description:
        "创建带 run_id 的私有知识库，仅上传适配器内置 PDF，校验解析版本与内容哈希，并完整删除文档、原始上传和知识库。",
      systemKey: "spark-x-agent",
      moduleKey: "knowledge-base",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "knowledge-base", "p0", "core-smoke", "fixed-fixture"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 480_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:knowledge-base"],
    steps: [
      {
        id: "create-knowledge-base",
        name: "创建并登记私有知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          name: "spark-x-kb-${run.id}",
          description: "Spark X Test Platform KB-001 fixed fixture",
        },
        capture: { "knowledge-base-id": "$.knowledgeBaseId" },
        resource: {
          type: "spark-x-agent-knowledge-base",
          id: "${step.knowledge-base-id}",
          cleanup: {
            action: "adapter:spark-x-agent/knowledge-base.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              knowledgeBaseId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "upload-knowledge-fixture",
        name: "上传适配器内置固定 PDF",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.knowledge-base-id}",
        },
        capture: {
          "uploaded-document-id": "$.uploadedDocumentId",
          "fixture-sha256": "$.fixtureSha256",
        },
      },
      {
        id: "attach-knowledge-fixture",
        name: "以内存短期源地址绑定固定 PDF",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.attach-upload",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.knowledge-base-id}",
          uploadedDocumentId: "${step.uploaded-document-id}",
          title,
        },
        capture: { "knowledge-document-id": "$.knowledgeDocumentId" },
      },
      {
        id: "wait-knowledge-ready",
        name: "校验解析终态、版本和内容哈希",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.wait-ready",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.knowledge-base-id}",
          knowledgeDocumentId: "${step.knowledge-document-id}",
          expectedFixtureSha256: "${step.fixture-sha256}",
          expectedTitle: title,
        },
      },
    ],
    finally: [
      {
        id: "cleanup-knowledge-base",
        name: "删除知识文档与原始上传并归档知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.cleanup",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.knowledge-base-id}",
        },
      },
    ],
  };
}

function knowledgeScopeDefinition(): Readonly<Record<string, unknown>> {
  const title = "spark-x-kb-scope-${run.id}.pdf";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "KB-002 会话知识库范围、固定版本快照与幂等重放",
      description:
        "创建带 run_id 的知识库和会话，绑定 required 知识范围，固定唯一文档版本，并校验快照幂等重放和范围稳定性。",
      systemKey: "spark-x-agent",
      moduleKey: "knowledge-base",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: [
        "adapter",
        "knowledge-base",
        "conversation-scope",
        "immutable-snapshot",
        "idempotency",
        "p0",
        "core-smoke",
      ],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 600_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:knowledge-base", "spark-x-agent:admin:conversation"],
    steps: [
      {
        id: "create-scope-knowledge-base",
        name: "创建并登记会话范围知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          name: "spark-x-kb-scope-${run.id}",
          description: "Spark X Test Platform KB-002 immutable snapshot fixture",
        },
        capture: { "scope-knowledge-base-id": "$.knowledgeBaseId" },
        resource: {
          type: "spark-x-agent-knowledge-base",
          id: "${step.scope-knowledge-base-id}",
          cleanup: {
            action: "adapter:spark-x-agent/knowledge-base.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              knowledgeBaseId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "upload-scope-knowledge-fixture",
        name: "上传适配器内置固定 PDF",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.scope-knowledge-base-id}",
        },
        capture: {
          "scope-uploaded-document-id": "$.uploadedDocumentId",
          "scope-fixture-sha256": "$.fixtureSha256",
        },
      },
      {
        id: "attach-scope-knowledge-fixture",
        name: "绑定固定 PDF 并登记知识文档",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.attach-upload",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.scope-knowledge-base-id}",
          uploadedDocumentId: "${step.scope-uploaded-document-id}",
          title,
        },
        capture: { "scope-knowledge-document-id": "$.knowledgeDocumentId" },
      },
      {
        id: "wait-scope-knowledge-ready",
        name: "校验唯一文档版本与固定内容哈希",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.wait-ready",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.scope-knowledge-base-id}",
          knowledgeDocumentId: "${step.scope-knowledge-document-id}",
          expectedFixtureSha256: "${step.scope-fixture-sha256}",
          expectedTitle: title,
        },
      },
      {
        id: "create-scope-conversation",
        name: "创建并登记知识范围测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-kb-scope-${run.id}",
        },
        capture: { "scope-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.scope-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "assert-conversation-knowledge-scope",
        name: "绑定 required 范围并校验不可变快照幂等重放",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.scope-conversation-id}",
          knowledgeBaseId: "${step.scope-knowledge-base-id}",
          knowledgeDocumentId: "${step.scope-knowledge-document-id}",
          expectedFixtureSha256: "${step.scope-fixture-sha256}",
          clientRequestId: "${run.id}",
        },
      },
    ],
    finally: [
      {
        id: "delete-scope-conversation",
        name: "先删除知识范围测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.scope-conversation-id}",
        },
      },
      {
        id: "cleanup-scope-knowledge-base",
        name: "再删除知识文档与原始上传并归档知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.cleanup",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.scope-knowledge-base-id}",
        },
      },
    ],
  };
}

function knowledgeRetrievalDefinition(): Readonly<Record<string, unknown>> {
  const orderTitle = "spark-x-b2c-order-${run.id}.pdf";
  const chartTitle = "spark-x-account-chart-${run.id}.pdf";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "KB-003 B2C订单文件准确检索",
      description:
        "创建订单与科目表两个隔离知识库，只将订单知识库绑定到会话，以不可变快照执行真实问答，并校验答案、引用回执与结构化证据只来自订单文件。",
      systemKey: "spark-x-agent",
      moduleKey: "knowledge-base",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: [
        "adapter",
        "knowledge-base",
        "retrieval",
        "immutable-snapshot",
        "evidence",
        "isolation",
        "p0",
        "full-regression",
        "real-model",
      ],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 1_200_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:knowledge-base", "spark-x-agent:admin:conversation"],
    steps: [
      {
        id: "create-order-knowledge-base",
        name: "创建并登记订单知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          name: "spark-x-kb-order-${run.id}",
          description: "Spark X Test Platform KB-003 B2C order fixture",
        },
        capture: { "order-knowledge-base-id": "$.knowledgeBaseId" },
        resource: {
          type: "spark-x-agent-knowledge-base",
          id: "${step.order-knowledge-base-id}",
          cleanup: {
            action: "adapter:spark-x-agent/knowledge-base.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              knowledgeBaseId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "upload-order-fixture",
        name: "上传适配器内置订单 PDF",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.order-knowledge-base-id}",
          fixtureKind: "order",
        },
        capture: {
          "order-uploaded-document-id": "$.uploadedDocumentId",
          "order-fixture-sha256": "$.fixtureSha256",
        },
      },
      {
        id: "attach-order-fixture",
        name: "绑定订单 PDF 并登记知识文档",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.attach-upload",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.order-knowledge-base-id}",
          uploadedDocumentId: "${step.order-uploaded-document-id}",
          title: orderTitle,
        },
        capture: { "order-knowledge-document-id": "$.knowledgeDocumentId" },
      },
      {
        id: "wait-order-ready",
        name: "等待订单文档解析就绪",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.wait-ready",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.order-knowledge-base-id}",
          knowledgeDocumentId: "${step.order-knowledge-document-id}",
          expectedFixtureSha256: "${step.order-fixture-sha256}",
          expectedTitle: orderTitle,
        },
      },
      {
        id: "create-chart-knowledge-base",
        name: "创建并登记科目表隔离知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          name: "spark-x-kb-chart-${run.id}",
          description: "Spark X Test Platform KB-003 account chart decoy fixture",
        },
        capture: { "chart-knowledge-base-id": "$.knowledgeBaseId" },
        resource: {
          type: "spark-x-agent-knowledge-base",
          id: "${step.chart-knowledge-base-id}",
          cleanup: {
            action: "adapter:spark-x-agent/knowledge-base.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              knowledgeBaseId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "upload-chart-fixture",
        name: "上传适配器内置科目表 PDF",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.chart-knowledge-base-id}",
          fixtureKind: "account-chart",
        },
        capture: {
          "chart-uploaded-document-id": "$.uploadedDocumentId",
          "chart-fixture-sha256": "$.fixtureSha256",
        },
      },
      {
        id: "attach-chart-fixture",
        name: "绑定科目表 PDF 并登记隔离文档",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.attach-upload",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.chart-knowledge-base-id}",
          uploadedDocumentId: "${step.chart-uploaded-document-id}",
          title: chartTitle,
        },
        capture: { "chart-knowledge-document-id": "$.knowledgeDocumentId" },
      },
      {
        id: "wait-chart-ready",
        name: "等待科目表隔离文档解析就绪",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.wait-ready",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.chart-knowledge-base-id}",
          knowledgeDocumentId: "${step.chart-knowledge-document-id}",
          expectedFixtureSha256: "${step.chart-fixture-sha256}",
          expectedTitle: chartTitle,
        },
      },
      {
        id: "create-retrieval-conversation",
        name: "创建并登记知识检索测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-kb-retrieval-${run.id}",
        },
        capture: { "retrieval-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.retrieval-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "prepare-order-snapshot",
        name: "仅绑定订单知识库并固定不可变快照",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.retrieval-conversation-id}",
          knowledgeBaseId: "${step.order-knowledge-base-id}",
          knowledgeDocumentId: "${step.order-knowledge-document-id}",
          expectedFixtureSha256: "${step.order-fixture-sha256}",
          clientRequestId: "${run.id}",
        },
        capture: {
          "retrieval-snapshot-id": "$.snapshotId",
          "retrieval-snapshot-hash": "$.snapshotHash",
        },
      },
      {
        id: "query-order-and-assert-evidence",
        name: "真实查询订单并校验答案、引用与隔离证据",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.retrieval-conversation-id}",
          requestId: "${run.id}",
          snapshotId: "${step.retrieval-snapshot-id}",
          snapshotHash: "${step.retrieval-snapshot-hash}",
          knowledgeDocumentId: "${step.order-knowledge-document-id}",
          forbiddenKnowledgeDocumentId: "${step.chart-knowledge-document-id}",
          expectedFixtureSha256: "${step.order-fixture-sha256}",
          expectedTitle: orderTitle,
          expectedResourceMarker: "${step.order-knowledge-base-id}",
          forbiddenResourceMarker: "${step.chart-knowledge-base-id}",
          message:
            "自动化回归 ${run.id}：仅根据知识库回答订单信息，请严格保留文本 B2C-KB-001 | SPARK-REGRESSION | 4200 | PAID | ${step.order-knowledge-base-id}，并保留知识引用。请勿使用科目表内容。",
        },
      },
    ],
    finally: [
      {
        id: "delete-retrieval-conversation",
        name: "先删除知识检索测试会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.retrieval-conversation-id}",
        },
      },
      {
        id: "cleanup-chart-knowledge-base",
        name: "再清理科目表隔离知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.cleanup",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.chart-knowledge-base-id}",
        },
      },
      {
        id: "cleanup-order-knowledge-base",
        name: "最后清理订单知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.cleanup",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.order-knowledge-base-id}",
        },
      },
    ],
  };
}

function knowledgeIsolationDefinition(): Readonly<Record<string, unknown>> {
  const sharedTitle = "spark-x-isolated-order-${run.id}.pdf";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "KB-004 多知识库数据隔离",
      description:
        "在两个独立知识库中创建标题和业务事实相同、运行资源标识不同的订单文件，只绑定主知识库快照，并证明回答与引用证据不会命中未绑定知识库。",
      systemKey: "spark-x-agent",
      moduleKey: "knowledge-base",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: [
        "adapter",
        "knowledge-base",
        "multi-knowledge-base",
        "same-title",
        "immutable-snapshot",
        "isolation",
        "p0",
        "full-regression",
        "real-model",
      ],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 1_200_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:knowledge-base", "spark-x-agent:admin:conversation"],
    steps: [
      {
        id: "create-primary-isolation-base",
        name: "创建并登记已绑定主知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          name: "spark-x-kb-isolation-primary-${run.id}",
          description: "Spark X Test Platform KB-004 bound order fixture",
        },
        capture: { "primary-isolation-base-id": "$.knowledgeBaseId" },
        resource: {
          type: "spark-x-agent-knowledge-base",
          id: "${step.primary-isolation-base-id}",
          cleanup: {
            action: "adapter:spark-x-agent/knowledge-base.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              knowledgeBaseId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "upload-primary-isolation-fixture",
        name: "上传主知识库固定订单 PDF",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.primary-isolation-base-id}",
          fixtureKind: "order",
        },
        capture: {
          "primary-isolation-upload-id": "$.uploadedDocumentId",
          "primary-isolation-fixture-sha256": "$.fixtureSha256",
        },
      },
      {
        id: "attach-primary-isolation-fixture",
        name: "以共享标题绑定主订单文档",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.attach-upload",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.primary-isolation-base-id}",
          uploadedDocumentId: "${step.primary-isolation-upload-id}",
          title: sharedTitle,
        },
        capture: { "primary-isolation-document-id": "$.knowledgeDocumentId" },
      },
      {
        id: "wait-primary-isolation-ready",
        name: "等待主订单文档解析就绪",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.wait-ready",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.primary-isolation-base-id}",
          knowledgeDocumentId: "${step.primary-isolation-document-id}",
          expectedFixtureSha256: "${step.primary-isolation-fixture-sha256}",
          expectedTitle: sharedTitle,
        },
      },
      {
        id: "create-peer-isolation-base",
        name: "创建并登记未绑定对照知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          name: "spark-x-kb-isolation-peer-${run.id}",
          description: "Spark X Test Platform KB-004 unbound order fixture",
        },
        capture: { "peer-isolation-base-id": "$.knowledgeBaseId" },
        resource: {
          type: "spark-x-agent-knowledge-base",
          id: "${step.peer-isolation-base-id}",
          cleanup: {
            action: "adapter:spark-x-agent/knowledge-base.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              knowledgeBaseId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "upload-peer-isolation-fixture",
        name: "上传对照知识库固定订单 PDF",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.peer-isolation-base-id}",
          fixtureKind: "order",
        },
        capture: {
          "peer-isolation-upload-id": "$.uploadedDocumentId",
          "peer-isolation-fixture-sha256": "$.fixtureSha256",
        },
      },
      {
        id: "attach-peer-isolation-fixture",
        name: "以相同标题绑定对照订单文档",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.attach-upload",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.peer-isolation-base-id}",
          uploadedDocumentId: "${step.peer-isolation-upload-id}",
          title: sharedTitle,
        },
        capture: { "peer-isolation-document-id": "$.knowledgeDocumentId" },
      },
      {
        id: "wait-peer-isolation-ready",
        name: "等待对照订单文档解析就绪",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.wait-ready",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.peer-isolation-base-id}",
          knowledgeDocumentId: "${step.peer-isolation-document-id}",
          expectedFixtureSha256: "${step.peer-isolation-fixture-sha256}",
          expectedTitle: sharedTitle,
        },
      },
      {
        id: "create-isolation-conversation",
        name: "创建并登记多知识库隔离会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: "spark-x-kb-isolation-${run.id}",
        },
        capture: { "isolation-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.isolation-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "prepare-primary-isolation-snapshot",
        name: "仅绑定主知识库并固定不可变快照",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.isolation-conversation-id}",
          knowledgeBaseId: "${step.primary-isolation-base-id}",
          knowledgeDocumentId: "${step.primary-isolation-document-id}",
          expectedFixtureSha256: "${step.primary-isolation-fixture-sha256}",
          clientRequestId: "${run.id}",
        },
        capture: {
          "isolation-snapshot-id": "$.snapshotId",
          "isolation-snapshot-hash": "$.snapshotHash",
        },
      },
      {
        id: "query-primary-and-assert-isolation",
        name: "真实查询并校验同名文档跨知识库隔离",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
        timeoutMs: 120_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.isolation-conversation-id}",
          requestId: "${run.id}",
          snapshotId: "${step.isolation-snapshot-id}",
          snapshotHash: "${step.isolation-snapshot-hash}",
          knowledgeDocumentId: "${step.primary-isolation-document-id}",
          forbiddenKnowledgeDocumentId: "${step.peer-isolation-document-id}",
          expectedFixtureSha256: "${step.primary-isolation-fixture-sha256}",
          expectedTitle: sharedTitle,
          expectedResourceMarker: "${step.primary-isolation-base-id}",
          forbiddenResourceMarker: "${step.peer-isolation-base-id}",
          message:
            "自动化回归 ${run.id}：两个知识库存在同名订单文件，只能根据当前绑定范围回答。请严格保留文本 B2C-KB-001 | SPARK-REGRESSION | 4200 | PAID | ${step.primary-isolation-base-id}，并保留知识引用。",
        },
      },
    ],
    finally: [
      {
        id: "delete-isolation-conversation",
        name: "先删除多知识库隔离会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.isolation-conversation-id}",
        },
      },
      {
        id: "cleanup-peer-isolation-base",
        name: "再清理未绑定对照知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.cleanup",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.peer-isolation-base-id}",
        },
      },
      {
        id: "cleanup-primary-isolation-base",
        name: "最后清理已绑定主知识库",
        kind: "action",
        action: "adapter:spark-x-agent/knowledge-base.cleanup",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          knowledgeBaseId: "${step.primary-isolation-base-id}",
        },
      },
    ],
  };
}

function mcpConnectorDefinition(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "MCP-001 内置连接器注册、连接与工具发现",
      description:
        "只读核对 builtin-demo 连接器的用户可见投影、运行状态、管理员工具发现结果和凭据边界；停用时稳定归类为环境前置条件失败。",
      systemKey: "spark-x-agent",
      moduleKey: "mcp",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      owner: "spark-x-test-platform",
      tags: ["adapter", "mcp", "p0", "core-smoke", "connector", "tool-discovery", "read-only"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 20_000,
      caseTimeoutMs: 60_000,
      diagnosticRetries: 0,
    },
    resourceLocks: [],
    steps: [
      {
        id: "assert-mcp-connector",
        name: "校验内置连接器连接状态、工具发现与凭据边界",
        kind: "action",
        action: "adapter:spark-x-agent/tool.assert-safe-catalog",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
        },
      },
    ],
    finally: [],
  };
}

function skillPublicationDefinition(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "SKILL-001 受信任 Skill 发布清单与能力投影",
      description:
        "只读校验部署内置贸易港口日报 Skill 的用户与管理员投影、有效 Task 能力、主资产和精确发布哈希。",
      systemKey: "spark-x-agent",
      moduleKey: "skills",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      owner: "spark-x-test-platform",
      tags: ["adapter", "skill", "p0", "core-smoke", "trusted-publication", "read-only"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 20_000,
      caseTimeoutMs: 60_000,
      diagnosticRetries: 0,
    },
    resourceLocks: [],
    steps: [
      {
        id: "assert-trusted-skill-publication",
        name: "校验受信任 Skill 发布清单与能力投影",
        kind: "action",
        action: "adapter:spark-x-agent/skill.assert-trusted-publication",
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          expectedPublicationSha256: trustedSkillPublicationSha256,
        },
      },
    ],
    finally: [],
  };
}

function automationDefinition(): Readonly<Record<string, unknown>> {
  const name = "spark-x-auto-${run.id}";
  const goal =
    "自动任务回归标识 spark-x-auto-${run.id}。请只回复这个标识，不要调用任何工具或 Skill。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "AUTO-001 新建任务、立即触发、单次结果与完整清理",
      description:
        "创建带 run_id 的无 Skill 自动任务，验证定义持久化、调度只触发一次、结果关联正确，并先删除任务再删除会话。",
      systemKey: "spark-x-agent",
      moduleKey: "automations",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "automation", "p0", "core-smoke", "real-model", "no-tool"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 300_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:automations"],
    steps: [
      {
        id: "create-automation-conversation",
        name: "创建并登记自动任务目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: name,
        },
        capture: { "conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "create-immediate-automation",
        name: "创建并登记立即触发的无 Skill 自动任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
          name,
          goal,
        },
        capture: { "automation-id": "$.automationId" },
        resource: {
          type: "spark-x-agent-automation",
          id: "${step.automation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/automation.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              automationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "wait-single-automation-fire",
        name: "校验单次调度、完整回复和无工具证据",
        kind: "action",
        action: "adapter:spark-x-agent/automation.wait-fired",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.automation-id}",
          conversationId: "${step.conversation-id}",
          expectedName: name,
          expectedGoal: goal,
          expectedAssistantText: "spark-x-auto-${run.id}",
        },
      },
    ],
    finally: [
      {
        id: "cleanup-automation",
        name: "按最新状态版本删除自动任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.cleanup",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.automation-id}",
        },
      },
      {
        id: "delete-automation-conversation",
        name: "删除自动任务目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.conversation-id}",
        },
      },
    ],
  };
}

function automationTimezoneDefinition(): Readonly<Record<string, unknown>> {
  const name = "spark-x-auto-timezone-${run.id}";
  const goal =
    "自动任务时区回归标识 spark-x-auto-timezone-${run.id}。请只回复这个标识，不要调用任何工具或 Skill。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "AUTO-002 Asia/Shanghai 首次触发与下次计划",
      description:
        "创建五秒后首次触发的无 Skill 任务，校验请求与实际触发时间在 Asia/Shanghai 下误差不超过六十秒，UTC 与本地下一次计划均精确推进五分钟，并完整清理。",
      systemKey: "spark-x-agent",
      moduleKey: "automations",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "automation", "p0", "full-regression", "timezone", "real-model"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 300_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:automations"],
    steps: [
      {
        id: "create-timezone-conversation",
        name: "创建并登记时区调度目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: name,
        },
        capture: { "timezone-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.timezone-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "create-timezone-automation",
        name: "创建并登记五秒后首次触发的无 Skill 任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.timezone-conversation-id}",
          name,
          goal,
          firstFireDelaySeconds: 5,
        },
        capture: {
          "timezone-automation-id": "$.automationId",
          "timezone-first-fire-at": "$.nextFireAt",
        },
        resource: {
          type: "spark-x-agent-automation",
          id: "${step.timezone-automation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/automation.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              automationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "wait-timezone-automation-fire",
        name: "校验上海时区首次触发与五分钟下一次计划",
        kind: "action",
        action: "adapter:spark-x-agent/automation.wait-fired",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.timezone-automation-id}",
          conversationId: "${step.timezone-conversation-id}",
          expectedName: name,
          expectedGoal: goal,
          expectedAssistantText: "spark-x-auto-timezone-${run.id}",
          expectedFirstFireAt: "${step.timezone-first-fire-at}",
        },
      },
    ],
    finally: [
      {
        id: "cleanup-timezone-automation",
        name: "按最新状态版本删除时区调度任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.cleanup",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.timezone-automation-id}",
        },
      },
      {
        id: "delete-timezone-conversation",
        name: "删除时区调度目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.timezone-conversation-id}",
        },
      },
    ],
  };
}

function automationIdempotencyDefinition(): Readonly<Record<string, unknown>> {
  const name = "spark-x-auto-idempotency-${run.id}";
  const goal =
    "自动任务幂等回归标识 spark-x-auto-idempotency-${run.id}。请只回复这个标识，不要调用任何工具或 Skill。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "AUTO-004 调度幂等与重复投递防护",
      description:
        "创建一次真实无 Skill 自动任务并等待完成，随后连续三次观察相同状态版本、触发游标和唯一消息对，任何第二次投递或内容漂移立即失败，最后完整清理。",
      systemKey: "spark-x-agent",
      moduleKey: "automations",
      priority: "P1",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "automation", "p1", "full-regression", "idempotency", "real-model"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 180_000,
      caseTimeoutMs: 300_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:automations"],
    steps: [
      {
        id: "create-idempotency-conversation",
        name: "创建并登记幂等调度目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: name,
        },
        capture: { "idempotency-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.idempotency-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "create-idempotency-automation",
        name: "创建并登记立即触发的幂等测试任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.idempotency-conversation-id}",
          name,
          goal,
        },
        capture: { "idempotency-automation-id": "$.automationId" },
        resource: {
          type: "spark-x-agent-automation",
          id: "${step.idempotency-automation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/automation.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              automationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "wait-idempotency-automation-fire",
        name: "等待唯一一次调度完成并捕获游标与回复哈希",
        kind: "action",
        action: "adapter:spark-x-agent/automation.wait-fired",
        timeoutMs: 180_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.idempotency-automation-id}",
          conversationId: "${step.idempotency-conversation-id}",
          expectedName: name,
          expectedGoal: goal,
          expectedAssistantText: "spark-x-auto-idempotency-${run.id}",
        },
        capture: {
          "idempotency-last-fire-at": "$.lastFireAt",
          "idempotency-next-fire-at": "$.nextFireAt",
          "idempotency-assistant-sha256": "$.assistantContentSha256",
        },
      },
      {
        id: "assert-no-duplicate-delivery",
        name: "连续三次断言调度游标与唯一消息对不变",
        kind: "action",
        action: "adapter:spark-x-agent/automation.assert-no-duplicate-delivery",
        timeoutMs: 15_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.idempotency-automation-id}",
          conversationId: "${step.idempotency-conversation-id}",
          expectedName: name,
          expectedGoal: goal,
          expectedAssistantText: "spark-x-auto-idempotency-${run.id}",
          expectedLastFireAt: "${step.idempotency-last-fire-at}",
          expectedNextFireAt: "${step.idempotency-next-fire-at}",
          expectedAssistantSha256: "${step.idempotency-assistant-sha256}",
        },
      },
    ],
    finally: [
      {
        id: "cleanup-idempotency-automation",
        name: "按最新状态版本删除幂等测试任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.cleanup",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.idempotency-automation-id}",
        },
      },
      {
        id: "delete-idempotency-conversation",
        name: "删除幂等调度目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.idempotency-conversation-id}",
        },
      },
    ],
  };
}

function automationLifecycleDefinition(): Readonly<Record<string, unknown>> {
  const name = "spark-x-auto-lifecycle-${run.id}";
  const goal =
    "自动任务生命周期回归标识 spark-x-auto-lifecycle-${run.id}。任务只用于修改、停用和删除，不应触发。";
  const updatedName = "spark-x-auto-lifecycle-${run.id}-updated";
  const updatedGoal =
    "已更新的自动任务生命周期回归标识 spark-x-auto-lifecycle-${run.id}。任务必须在触发前删除。";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "AUTO-003 修改、停用、删除与无触发残留",
      description:
        "创建延迟十分钟且带 run_id 的无 Skill 任务，按乐观版本修改、停用、重新启用和删除，确认列表无残留、目标会话无调度消息，并由 finally 再次幂等清理。",
      systemKey: "spark-x-agent",
      moduleKey: "automations",
      priority: "P1",
      classification: "blackbox",
      actionLevel: "dangerous",
      owner: "spark-x-test-platform",
      tags: ["adapter", "automation", "p1", "full-regression", "lifecycle", "no-trigger"],
    },
    inputs: [
      {
        name: "admin-username",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员用户名",
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        description: "星火 Agent 测试管理员密码",
        secretRef: "spark-x-agent-admin-password",
      },
    ],
    execution: {
      stepTimeoutMs: 60_000,
      caseTimeoutMs: 180_000,
      diagnosticRetries: 0,
    },
    resourceLocks: ["spark-x-agent:admin:automations"],
    steps: [
      {
        id: "create-lifecycle-conversation",
        name: "创建并登记生命周期目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          title: name,
        },
        capture: { "lifecycle-conversation-id": "$.conversationId" },
        resource: {
          type: "spark-x-agent-conversation",
          id: "${step.lifecycle-conversation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/conversation.delete",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              conversationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "create-delayed-lifecycle-automation",
        name: "创建并登记延迟十分钟的无 Skill 任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.create",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.lifecycle-conversation-id}",
          name,
          goal,
          firstFireDelaySeconds: 600,
        },
        capture: { "lifecycle-automation-id": "$.automationId" },
        resource: {
          type: "spark-x-agent-automation",
          id: "${step.lifecycle-automation-id}",
          cleanup: {
            action: "adapter:spark-x-agent/automation.cleanup",
            params: {
              username: "${case.admin-username}",
              password: "${case.admin-password}",
              automationId: "${resource.id}",
            },
          },
        },
      },
      {
        id: "assert-automation-lifecycle",
        name: "按版本修改、停用、重新启用、删除并确认未触发",
        kind: "action",
        action: "adapter:spark-x-agent/automation.assert-lifecycle",
        timeoutMs: 60_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.lifecycle-automation-id}",
          conversationId: "${step.lifecycle-conversation-id}",
          expectedName: name,
          expectedGoal: goal,
          updatedName,
          updatedGoal,
        },
      },
    ],
    finally: [
      {
        id: "cleanup-lifecycle-automation",
        name: "再次幂等清理生命周期任务",
        kind: "action",
        action: "adapter:spark-x-agent/automation.cleanup",
        timeoutMs: 30_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          automationId: "${step.lifecycle-automation-id}",
        },
      },
      {
        id: "delete-lifecycle-conversation",
        name: "删除生命周期目标会话",
        kind: "action",
        action: "adapter:spark-x-agent/conversation.delete",
        timeoutMs: 20_000,
        params: {
          username: "${case.admin-username}",
          password: "${case.admin-password}",
          conversationId: "${step.lifecycle-conversation-id}",
        },
      },
    ],
  };
}

async function ensureCase(
  systemId: string,
  moduleId: string,
  environmentId: string,
  caseName: string,
  definition: Readonly<Record<string, unknown>>,
  changeNote: string,
): Promise<Readonly<{ testCase: CaseRecord; version: CaseVersionRecord }>> {
  const cases = (await api<{ readonly items: CaseRecord[] }>(`/test-cases?systemId=${systemId}`))
    .body.items;
  let testCase = cases.find((candidate) => candidate.name === caseName);
  let version: CaseVersionRecord;
  if (testCase === undefined) {
    testCase = (
      await api<CaseRecord>("/test-cases", {
        method: "POST",
        body: {
          moduleId,
          definition,
          changeNote,
        },
      })
    ).body;
    check(testCase.currentDraftVersionId !== null, "new case does not have a draft version");
    const createdVersions = (await api<CaseVersionRecord[]>(`/test-cases/${testCase.id}/versions`))
      .body;
    const createdVersion = createdVersions.find(
      (candidate) => candidate.id === testCase?.currentDraftVersionId,
    );
    check(createdVersion !== undefined, `new ${caseName} draft version was not found`);
    version = createdVersion;
  } else {
    check(testCase.moduleId === moduleId, `${caseName} is attached to an unexpected module`);
    const versions = (await api<CaseVersionRecord[]>(`/test-cases/${testCase.id}/versions`)).body;
    const latest = versions[0];
    check(latest !== undefined, `existing ${caseName} does not have a version`);
    if (canonical(latest.definition) === canonical(definition)) {
      version = latest;
    } else {
      version = (
        await api<CaseVersionRecord>(`/test-cases/${testCase.id}/versions`, {
          method: "POST",
          body: {
            definition,
            expectedBaseVersion: latest.version,
            changeNote,
          },
        })
      ).body;
    }
  }
  const validation = await api<{
    readonly valid: boolean;
    readonly issues: readonly unknown[];
  }>(`/test-case-versions/${version.id}/validations`, {
    method: "POST",
    body: { environmentId },
  });
  check(validation.body.valid, `${caseName} validation failed: ${JSON.stringify(validation.body)}`);
  if (testCase.currentPublishedVersionId !== version.id || testCase.status !== "published") {
    testCase = (
      await api<CaseRecord>(`/test-cases/${testCase.id}/publish`, {
        method: "POST",
        body: { versionId: version.id },
      })
    ).body;
  }
  return { testCase, version };
}

async function ensureSuite(
  systemId: string,
  key: string,
  name: string,
  description: string,
  caseIds: readonly string[],
): Promise<SuiteRecord> {
  const input = {
    systemId,
    key,
    name,
    description,
    caseIds,
    defaultConcurrency: 1,
    defaultDiagnosticRetries: 0,
  };
  const suites = (await api<{ readonly items: SuiteRecord[] }>("/test-suites")).body.items;
  const existing = suites.find((suite) => suite.systemId === systemId && suite.key === input.key);
  return existing === undefined
    ? (await api<SuiteRecord>("/test-suites", { method: "POST", body: input })).body
    : (
        await api<SuiteRecord>(`/test-suites/${existing.id}`, {
          method: "PATCH",
          body: input,
        })
      ).body;
}

async function waitForRun(runId: string): Promise<RunDetail> {
  const deadline = Date.now() + 900_000;
  let last: RunDetail | undefined;
  while (Date.now() < deadline) {
    last = (await api<RunDetail>(`/runs/${runId}`)).body;
    if (last.status === "completed") return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Spark X Agent P0 run did not complete: ${JSON.stringify(last)}`);
}

async function executeSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-core-smoke-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-core-smoke-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent core smoke run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(run.gateResult === "passed", `Spark X Agent core smoke gate is ${String(run.gateResult)}`);
  check(run.summary.passed === 11, "Spark X Agent core smoke cases did not all pass");
  check(run.firstFailure === null, "Spark X Agent core smoke retained an unexpected first failure");
  check(run.cases.length === 11, "Spark X Agent core smoke run case linkage is incomplete");
  check(
    run.cases.every((item) => item.result === "passed"),
    "Spark X Agent core smoke case failed",
  );
  check(
    run.cases.every((item) => ["passed", "not_required"].includes(item.cleanupStatus)),
    "Spark X Agent core smoke cleanup status is invalid",
  );
  check(
    run.steps.length === 47,
    "Spark X Agent core smoke did not record thirty-six main steps and eleven finally steps",
  );
  check(
    run.steps.every((step) => step.status === "passed"),
    "Spark X Agent core smoke step failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/conversation.assert-recent",
        "finally:adapter:spark-x-agent/conversation.delete",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/conversation.assert-recent",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/chat.assert-context-history",
        "finally:adapter:spark-x-agent/conversation.delete",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/chat.assert-history",
        "finally:adapter:spark-x-agent/conversation.delete",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/chat.assert-context-history",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/conversation.delete",
        "main:adapter:spark-x-agent/tool.assert-safe-catalog",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/tool.assert-safe-catalog",
        "main:adapter:spark-x-agent/tool.invoke-safe",
        "main:adapter:spark-x-agent/tool.assert-history",
        "finally:adapter:spark-x-agent/conversation.delete",
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
        "main:adapter:spark-x-agent/skill.assert-trusted-publication",
        "main:adapter:spark-x-agent/tool.assert-safe-catalog",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/automation.create",
        "main:adapter:spark-x-agent/automation.wait-fired",
        "finally:adapter:spark-x-agent/automation.cleanup",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(","),
    "Spark X Agent core smoke structured step sequence is incorrect",
  );
  check(run.resources.length === 11, "Spark X Agent core smoke resource ledger linkage is missing");
  check(
    run.resources.filter((resource) => resource.resourceType === "spark-x-agent-conversation")
      .length === 8 &&
      run.resources.filter((resource) => resource.resourceType === "spark-x-agent-knowledge-base")
        .length === 2 &&
      run.resources.filter((resource) => resource.resourceType === "spark-x-agent-automation")
        .length === 1,
    "Spark X Agent core smoke resource type is incorrect",
  );
  check(
    run.resources.every((resource) => resource.cleanupStatus === "passed"),
    "Spark X Agent core smoke resource is not cleaned",
  );
  check(
    run.cleanupJob === null,
    "normal Spark X Agent core smoke unexpectedly required compensation",
  );
  const chatAsk = run.steps.find((step) => step.stepId === "ask-chat");
  const chatHistory = run.steps.find((step) => step.stepId === "assert-chat-history");
  check(chatAsk?.outputSummary?.done === true, "CHAT-001 did not record a terminal done event");
  check(
    chatAsk.outputSummary.expectedTextMatched === true &&
      chatAsk.outputSummary.truncated === false &&
      typeof chatAsk.outputSummary.finalContentSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(chatAsk.outputSummary.finalContentSha256),
    "CHAT-001 stream evidence is incomplete",
  );
  check(
    chatHistory?.outputSummary?.expectedUserTextMatched === true &&
      chatHistory.outputSummary.expectedAssistantTextMatched === true &&
      chatHistory.outputSummary.assistantContentSha256 === chatAsk.outputSummary.finalContentSha256,
    "CHAT-001 persisted history is not linked to the streamed answer",
  );
  assertConversationReopenEvidence(run);
  assertContextEvidence(run);
  const toolCatalog = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/tool.assert-safe-catalog",
  );
  check(
    toolCatalog?.outputSummary?.serverName === "builtin-demo" &&
      toolCatalog.outputSummary.visible === true &&
      toolCatalog.outputSummary.running === true &&
      toolCatalog.outputSummary.credentialFieldsAbsent === true &&
      toolCatalog.outputSummary.advertisedToolCount === 3 &&
      toolCatalog.outputSummary.enabledDiscoveredToolCount === 3 &&
      toolCatalog.outputSummary.expectedToolsMatched === true &&
      toolCatalog.outputSummary.writeToolsAbsent === true &&
      toolCatalog.outputSummary.reviewRequiredToolsAbsent === true &&
      toolCatalog.outputSummary.unsafeRiskToolsAbsent === true &&
      typeof toolCatalog.outputSummary.catalogSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(toolCatalog.outputSummary.catalogSha256),
    "TOOL-001 safe catalog evidence is incomplete",
  );
  const toolInvocation = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/tool.invoke-safe",
  );
  const toolHistory = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/tool.assert-history",
  );
  check(
    toolInvocation?.outputSummary?.done === true &&
      toolInvocation.outputSummary.expectedTextMatched === true &&
      toolInvocation.outputSummary.expectedToolNameMatched === true &&
      toolInvocation.outputSummary.argumentsMatched === true &&
      toolInvocation.outputSummary.resultMatched === true &&
      toolInvocation.outputSummary.toolCallCount === 1 &&
      toolInvocation.outputSummary.toolResultCount === 1 &&
      toolInvocation.outputSummary.reviewEventCount === 0 &&
      toolInvocation.outputSummary.truncated === false &&
      typeof toolInvocation.outputSummary.argumentsSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(toolInvocation.outputSummary.argumentsSha256) &&
      typeof toolInvocation.outputSummary.resultSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(toolInvocation.outputSummary.resultSha256) &&
      typeof toolInvocation.outputSummary.finalContentSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(toolInvocation.outputSummary.finalContentSha256),
    "TOOL-002 streamed tool evidence is incomplete",
  );
  check(
    toolHistory?.outputSummary?.expectedUserTextMatched === true &&
      toolHistory.outputSummary.expectedAssistantTextMatched === true &&
      toolHistory.outputSummary.expectedToolNameMatched === true &&
      toolHistory.outputSummary.toolCallCount === 1 &&
      toolHistory.outputSummary.toolResultCount === 1 &&
      toolHistory.outputSummary.traceToolCallCount === 1 &&
      toolHistory.outputSummary.traceToolResultCount === 1 &&
      toolHistory.outputSummary.argumentsSha256 === toolInvocation.outputSummary.argumentsSha256 &&
      toolHistory.outputSummary.resultSha256 === toolInvocation.outputSummary.resultSha256 &&
      toolHistory.outputSummary.assistantContentSha256 ===
        toolInvocation.outputSummary.finalContentSha256,
    "TOOL-002 persisted messages or public trace are not linked to the streamed evidence",
  );
  assertKnowledgeEvidence(run);
  assertKnowledgeScopeEvidence(run);
  assertSkillEvidence(run);
  assertMcpEvidence(run);
  assertAutomationEvidence(run);
  const evidence = JSON.stringify(run);
  if (password !== undefined) {
    check(
      !evidence.includes(password),
      "Spark X Agent administrator password leaked into evidence",
    );
  }
  check(
    !evidence.includes('{"operation":"multiply","a":6,"b":7}') &&
      !evidence.includes('{"success":true,"operation":"multiply","a":6,"b":7,"result":42}'),
    "Spark X Agent tool arguments or result leaked into structured evidence",
  );
  return run;
}

function assertContextEvidence(run: RunDetail): void {
  const contextAskIds = new Set([
    "seed-decoy-conversation",
    "ask-context-first-turn",
    "ask-context-second-turn",
  ]);
  const asks = run.steps.filter(
    (step) => step.action === "adapter:spark-x-agent/chat.ask" && contextAskIds.has(step.stepId),
  );
  const history = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/chat.assert-context-history",
  );
  check(asks.length === 3, "CHAT-002 did not record three isolated streamed turns");
  const [decoyAsk, firstAsk, secondAsk] = asks;
  check(
    [decoyAsk, firstAsk, secondAsk].every(
      (step) =>
        step?.outputSummary?.done === true &&
        step.outputSummary.expectedTextMatched === true &&
        step.outputSummary.toolEventCount === 0 &&
        step.outputSummary.skillEventCount === 0 &&
        step.outputSummary.reviewEventCount === 0 &&
        step.outputSummary.truncated === false &&
        typeof step.outputSummary.finalContentSha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(step.outputSummary.finalContentSha256),
    ),
    "CHAT-002 streamed turn evidence is incomplete or unexpectedly invoked an extension",
  );
  check(
    decoyAsk?.outputSummary?.finalContentSha256 !== firstAsk?.outputSummary?.finalContentSha256 &&
      decoyAsk?.outputSummary?.finalContentSha256 !== secondAsk?.outputSummary?.finalContentSha256,
    "CHAT-002 decoy response is not isolated from the main conversation",
  );
  check(
    history?.outputSummary?.messageCount === 4 &&
      history.outputSummary.userMessageCount === 2 &&
      history.outputSummary.assistantMessageCount === 2 &&
      history.outputSummary.toolMessageCount === 0 &&
      history.outputSummary.expectedOrderMatched === true &&
      history.outputSummary.firstAssistantHashMatched === true &&
      history.outputSummary.secondAssistantHashMatched === true &&
      history.outputSummary.secondExpectedTextMatched === true &&
      history.outputSummary.forbiddenTextAbsent === true &&
      history.outputSummary.assistantFinishReasonsMatched === true &&
      history.outputSummary.firstAssistantContentSha256 ===
        firstAsk?.outputSummary?.finalContentSha256 &&
      history.outputSummary.secondAssistantContentSha256 ===
        secondAsk?.outputSummary?.finalContentSha256,
    "CHAT-002 persisted history, context continuation or cross-conversation isolation is incomplete",
  );
  const evidence = JSON.stringify({ asks, history });
  check(
    !evidence.includes("请记住上下文标识") &&
      !evidence.includes("独立干扰会话标识") &&
      !evidence.includes("memory-only-access-token"),
    "CHAT-002 message content or in-memory token leaked into structured evidence",
  );
}

async function executeContextSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-chat-context-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-chat-context-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent context run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(run.gateResult === "passed", `Spark X Agent context gate is ${String(run.gateResult)}`);
  check(run.summary.passed === 1, "Spark X Agent context case did not pass");
  check(run.firstFailure === null, "Spark X Agent context run retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent context case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/chat.assert-context-history",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent context structured step sequence is incomplete",
  );
  check(
    run.resources.length === 2 &&
      run.resources.every(
        (resource) =>
          resource.resourceType === "spark-x-agent-conversation" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete" &&
          resource.cleanupStatus === "passed",
      ),
    "Spark X Agent context resource ledger or cleanup order is incomplete",
  );
  check(run.cleanupJob === null, "normal context run unexpectedly required compensation");
  assertContextEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into CHAT-002 evidence",
    );
  }
  return run;
}

function assertCancelEvidence(run: RunDetail): void {
  const cancelled = run.steps.find((step) => step.stepId === "cancel-active-turn-and-resume");
  const recent = run.steps.find((step) => step.stepId === "assert-cancel-conversation-recent");
  const cancelMessage = `请生成一篇不少于五千字的长回答，用于用户停止生成回归。不要调用工具或 Skill。取消标识 ${run.id}。`;
  const marker = `spark-x-cancel-resume-${run.id}`;
  const resumeMessage = `上一轮已经由用户停止，不要继续上一轮内容。请只回复恢复标识 ${marker}，不要调用工具或 Skill。`;
  const summary = cancelled?.outputSummary;
  check(
    summary !== null &&
      summary !== undefined &&
      typeof summary.conversationId === "string" &&
      typeof summary.cancelledTurnId === "string" &&
      typeof summary.resumedTurnId === "string" &&
      summary.cancelledTurnId !== summary.resumedTurnId &&
      summary.cancelRequested === true &&
      summary.cancelActionBoundary === "none" &&
      summary.cancelledStatus === "cancelled" &&
      summary.cancelledAssistantAbsent === true &&
      summary.resumeCompleted === true &&
      summary.messageCount === 3 &&
      summary.cancelledUserMessageCount === 1 &&
      summary.resumedUserMessageCount === 1 &&
      summary.resumedAssistantMessageCount === 1 &&
      summary.toolMessageCount === 0 &&
      summary.ghostAssistantCount === 0 &&
      summary.expectedTextMatched === true &&
      summary.cancelInputSha256 === createHash("sha256").update(cancelMessage).digest("hex") &&
      summary.resumeInputSha256 === createHash("sha256").update(resumeMessage).digest("hex") &&
      typeof summary.resumeAssistantSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(summary.resumeAssistantSha256) &&
      typeof summary.resumeAssistantContentLength === "number" &&
      summary.resumeAssistantContentLength > 0 &&
      typeof summary.activePollAttempts === "number" &&
      summary.activePollAttempts >= 1 &&
      typeof summary.cancelPollAttempts === "number" &&
      summary.cancelPollAttempts >= 1 &&
      typeof summary.resumePollAttempts === "number" &&
      summary.resumePollAttempts >= 1,
    "CHAT-003 cancellation, ghost-message or same-conversation resume evidence is incomplete",
  );
  check(
    recent?.outputSummary?.conversationId === summary.conversationId &&
      recent.outputSummary.listed === true &&
      recent.outputSummary.occurrenceCount === 1 &&
      recent.outputSummary.messageCount === 3 &&
      recent.outputSummary.messageCountSource === "conversation-history",
    "CHAT-003 recent conversation projection did not preserve the exact three-message history",
  );
  const evidence = JSON.stringify({ cancelled, recent });
  check(
    !evidence.includes(cancelMessage) &&
      !evidence.includes(resumeMessage) &&
      !evidence.includes(marker) &&
      !evidence.includes("memory-only-access-token"),
    "CHAT-003 prompt, expected marker or in-memory token leaked into structured evidence",
  );
}

async function executeCancelSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-chat-cancel-p1-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-chat-cancel-p1-verification",
      priority: 90,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent chat cancellation run was not accepted");
  const run = await waitForRun(accepted.body.id);
  check(
    run.gateResult === "passed",
    `Spark X Agent chat cancellation gate is ${String(run.gateResult)}`,
  );
  check(run.summary.passed === 1, "Spark X Agent chat cancellation case did not pass");
  check(run.firstFailure === null, "Spark X Agent chat cancellation retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent chat cancellation case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.cancel-and-resume",
        "main:adapter:spark-x-agent/conversation.assert-recent",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent chat cancellation structured step sequence is incomplete",
  );
  check(
    run.resources.length === 1 &&
      run.resources[0]?.resourceType === "spark-x-agent-conversation" &&
      run.resources[0].cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete" &&
      run.resources[0].cleanupStatus === "passed",
    "Spark X Agent chat cancellation resource ledger or cleanup is incomplete",
  );
  check(run.cleanupJob === null, "normal chat cancellation run unexpectedly required compensation");
  assertCancelEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into CHAT-003 evidence",
    );
  }
  return run;
}

function assertConversationPaginationEvidence(run: RunDetail): void {
  const createSteps = run.steps.filter(
    (step) => step.phase === "main" && step.action === "adapter:spark-x-agent/conversation.create",
  );
  const pagination = run.steps.find(
    (step) =>
      step.phase === "main" &&
      step.action === "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
  );
  check(
    createSteps.length === 3 &&
      createSteps.every(
        (step) =>
          typeof step.outputSummary?.conversationId === "string" &&
          typeof step.outputSummary.title === "string",
      ),
    "CONV-003 did not create three structured run-scoped conversations",
  );
  const summary = pagination?.outputSummary;
  check(
    summary !== null &&
      summary !== undefined &&
      summary.conversationId === createSteps[0]?.outputSummary?.conversationId &&
      summary.renamed === true &&
      summary.titleSource === "manual" &&
      summary.titleSha256 ===
        createHash("sha256").update(`spark-x-page-renamed-${run.id}`).digest("hex") &&
      summary.pageSize === 2 &&
      summary.expectedConversationCount === 3 &&
      typeof summary.firstSweepPages === "number" &&
      summary.firstSweepPages >= 2 &&
      typeof summary.secondSweepPages === "number" &&
      summary.secondSweepPages >= 2 &&
      typeof summary.distinctExpectedPages === "number" &&
      summary.distinctExpectedPages >= 2 &&
      summary.duplicateCount === 0 &&
      summary.missingCount === 0 &&
      summary.crossPage === true &&
      summary.orderStable === true,
    "CONV-003 rename, pagination or stable-order evidence is incomplete",
  );
  check(
    !JSON.stringify(summary).includes(`spark-x-page-renamed-${run.id}`) &&
      !JSON.stringify(summary).includes("memory-only-access-token"),
    "CONV-003 renamed title or in-memory token leaked into pagination evidence",
  );
}

async function executeConversationPaginationSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-conversation-pagination-p1-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-conversation-pagination-p1-verification",
      priority: 90,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent conversation pagination run was not accepted");
  const run = await waitForRun(accepted.body.id);
  check(
    run.gateResult === "passed",
    `Spark X Agent conversation pagination gate is ${String(run.gateResult)}`,
  );
  check(run.summary.passed === 1, "Spark X Agent conversation pagination case did not pass");
  check(
    run.firstFailure === null,
    "Spark X Agent conversation pagination retained a first failure",
  );
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent conversation pagination case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/conversation.rename-and-assert-pagination",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent conversation pagination structured step sequence is incomplete",
  );
  check(
    run.resources.length === 3 &&
      run.resources.every(
        (resource) =>
          resource.resourceType === "spark-x-agent-conversation" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete" &&
          resource.cleanupStatus === "passed",
      ),
    "Spark X Agent conversation pagination resource ledger or cleanup is incomplete",
  );
  check(
    run.cleanupJob === null,
    "normal conversation pagination run unexpectedly required compensation",
  );
  assertConversationPaginationEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into CONV-003 evidence",
    );
  }
  return run;
}

function assertConversationDeleteEvidence(run: RunDetail): void {
  const create = run.steps.find((step) => step.stepId === "create-delete-conversation");
  const recent = run.steps.find((step) => step.stepId === "assert-delete-conversation-unique");
  const deletedState = run.steps.find(
    (step) => step.stepId === "assert-conversation-deleted-state",
  );
  const deleteSteps = run.steps.filter(
    (step) => step.action === "adapter:spark-x-agent/conversation.delete",
  );
  const conversationId = create?.outputSummary?.conversationId;
  check(
    typeof conversationId === "string" &&
      recent?.outputSummary?.conversationId === conversationId &&
      recent.outputSummary.listed === true &&
      recent.outputSummary.occurrenceCount === 1 &&
      recent.outputSummary.messageCount === 0 &&
      recent.outputSummary.messageCountSource === "conversation-history",
    "CONV-004 did not prove a unique active conversation before deletion",
  );
  check(
    deletedState?.outputSummary?.conversationId === conversationId &&
      ["deleted", "missing"].includes(String(deletedState.outputSummary.detailState)) &&
      deletedState.outputSummary.activeOccurrences === 0 &&
      deletedState.outputSummary.deletedOccurrences === 1 &&
      typeof deletedState.outputSummary.activePagesScanned === "number" &&
      deletedState.outputSummary.activePagesScanned >= 1 &&
      typeof deletedState.outputSummary.deletedPagesScanned === "number" &&
      deletedState.outputSummary.deletedPagesScanned >= 1 &&
      deletedState.outputSummary.uniqueDeletedRecord === true,
    "CONV-004 deleted-state projection is incomplete or duplicated",
  );
  check(
    deleteSteps.length === 3 &&
      deleteSteps.every(
        (step) =>
          step.outputSummary?.conversationId === conversationId &&
          step.outputSummary.deleted === true,
      ),
    "CONV-004 first delete, repeated delete or finally cleanup was not idempotently successful",
  );
  check(
    !JSON.stringify({ recent, deletedState, deleteSteps }).includes(`spark-x-delete-${run.id}`) &&
      !JSON.stringify(deletedState).includes("memory-only-access-token"),
    "CONV-004 title or in-memory token leaked into deletion evidence",
  );
}

async function executeConversationDeleteSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-conversation-delete-p1-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-conversation-delete-p1-verification",
      priority: 90,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent conversation deletion run was not accepted");
  const run = await waitForRun(accepted.body.id);
  check(
    run.gateResult === "passed",
    `Spark X Agent conversation deletion gate is ${String(run.gateResult)}`,
  );
  check(run.summary.passed === 1, "Spark X Agent conversation deletion case did not pass");
  check(run.firstFailure === null, "Spark X Agent conversation deletion retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent conversation deletion case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/conversation.assert-recent",
        "main:adapter:spark-x-agent/conversation.delete",
        "main:adapter:spark-x-agent/conversation.assert-deleted-state",
        "main:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent conversation deletion structured step sequence is incomplete",
  );
  check(
    run.resources.length === 1 &&
      run.resources[0]?.resourceType === "spark-x-agent-conversation" &&
      run.resources[0].cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete" &&
      run.resources[0].cleanupStatus === "passed",
    "Spark X Agent conversation deletion resource ledger or cleanup is incomplete",
  );
  check(run.cleanupJob === null, "normal conversation deletion run required compensation");
  assertConversationDeleteEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into CONV-004 evidence",
    );
  }
  return run;
}

function assertConversationReopenEvidence(run: RunDetail): void {
  const firstAsk = run.steps.find((step) => step.stepId === "ask-reopen-first-turn");
  const recent = run.steps.find((step) => step.stepId === "reopen-from-recent-list");
  const secondAsk = run.steps.find((step) => step.stepId === "ask-reopen-second-turn");
  const history = run.steps.find((step) => step.stepId === "assert-reopen-history");
  check(
    [firstAsk, secondAsk].every(
      (step) =>
        step?.outputSummary?.done === true &&
        step.outputSummary.expectedTextMatched === true &&
        step.outputSummary.toolEventCount === 0 &&
        step.outputSummary.skillEventCount === 0 &&
        step.outputSummary.reviewEventCount === 0 &&
        step.outputSummary.truncated === false &&
        typeof step.outputSummary.finalContentSha256 === "string" &&
        /^[0-9a-f]{64}$/u.test(step.outputSummary.finalContentSha256),
    ),
    "CONV-002 streamed continuation evidence is incomplete or unexpectedly invoked an extension",
  );
  check(
    recent?.outputSummary?.listed === true &&
      recent.outputSummary.occurrenceCount === 1 &&
      typeof recent.outputSummary.recentPosition === "number" &&
      recent.outputSummary.recentPosition >= 0 &&
      recent.outputSummary.messageCount === 2 &&
      recent.outputSummary.messageCountSource === "conversation-history",
    "CONV-002 did not reopen the first-turn conversation from the recent list",
  );
  check(
    history?.outputSummary?.messageCount === 4 &&
      history.outputSummary.userMessageCount === 2 &&
      history.outputSummary.assistantMessageCount === 2 &&
      history.outputSummary.toolMessageCount === 0 &&
      history.outputSummary.expectedOrderMatched === true &&
      history.outputSummary.firstAssistantHashMatched === true &&
      history.outputSummary.secondAssistantHashMatched === true &&
      history.outputSummary.secondExpectedTextMatched === true &&
      history.outputSummary.forbiddenTextAbsent === true &&
      history.outputSummary.assistantFinishReasonsMatched === true &&
      history.outputSummary.firstAssistantContentSha256 ===
        firstAsk?.outputSummary?.finalContentSha256 &&
      history.outputSummary.secondAssistantContentSha256 ===
        secondAsk?.outputSummary?.finalContentSha256,
    "CONV-002 reopened history, context or empty extension scope is incomplete",
  );
  const evidence = JSON.stringify({ firstAsk, recent, secondAsk, history });
  check(
    !evidence.includes("请记住会话恢复标识") &&
      !evidence.includes("从最近会话重新打开") &&
      !evidence.includes("memory-only-access-token"),
    "CONV-002 message content or in-memory token leaked into structured evidence",
  );
}

async function executeConversationReopenSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-conversation-reopen-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-conversation-reopen-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent conversation reopen run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(
    run.gateResult === "passed",
    `Spark X Agent conversation reopen gate is ${String(run.gateResult)}`,
  );
  check(run.summary.passed === 1, "Spark X Agent conversation reopen case did not pass");
  check(run.firstFailure === null, "Spark X Agent conversation reopen retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent conversation reopen case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/conversation.assert-recent",
        "main:adapter:spark-x-agent/chat.ask",
        "main:adapter:spark-x-agent/chat.assert-context-history",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent conversation reopen structured step sequence is incomplete",
  );
  check(
    run.resources.length === 1 &&
      run.resources[0]?.resourceType === "spark-x-agent-conversation" &&
      run.resources[0].cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete" &&
      run.resources[0].cleanupStatus === "passed",
    "Spark X Agent conversation reopen resource ledger or cleanup is incomplete",
  );
  check(
    run.cleanupJob === null,
    "normal conversation reopen run unexpectedly required compensation",
  );
  assertConversationReopenEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into CONV-002 evidence",
    );
  }
  return run;
}

function assertMcpEvidence(run: RunDetail): void {
  const connector = run.steps.find((step) => step.stepId === "assert-mcp-connector");
  const summary = connector?.outputSummary;
  check(
    summary?.serverName === "builtin-demo" &&
      summary.visible === true &&
      summary.running === true &&
      summary.credentialFieldsAbsent === true &&
      summary.advertisedToolCount === 3 &&
      summary.enabledDiscoveredToolCount === 3 &&
      summary.expectedToolsMatched === true &&
      summary.writeToolsAbsent === true &&
      summary.reviewRequiredToolsAbsent === true &&
      summary.unsafeRiskToolsAbsent === true &&
      typeof summary.catalogSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(summary.catalogSha256),
    "MCP-001 connector registration, running state or discovered-tool evidence is incomplete",
  );
  check(
    Object.keys(summary).sort().join(",") ===
      [
        "advertisedToolCount",
        "catalogSha256",
        "credentialFieldsAbsent",
        "enabledDiscoveredToolCount",
        "expectedToolsMatched",
        "reviewRequiredToolsAbsent",
        "running",
        "serverName",
        "unsafeRiskToolsAbsent",
        "visible",
        "writeToolsAbsent",
      ]
        .sort()
        .join(","),
    "MCP-001 evidence contains unregistered fields that could expose connector configuration",
  );
}

function assertSkillEvidence(run: RunDetail): void {
  const skill = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/skill.assert-trusted-publication",
  );
  const summary = skill?.outputSummary;
  check(summary !== null && summary !== undefined, "SKILL-001 output evidence is missing");
  check(
    summary.skillName === "trade-port-daily-brief" &&
      typeof summary.skillId === "string" &&
      summary.available === true &&
      summary.enabled === true &&
      summary.builtin === false &&
      summary.durableAgentTask === true &&
      summary.userAdminProjectionMatched === true &&
      summary.publicationHashMatched === true &&
      summary.promptSha256 === trustedSkillPublicationSha256 &&
      summary.mainFileSha256 === trustedSkillPublicationSha256 &&
      typeof summary.promptSizeBytes === "number" &&
      summary.promptSizeBytes > 0 &&
      summary.promptSizeBytes <= 65_536 &&
      typeof summary.assetRootPresent === "boolean" &&
      typeof summary.mainAssetPresent === "boolean",
    "SKILL-001 trusted publication evidence is incomplete or not linked to the exact hash",
  );
  check(
    Object.keys(summary).sort().join(",") ===
      [
        "assetRootPresent",
        "available",
        "builtin",
        "durableAgentTask",
        "enabled",
        "mainAssetPresent",
        "mainFileSha256",
        "promptSha256",
        "promptSizeBytes",
        "publicationHashMatched",
        "skillId",
        "skillName",
        "userAdminProjectionMatched",
      ]
        .sort()
        .join(","),
    "SKILL-001 evidence contains unregistered fields that could expose Skill content",
  );
}

function assertKnowledgeEvidence(run: RunDetail): void {
  const upload = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/knowledge-base.upload-fixture",
  );
  const attach = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/knowledge-base.attach-upload",
  );
  const ready = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/knowledge-base.wait-ready",
  );
  const cleanup = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/knowledge-base.cleanup",
  );
  check(
    upload?.outputSummary?.uploaded === true &&
      typeof upload.outputSummary.uploadedDocumentId === "string" &&
      typeof upload.outputSummary.fixtureSizeBytes === "number" &&
      upload.outputSummary.fixtureSizeBytes > 0 &&
      typeof upload.outputSummary.fixtureSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(upload.outputSummary.fixtureSha256) &&
      typeof upload.outputSummary.fileNameSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(upload.outputSummary.fileNameSha256),
    "KB-001 fixed upload evidence is incomplete",
  );
  check(
    attach?.outputSummary?.attached === true &&
      attach.outputSummary.uploadedDocumentId === upload.outputSummary.uploadedDocumentId &&
      typeof attach.outputSummary.knowledgeDocumentId === "string" &&
      typeof attach.outputSummary.documentStatus === "string" &&
      typeof attach.outputSummary.titleSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(attach.outputSummary.titleSha256),
    "KB-001 attach evidence is incomplete",
  );
  check(
    ready?.outputSummary?.ready === true &&
      ready.outputSummary.documentStatus === "completed" &&
      ready.outputSummary.documentCount === 1 &&
      ready.outputSummary.readyDocumentCount === 1 &&
      ready.outputSummary.currentVersionNumber === 1 &&
      ready.outputSummary.versionCount === 1 &&
      ready.outputSummary.parserVersionPresent === true &&
      ready.outputSummary.contentHashMatched === true &&
      ready.outputSummary.titleMatched === true &&
      ready.outputSummary.fixtureSha256 === upload.outputSummary.fixtureSha256,
    "KB-001 parser version evidence is incomplete or not linked to the upload hash",
  );
  check(
    cleanup?.outputSummary?.cleaned === true &&
      cleanup.outputSummary.knowledgeDocumentDeleteCount === 1 &&
      cleanup.outputSummary.rawDocumentDeleted === true &&
      cleanup.outputSummary.knowledgeBaseArchived === true,
    "KB-001 full cleanup evidence is incomplete",
  );
  const evidence = JSON.stringify({ upload, attach, ready, cleanup });
  check(
    !evidence.includes("source_url") &&
      !evidence.includes("parser-source") &&
      !evidence.includes("SPARK_X_KB_FIXTURE") &&
      !evidence.includes("B2C-KB-001") &&
      !evidence.includes("AMOUNT_CNY"),
    "KB-001 signed source URL or fixture contents leaked into structured evidence",
  );
}

function assertKnowledgeScopeEvidence(run: RunDetail): void {
  const upload = run.steps.find((step) => step.stepId === "upload-scope-knowledge-fixture");
  const attach = run.steps.find((step) => step.stepId === "attach-scope-knowledge-fixture");
  const ready = run.steps.find((step) => step.stepId === "wait-scope-knowledge-ready");
  const conversation = run.steps.find((step) => step.stepId === "create-scope-conversation");
  const scope = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
  );
  const deleteConversation = run.steps.find((step) => step.stepId === "delete-scope-conversation");
  const cleanup = run.steps.find((step) => step.stepId === "cleanup-scope-knowledge-base");
  check(
    scope?.outputSummary?.retrievalPolicy === "required" &&
      scope.outputSummary.scopeRevision === 1 &&
      typeof scope.outputSummary.scopeHash === "string" &&
      /^[0-9a-f]{64}$/u.test(scope.outputSummary.scopeHash) &&
      scope.outputSummary.scopeKnowledgeBaseCount === 1 &&
      scope.outputSummary.scopeDocumentCount === 1 &&
      scope.outputSummary.scopeReadyDocumentCount === 1 &&
      typeof scope.outputSummary.snapshotId === "string" &&
      typeof scope.outputSummary.snapshotHash === "string" &&
      /^[0-9a-f]{64}$/u.test(scope.outputSummary.snapshotHash) &&
      scope.outputSummary.snapshotStatus === "prepared" &&
      scope.outputSummary.snapshotKnowledgeBaseCount === 1 &&
      scope.outputSummary.snapshotReadyDocumentCount === 1 &&
      scope.outputSummary.snapshotExcludedDocumentCount === 0 &&
      scope.outputSummary.snapshotDocumentCount === 1 &&
      scope.outputSummary.scopeMatched === true &&
      scope.outputSummary.documentMatched === true &&
      scope.outputSummary.contentHashMatched === true &&
      scope.outputSummary.firstCreated === true &&
      scope.outputSummary.idempotentReplay === true &&
      scope.outputSummary.snapshotIdentityMatched === true &&
      scope.outputSummary.scopeStable === true,
    "KB-002 knowledge scope or immutable snapshot evidence is incomplete",
  );
  check(
    scope.outputSummary.conversationId === conversation?.outputSummary?.conversationId &&
      scope.outputSummary.knowledgeBaseId === upload?.outputSummary?.knowledgeBaseId &&
      scope.outputSummary.knowledgeDocumentId === attach?.outputSummary?.knowledgeDocumentId &&
      ready?.outputSummary?.fixtureSha256 === upload?.outputSummary?.fixtureSha256 &&
      ready?.outputSummary?.contentHashMatched === true &&
      attach?.outputSummary?.knowledgeBaseId === upload?.outputSummary?.knowledgeBaseId,
    "KB-002 scope evidence is not linked to the run-created conversation, base and document",
  );
  check(
    deleteConversation?.outputSummary?.deleted === true &&
      cleanup?.outputSummary?.cleaned === true &&
      cleanup.outputSummary.knowledgeDocumentDeleteCount === 1 &&
      cleanup.outputSummary.rawDocumentDeleted === true &&
      cleanup.outputSummary.knowledgeBaseArchived === true,
    "KB-002 ordered conversation and knowledge-base cleanup evidence is incomplete",
  );
  check(
    Object.keys(scope.outputSummary).sort().join(",") ===
      [
        "contentHashMatched",
        "conversationId",
        "documentMatched",
        "firstCreated",
        "idempotentReplay",
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "retrievalPolicy",
        "scopeDocumentCount",
        "scopeHash",
        "scopeKnowledgeBaseCount",
        "scopeMatched",
        "scopeReadyDocumentCount",
        "scopeRevision",
        "scopeStable",
        "snapshotDocumentCount",
        "snapshotExcludedDocumentCount",
        "snapshotHash",
        "snapshotId",
        "snapshotIdentityMatched",
        "snapshotKnowledgeBaseCount",
        "snapshotReadyDocumentCount",
        "snapshotStatus",
      ]
        .sort()
        .join(","),
    "KB-002 evidence contains unregistered fields that could expose knowledge contents",
  );
  const evidence = JSON.stringify({ upload, attach, ready, conversation, scope, cleanup });
  check(
    !evidence.includes("source_filename") &&
      !evidence.includes("parser_document_id") &&
      !evidence.includes("parser_version_id") &&
      !evidence.includes("SPARK_X_KB_FIXTURE") &&
      !evidence.includes("B2C-KB-001") &&
      !evidence.includes("AMOUNT_CNY"),
    "KB-002 knowledge contents or internal parser identifiers leaked into structured evidence",
  );
}

async function executeKnowledgeSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-knowledge-base-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-knowledge-base-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent knowledge-base run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(
    run.gateResult === "passed",
    `Spark X Agent knowledge-base gate is ${String(run.gateResult)}`,
  );
  check(run.summary.passed === 2, "Spark X Agent knowledge-base cases did not all pass");
  check(run.firstFailure === null, "Spark X Agent knowledge-base retained a first failure");
  check(
    run.cases.length === 2 &&
      run.cases.every((item) => item.result === "passed" && item.cleanupStatus === "passed"),
    "Spark X Agent knowledge-base case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent knowledge-base structured step sequence is incomplete",
  );
  check(
    run.resources.length === 3 &&
      run.resources.filter(
        (resource) =>
          resource.resourceType === "spark-x-agent-knowledge-base" &&
          resource.cleanupStatus === "passed" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/knowledge-base.cleanup",
      ).length === 2 &&
      run.resources.filter(
        (resource) =>
          resource.resourceType === "spark-x-agent-conversation" &&
          resource.cleanupStatus === "passed" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete",
      ).length === 1,
    "Spark X Agent knowledge-base resource ledger or cleanup definition is incomplete",
  );
  check(run.cleanupJob === null, "normal knowledge-base run unexpectedly required compensation");
  assertKnowledgeEvidence(run);
  assertKnowledgeScopeEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into KB evidence",
    );
  }
  return run;
}

function assertKnowledgeRetrievalEvidence(run: RunDetail): void {
  const orderUpload = run.steps.find((step) => step.stepId === "upload-order-fixture");
  const orderAttach = run.steps.find((step) => step.stepId === "attach-order-fixture");
  const orderReady = run.steps.find((step) => step.stepId === "wait-order-ready");
  const chartUpload = run.steps.find((step) => step.stepId === "upload-chart-fixture");
  const chartAttach = run.steps.find((step) => step.stepId === "attach-chart-fixture");
  const chartReady = run.steps.find((step) => step.stepId === "wait-chart-ready");
  const conversation = run.steps.find((step) => step.stepId === "create-retrieval-conversation");
  const snapshot = run.steps.find((step) => step.stepId === "prepare-order-snapshot");
  const query = run.steps.find((step) => step.stepId === "query-order-and-assert-evidence");
  const deleteConversation = run.steps.find(
    (step) => step.stepId === "delete-retrieval-conversation",
  );
  const chartCleanup = run.steps.find((step) => step.stepId === "cleanup-chart-knowledge-base");
  const orderCleanup = run.steps.find((step) => step.stepId === "cleanup-order-knowledge-base");

  check(
    orderUpload !== undefined &&
      orderUpload.outputSummary !== null &&
      orderAttach !== undefined &&
      orderAttach.outputSummary !== null &&
      orderReady !== undefined &&
      orderReady.outputSummary !== null &&
      chartUpload !== undefined &&
      chartUpload.outputSummary !== null &&
      chartAttach !== undefined &&
      chartAttach.outputSummary !== null &&
      chartReady !== undefined &&
      chartReady.outputSummary !== null &&
      conversation !== undefined &&
      conversation.outputSummary !== null &&
      snapshot !== undefined &&
      snapshot.outputSummary !== null &&
      query !== undefined &&
      query.outputSummary !== null &&
      deleteConversation !== undefined &&
      deleteConversation.outputSummary !== null &&
      chartCleanup !== undefined &&
      chartCleanup.outputSummary !== null &&
      orderCleanup !== undefined &&
      orderCleanup.outputSummary !== null,
    "KB-003 step evidence is missing",
  );

  check(
    orderUpload.outputSummary.uploaded === true &&
      orderUpload.outputSummary.fixtureKind === "order" &&
      chartUpload.outputSummary.uploaded === true &&
      chartUpload.outputSummary.fixtureKind === "account-chart" &&
      typeof orderUpload.outputSummary.fixtureSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(orderUpload.outputSummary.fixtureSha256) &&
      typeof chartUpload.outputSummary.fixtureSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(chartUpload.outputSummary.fixtureSha256) &&
      orderUpload.outputSummary.fixtureSha256 !== chartUpload.outputSummary.fixtureSha256,
    "KB-003 order and account-chart fixtures are not distinct controlled uploads",
  );
  check(
    orderAttach.outputSummary.knowledgeBaseId === orderUpload.outputSummary.knowledgeBaseId &&
      orderReady.outputSummary.knowledgeDocumentId ===
        orderAttach.outputSummary.knowledgeDocumentId &&
      orderReady.outputSummary.fixtureSha256 === orderUpload.outputSummary.fixtureSha256 &&
      orderReady.outputSummary.ready === true &&
      chartAttach.outputSummary.knowledgeBaseId === chartUpload.outputSummary.knowledgeBaseId &&
      chartReady.outputSummary.knowledgeDocumentId ===
        chartAttach.outputSummary.knowledgeDocumentId &&
      chartReady.outputSummary.fixtureSha256 === chartUpload.outputSummary.fixtureSha256 &&
      chartReady.outputSummary.ready === true,
    "KB-003 parsed document evidence is not linked to both controlled uploads",
  );
  check(
    snapshot.outputSummary.conversationId === conversation.outputSummary.conversationId &&
      snapshot.outputSummary.knowledgeBaseId === orderUpload.outputSummary.knowledgeBaseId &&
      snapshot.outputSummary.knowledgeDocumentId ===
        orderAttach.outputSummary.knowledgeDocumentId &&
      snapshot.outputSummary.scopeKnowledgeBaseCount === 1 &&
      snapshot.outputSummary.scopeDocumentCount === 1 &&
      snapshot.outputSummary.snapshotDocumentCount === 1 &&
      snapshot.outputSummary.snapshotExcludedDocumentCount === 0 &&
      snapshot.outputSummary.snapshotIdentityMatched === true &&
      snapshot.outputSummary.scopeStable === true,
    "KB-003 immutable snapshot is not restricted to the order document",
  );
  check(
    query.outputSummary.conversationId === conversation.outputSummary.conversationId &&
      query.outputSummary.knowledgeDocumentId === orderAttach.outputSummary.knowledgeDocumentId &&
      query.outputSummary.snapshotId === snapshot.outputSummary.snapshotId &&
      query.outputSummary.snapshotHash === snapshot.outputSummary.snapshotHash &&
      query.outputSummary.completed === true &&
      query.outputSummary.expectedFactsMatched === true &&
      query.outputSummary.resourceMarkerChecked === true &&
      query.outputSummary.resourceMarkerMatched === true &&
      query.outputSummary.citationSetMatched === true &&
      query.outputSummary.forbiddenEvidenceAbsent === true &&
      query.outputSummary.messageCount === 2 &&
      query.outputSummary.userMessageCount === 1 &&
      query.outputSummary.assistantMessageCount === 1 &&
      query.outputSummary.toolMessageCount === 0 &&
      typeof query.outputSummary.evidenceCount === "number" &&
      query.outputSummary.evidenceCount >= 1 &&
      query.outputSummary.evidenceCount <= 20 &&
      query.outputSummary.citedRefCount === query.outputSummary.evidenceCount &&
      ["keyword", "semantic", "hybrid"].includes(String(query.outputSummary.retrievalMode)) &&
      typeof query.outputSummary.answerLength === "number" &&
      query.outputSummary.answerLength > 0 &&
      typeof query.outputSummary.answerSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(query.outputSummary.answerSha256) &&
      typeof query.outputSummary.evidenceSetSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(query.outputSummary.evidenceSetSha256),
    "KB-003 answer, citation or structured evidence closure is incomplete",
  );
  check(
    Object.keys(query.outputSummary).sort().join(",") ===
      [
        "answerLength",
        "answerSha256",
        "assistantMessageCount",
        "citationSetMatched",
        "citedRefCount",
        "completed",
        "conversationId",
        "evidenceCount",
        "evidenceSetSha256",
        "expectedFactsMatched",
        "forbiddenEvidenceAbsent",
        "knowledgeDocumentId",
        "messageCount",
        "packetHash",
        "pollAttempts",
        "resourceMarkerChecked",
        "resourceMarkerMatched",
        "retrievalId",
        "retrievalMode",
        "snapshotHash",
        "snapshotId",
        "toolMessageCount",
        "turnId",
        "userMessageCount",
      ]
        .sort()
        .join(","),
    "KB-003 evidence contains unregistered fields that could expose answer or document contents",
  );
  check(
    deleteConversation.outputSummary.deleted === true &&
      chartCleanup.outputSummary.cleaned === true &&
      orderCleanup.outputSummary.cleaned === true &&
      chartCleanup.outputSummary.knowledgeDocumentDeleteCount === 1 &&
      orderCleanup.outputSummary.knowledgeDocumentDeleteCount === 1 &&
      chartCleanup.outputSummary.rawDocumentDeleted === true &&
      orderCleanup.outputSummary.rawDocumentDeleted === true &&
      chartCleanup.outputSummary.knowledgeBaseArchived === true &&
      orderCleanup.outputSummary.knowledgeBaseArchived === true,
    "KB-003 ordered conversation and two-knowledge-base cleanup is incomplete",
  );
  const evidence = JSON.stringify({
    orderUpload,
    orderAttach,
    orderReady,
    chartUpload,
    chartAttach,
    chartReady,
    conversation,
    snapshot,
    query,
    deleteConversation,
    chartCleanup,
    orderCleanup,
  });
  check(
    !evidence.includes("B2C-KB-001") &&
      !evidence.includes("SPARK-REGRESSION") &&
      !evidence.includes("AMOUNT_CNY") &&
      !evidence.includes("ACCOUNT_CHART") &&
      !evidence.includes("ACCOUNTS_RECEIVABLE") &&
      !evidence.includes("source_url") &&
      !evidence.includes("snippet"),
    "KB-003 answer, fixture contents or signed source data leaked into structured evidence",
  );
}

async function executeKnowledgeRetrievalSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-knowledge-retrieval-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-knowledge-retrieval-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent knowledge retrieval run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(
    run.gateResult === "passed",
    `Spark X Agent knowledge retrieval gate is ${String(run.gateResult)}`,
  );
  check(run.summary.passed === 1, "Spark X Agent KB-003 case did not pass");
  check(run.firstFailure === null, "Spark X Agent KB-003 retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent KB-003 case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        "main:adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent KB-003 structured step sequence is incomplete",
  );
  check(
    run.resources.length === 3 &&
      run.resources.filter(
        (resource) =>
          resource.resourceType === "spark-x-agent-knowledge-base" &&
          resource.cleanupStatus === "passed" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/knowledge-base.cleanup",
      ).length === 2 &&
      run.resources.filter(
        (resource) =>
          resource.resourceType === "spark-x-agent-conversation" &&
          resource.cleanupStatus === "passed" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete",
      ).length === 1,
    "Spark X Agent KB-003 resource ledger or cleanup definition is incomplete",
  );
  check(run.cleanupJob === null, "normal KB-003 run unexpectedly required compensation");
  assertKnowledgeRetrievalEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into KB-003 evidence",
    );
  }
  return run;
}

function assertKnowledgeIsolationEvidence(run: RunDetail): void {
  const primaryUpload = run.steps.find(
    (step) => step.stepId === "upload-primary-isolation-fixture",
  );
  const primaryAttach = run.steps.find(
    (step) => step.stepId === "attach-primary-isolation-fixture",
  );
  const primaryReady = run.steps.find((step) => step.stepId === "wait-primary-isolation-ready");
  const peerUpload = run.steps.find((step) => step.stepId === "upload-peer-isolation-fixture");
  const peerAttach = run.steps.find((step) => step.stepId === "attach-peer-isolation-fixture");
  const peerReady = run.steps.find((step) => step.stepId === "wait-peer-isolation-ready");
  const conversation = run.steps.find((step) => step.stepId === "create-isolation-conversation");
  const snapshot = run.steps.find((step) => step.stepId === "prepare-primary-isolation-snapshot");
  const query = run.steps.find((step) => step.stepId === "query-primary-and-assert-isolation");
  const deleteConversation = run.steps.find(
    (step) => step.stepId === "delete-isolation-conversation",
  );
  const peerCleanup = run.steps.find((step) => step.stepId === "cleanup-peer-isolation-base");
  const primaryCleanup = run.steps.find((step) => step.stepId === "cleanup-primary-isolation-base");

  check(
    primaryUpload !== undefined &&
      primaryUpload.outputSummary !== null &&
      primaryAttach !== undefined &&
      primaryAttach.outputSummary !== null &&
      primaryReady !== undefined &&
      primaryReady.outputSummary !== null &&
      peerUpload !== undefined &&
      peerUpload.outputSummary !== null &&
      peerAttach !== undefined &&
      peerAttach.outputSummary !== null &&
      peerReady !== undefined &&
      peerReady.outputSummary !== null &&
      conversation !== undefined &&
      conversation.outputSummary !== null &&
      snapshot !== undefined &&
      snapshot.outputSummary !== null &&
      query !== undefined &&
      query.outputSummary !== null &&
      deleteConversation !== undefined &&
      deleteConversation.outputSummary !== null &&
      peerCleanup !== undefined &&
      peerCleanup.outputSummary !== null &&
      primaryCleanup !== undefined &&
      primaryCleanup.outputSummary !== null,
    "KB-004 step evidence is missing",
  );
  check(
    primaryUpload.outputSummary.fixtureKind === "order" &&
      peerUpload.outputSummary.fixtureKind === "order" &&
      primaryUpload.outputSummary.uploaded === true &&
      peerUpload.outputSummary.uploaded === true &&
      typeof primaryUpload.outputSummary.fixtureSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(primaryUpload.outputSummary.fixtureSha256) &&
      typeof peerUpload.outputSummary.fixtureSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(peerUpload.outputSummary.fixtureSha256) &&
      primaryUpload.outputSummary.fixtureSha256 !== peerUpload.outputSummary.fixtureSha256 &&
      primaryUpload.outputSummary.knowledgeBaseId !== peerUpload.outputSummary.knowledgeBaseId &&
      primaryAttach.outputSummary.knowledgeDocumentId !==
        peerAttach.outputSummary.knowledgeDocumentId &&
      typeof primaryAttach.outputSummary.titleSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(primaryAttach.outputSummary.titleSha256) &&
      primaryAttach.outputSummary.titleSha256 === peerAttach.outputSummary.titleSha256,
    "KB-004 same-title order fixtures are not distinct by their run resource marker",
  );
  check(
    primaryReady.outputSummary.ready === true &&
      peerReady.outputSummary.ready === true &&
      primaryReady.outputSummary.fixtureSha256 === primaryUpload.outputSummary.fixtureSha256 &&
      peerReady.outputSummary.fixtureSha256 === peerUpload.outputSummary.fixtureSha256 &&
      primaryReady.outputSummary.knowledgeDocumentId ===
        primaryAttach.outputSummary.knowledgeDocumentId &&
      peerReady.outputSummary.knowledgeDocumentId === peerAttach.outputSummary.knowledgeDocumentId,
    "KB-004 parsed evidence is not linked to both same-title order fixtures",
  );
  check(
    snapshot.outputSummary.conversationId === conversation.outputSummary.conversationId &&
      snapshot.outputSummary.knowledgeBaseId === primaryUpload.outputSummary.knowledgeBaseId &&
      snapshot.outputSummary.knowledgeDocumentId ===
        primaryAttach.outputSummary.knowledgeDocumentId &&
      snapshot.outputSummary.scopeKnowledgeBaseCount === 1 &&
      snapshot.outputSummary.scopeDocumentCount === 1 &&
      snapshot.outputSummary.snapshotDocumentCount === 1 &&
      snapshot.outputSummary.snapshotExcludedDocumentCount === 0 &&
      snapshot.outputSummary.snapshotIdentityMatched === true &&
      snapshot.outputSummary.scopeStable === true,
    "KB-004 immutable snapshot is not restricted to the primary knowledge base",
  );
  check(
    query.outputSummary.conversationId === conversation.outputSummary.conversationId &&
      query.outputSummary.knowledgeDocumentId === primaryAttach.outputSummary.knowledgeDocumentId &&
      query.outputSummary.snapshotId === snapshot.outputSummary.snapshotId &&
      query.outputSummary.snapshotHash === snapshot.outputSummary.snapshotHash &&
      query.outputSummary.completed === true &&
      query.outputSummary.expectedFactsMatched === true &&
      query.outputSummary.resourceMarkerChecked === true &&
      query.outputSummary.resourceMarkerMatched === true &&
      query.outputSummary.citationSetMatched === true &&
      query.outputSummary.forbiddenEvidenceAbsent === true &&
      query.outputSummary.messageCount === 2 &&
      query.outputSummary.userMessageCount === 1 &&
      query.outputSummary.assistantMessageCount === 1 &&
      query.outputSummary.toolMessageCount === 0 &&
      typeof query.outputSummary.evidenceCount === "number" &&
      query.outputSummary.evidenceCount >= 1 &&
      query.outputSummary.evidenceCount <= 20 &&
      query.outputSummary.citedRefCount === query.outputSummary.evidenceCount &&
      ["keyword", "semantic", "hybrid"].includes(String(query.outputSummary.retrievalMode)) &&
      typeof query.outputSummary.answerLength === "number" &&
      query.outputSummary.answerLength > 0 &&
      typeof query.outputSummary.answerSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(query.outputSummary.answerSha256) &&
      typeof query.outputSummary.evidenceSetSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(query.outputSummary.evidenceSetSha256),
    "KB-004 answer, resource marker, citation or evidence isolation is incomplete",
  );
  check(
    Object.keys(query.outputSummary).sort().join(",") ===
      [
        "answerLength",
        "answerSha256",
        "assistantMessageCount",
        "citationSetMatched",
        "citedRefCount",
        "completed",
        "conversationId",
        "evidenceCount",
        "evidenceSetSha256",
        "expectedFactsMatched",
        "forbiddenEvidenceAbsent",
        "knowledgeDocumentId",
        "messageCount",
        "packetHash",
        "pollAttempts",
        "resourceMarkerChecked",
        "resourceMarkerMatched",
        "retrievalId",
        "retrievalMode",
        "snapshotHash",
        "snapshotId",
        "toolMessageCount",
        "turnId",
        "userMessageCount",
      ]
        .sort()
        .join(","),
    "KB-004 evidence contains unregistered fields that could expose answer or document contents",
  );
  check(
    deleteConversation.outputSummary.deleted === true &&
      peerCleanup.outputSummary.cleaned === true &&
      primaryCleanup.outputSummary.cleaned === true &&
      peerCleanup.outputSummary.knowledgeDocumentDeleteCount === 1 &&
      primaryCleanup.outputSummary.knowledgeDocumentDeleteCount === 1 &&
      peerCleanup.outputSummary.rawDocumentDeleted === true &&
      primaryCleanup.outputSummary.rawDocumentDeleted === true &&
      peerCleanup.outputSummary.knowledgeBaseArchived === true &&
      primaryCleanup.outputSummary.knowledgeBaseArchived === true,
    "KB-004 ordered conversation and two-knowledge-base cleanup is incomplete",
  );
  const evidence = JSON.stringify({
    primaryUpload,
    primaryAttach,
    primaryReady,
    peerUpload,
    peerAttach,
    peerReady,
    conversation,
    snapshot,
    query,
    deleteConversation,
    peerCleanup,
    primaryCleanup,
  });
  check(
    !evidence.includes("B2C-KB-001") &&
      !evidence.includes("SPARK-REGRESSION") &&
      !evidence.includes("RUN_RESOURCE_ID") &&
      !evidence.includes("source_url") &&
      !evidence.includes("snippet"),
    "KB-004 answer, fixture contents or signed source data leaked into structured evidence",
  );
}

async function executeKnowledgeIsolationSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-knowledge-isolation-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-knowledge-isolation-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent KB-004 run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(run.gateResult === "passed", `Spark X Agent KB-004 gate is ${String(run.gateResult)}`);
  check(run.summary.passed === 1, "Spark X Agent KB-004 case did not pass");
  check(run.firstFailure === null, "Spark X Agent KB-004 retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent KB-004 case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "main:adapter:spark-x-agent/knowledge-base.create",
        "main:adapter:spark-x-agent/knowledge-base.upload-fixture",
        "main:adapter:spark-x-agent/knowledge-base.attach-upload",
        "main:adapter:spark-x-agent/knowledge-base.wait-ready",
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        "main:adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
        "finally:adapter:spark-x-agent/conversation.delete",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
        "finally:adapter:spark-x-agent/knowledge-base.cleanup",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent KB-004 structured step sequence is incomplete",
  );
  check(
    run.resources.length === 3 &&
      run.resources.filter(
        (resource) =>
          resource.resourceType === "spark-x-agent-knowledge-base" &&
          resource.cleanupStatus === "passed" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/knowledge-base.cleanup",
      ).length === 2 &&
      run.resources.filter(
        (resource) =>
          resource.resourceType === "spark-x-agent-conversation" &&
          resource.cleanupStatus === "passed" &&
          resource.cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete",
      ).length === 1,
    "Spark X Agent KB-004 resource ledger or cleanup definition is incomplete",
  );
  check(run.cleanupJob === null, "normal KB-004 run unexpectedly required compensation");
  assertKnowledgeIsolationEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into KB-004 evidence",
    );
  }
  return run;
}

async function executeSkillSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-skills-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-skills-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent Skill run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(run.gateResult === "passed", `Spark X Agent Skill gate is ${String(run.gateResult)}`);
  check(run.summary.passed === 1, "Spark X Agent Skill case did not pass");
  check(run.firstFailure === null, "Spark X Agent Skill run retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "not_required",
    "Spark X Agent Skill case failed",
  );
  check(
    run.steps.length === 1 &&
      run.steps[0]?.phase === "main" &&
      run.steps[0].action === "adapter:spark-x-agent/skill.assert-trusted-publication" &&
      run.steps[0].status === "passed",
    "Spark X Agent Skill structured step sequence is incomplete",
  );
  check(run.resources.length === 0, "read-only Skill assertion unexpectedly registered a resource");
  check(run.cleanupJob === null, "read-only Skill assertion unexpectedly required compensation");
  assertSkillEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into Skill evidence",
    );
  }
  return run;
}

async function executeMcpSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-mcp-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-mcp-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent MCP run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  if (expectMcpUnavailable) {
    check(run.gateResult === "inconclusive", "stopped MCP fixture did not make gate inconclusive");
    check(run.summary.environment_failed === 1, "stopped MCP fixture was not environment_failed");
    check(
      run.firstFailure?.code === "SPARK_X_AGENT_SAFE_TOOL_CATALOG_UNAVAILABLE",
      "stopped MCP fixture did not preserve its stable environment root cause",
    );
    check(
      run.cases.length === 1 &&
        run.cases[0]?.result === "environment_failed" &&
        run.cases[0].cleanupStatus === "not_required",
      "stopped MCP fixture case result or cleanup status is incorrect",
    );
    check(
      run.steps.length === 1 &&
        run.steps[0]?.stepId === "assert-mcp-connector" &&
        run.steps[0].phase === "main" &&
        run.steps[0].action === "adapter:spark-x-agent/tool.assert-safe-catalog" &&
        run.steps[0].status === "failed",
      "stopped MCP fixture structured failure evidence is incomplete",
    );
  } else {
    check(run.gateResult === "passed", `Spark X Agent MCP gate is ${String(run.gateResult)}`);
    check(run.summary.passed === 1, "Spark X Agent MCP case did not pass");
    check(run.firstFailure === null, "Spark X Agent MCP run retained an unexpected failure");
    check(
      run.cases.length === 1 &&
        run.cases[0]?.result === "passed" &&
        run.cases[0].cleanupStatus === "not_required",
      "Spark X Agent MCP case failed",
    );
    check(
      run.steps.length === 1 &&
        run.steps[0]?.stepId === "assert-mcp-connector" &&
        run.steps[0].phase === "main" &&
        run.steps[0].action === "adapter:spark-x-agent/tool.assert-safe-catalog" &&
        run.steps[0].status === "passed",
      "Spark X Agent MCP structured step sequence is incomplete",
    );
    assertMcpEvidence(run);
  }
  check(run.resources.length === 0, "read-only MCP assertion unexpectedly registered a resource");
  check(run.cleanupJob === null, "read-only MCP assertion unexpectedly required compensation");
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into MCP evidence",
    );
  }
  return run;
}

function assertAutomationEvidence(run: RunDetail): void {
  const create = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/automation.create",
  );
  const fired = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/automation.wait-fired",
  );
  const cleanup = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/automation.cleanup",
  );
  check(
    create?.outputSummary?.created === true &&
      create.outputSummary.enabled === true &&
      create.outputSummary.intervalSeconds === 300 &&
      create.outputSummary.selectedSkillAbsent === true &&
      typeof create.outputSummary.automationId === "string" &&
      typeof create.outputSummary.goalSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(create.outputSummary.goalSha256) &&
      typeof create.outputSummary.nameSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(create.outputSummary.nameSha256),
    "AUTO-001 immediate automation creation evidence is incomplete",
  );
  check(
    fired?.outputSummary?.automationId === create.outputSummary.automationId &&
      fired.outputSummary.fired === true &&
      fired.outputSummary.singleFireObserved === true &&
      fired.outputSummary.enabled === true &&
      fired.outputSummary.scheduleAdvancedBySeconds === 300 &&
      fired.outputSummary.userMessageCount === 1 &&
      fired.outputSummary.assistantMessageCount === 1 &&
      fired.outputSummary.toolMessageCount === 0 &&
      fired.outputSummary.toolCallCount === 0 &&
      fired.outputSummary.toolTraceEventCount === 0 &&
      fired.outputSummary.selectedSkillAbsent === true &&
      fired.outputSummary.expectedAssistantTextMatched === true &&
      fired.outputSummary.userContentSha256 === create.outputSummary.goalSha256 &&
      typeof fired.outputSummary.assistantContentSha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(fired.outputSummary.assistantContentSha256) &&
      fired.outputSummary.assistantFinishReason === "stop",
    "AUTO-001 scheduler, single-turn or no-tool evidence is incomplete",
  );
  check(
    cleanup?.phase === "finally" &&
      cleanup.outputSummary?.automationId === create.outputSummary.automationId &&
      cleanup.outputSummary.cleaned === true &&
      typeof cleanup.outputSummary.deleted === "boolean" &&
      typeof cleanup.outputSummary.conflictCount === "number",
    "AUTO-001 version-aware cleanup evidence is incomplete",
  );
  const evidence = JSON.stringify({ create, fired, cleanup });
  check(
    !evidence.includes("自动任务回归标识") &&
      !evidence.includes("请只回复") &&
      !evidence.includes("memory-only-access-token"),
    "AUTO-001 goal, answer or in-memory token leaked into structured evidence",
  );
}

async function executeAutomationSmoke(
  systemId: string,
  environmentId: string,
  suiteId: string,
  password: string | undefined,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-automations-p0-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-automations-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent automation run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(run.gateResult === "passed", `Spark X Agent automation gate is ${String(run.gateResult)}`);
  check(run.summary.passed === 1, "Spark X Agent automation case did not pass");
  check(run.firstFailure === null, "Spark X Agent automation run retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
    "Spark X Agent automation case or finally cleanup failed",
  );
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/automation.create",
        "main:adapter:spark-x-agent/automation.wait-fired",
        "finally:adapter:spark-x-agent/automation.cleanup",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent automation structured step sequence is incomplete",
  );
  check(
    run.resources.length === 2 &&
      run.resources[0]?.resourceType === "spark-x-agent-conversation" &&
      run.resources[0].cleanupDefinition.action === "adapter:spark-x-agent/conversation.delete" &&
      run.resources[1]?.resourceType === "spark-x-agent-automation" &&
      run.resources[1].cleanupDefinition.action === "adapter:spark-x-agent/automation.cleanup" &&
      run.resources.every((resource) => resource.cleanupStatus === "passed"),
    "Spark X Agent automation resource ledger or cleanup order is incomplete",
  );
  check(run.cleanupJob === null, "normal automation run unexpectedly required compensation");
  assertAutomationEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into AUTO evidence",
    );
  }
  return run;
}

const password = useExistingSecrets ? undefined : await readPassword();
const system = await ensureSystem();
const modules = await ensureModules(system.id);
const recentConversations = modules.get("recent-conversations");
check(recentConversations !== undefined, "recent-conversations module was not provisioned");
const chat = modules.get("chat");
check(chat !== undefined, "chat module was not provisioned");
const tools = modules.get("tools");
check(tools !== undefined, "tools module was not provisioned");
const knowledgeBase = modules.get("knowledge-base");
check(knowledgeBase !== undefined, "knowledge-base module was not provisioned");
const skills = modules.get("skills");
check(skills !== undefined, "skills module was not provisioned");
const mcp = modules.get("mcp");
check(mcp !== undefined, "mcp module was not provisioned");
const automations = modules.get("automations");
check(automations !== undefined, "automations module was not provisioned");
const environment = await ensureEnvironment(system.id);
if (password !== undefined) await upsertSecrets(system.id, environment.id, password);
const conversation = await ensureCase(
  system.id,
  recentConversations.id,
  environment.id,
  "CONV-001 最近会话创建、排序与清理",
  conversationDefinition(),
  "同步星火 Agent 会话 P0 适配器定义",
);
const conversationReopenCase = await ensureCase(
  system.id,
  recentConversations.id,
  environment.id,
  "CONV-002 从最近列表重新打开并继续会话",
  conversationReopenDefinition(),
  "新增最近列表重新定位、两轮上下文续接、空扩展范围和完整清理 P0 闭环",
);
const conversationPaginationCase = await ensureCase(
  system.id,
  recentConversations.id,
  environment.id,
  "CONV-003 会话重命名与分页稳定性",
  conversationPaginationDefinition(),
  "新增三个运行隔离会话、手工重命名、每页两条双重扫描和逆序清理 P1 闭环",
);
const conversationDeleteCase = await ensureCase(
  system.id,
  recentConversations.id,
  environment.id,
  "CONV-004 会话删除与重复记录防护",
  conversationDeleteDefinition(),
  "新增活动列表唯一性、软删除状态投影、重复删除和 finally 幂等清理 P1 闭环",
);
const chatCase = await ensureCase(
  system.id,
  chat.id,
  environment.id,
  "CHAT-001 流式对话、历史持久化与清理",
  chatDefinition(),
  "新增星火 Agent 真实流式对话与历史证据闭环",
);
const chatContextCase = await ensureCase(
  system.id,
  chat.id,
  environment.id,
  "CHAT-002 同一会话上下文续接与跨会话隔离",
  chatContextDefinition(),
  "新增两轮上下文续接、跨会话隔离、流式哈希和四消息历史 P0 闭环",
);
const chatCancelCase = await ensureCase(
  system.id,
  chat.id,
  environment.id,
  "CHAT-003 用户停止生成与同会话续接",
  chatCancelDefinition(),
  "新增 active Turn 取消、零幽灵助手消息、同会话独立续接和完整清理 P1 闭环",
);
const toolCatalogCase = await ensureCase(
  system.id,
  tools.id,
  environment.id,
  "TOOL-001 内置只读工具目录与凭据边界",
  toolCatalogDefinition(),
  "新增内置只读工具目录与凭据边界 P0 回归",
);
const toolInvocationCase = await ensureCase(
  system.id,
  tools.id,
  environment.id,
  "TOOL-002 安全工具调用、结果回填与历史证据",
  toolInvocationDefinition(),
  "新增安全工具调用、结果回填和历史公开轨迹证据闭环",
);
const toolResultCase = await ensureCase(
  system.id,
  tools.id,
  environment.id,
  "TOOL-003 工具结果进入最终回答",
  toolResultDefinition(),
  "新增 echo 单次调用、精确结果映射、最终回答和公开轨迹哈希关联 P0 闭环",
);
const toolFailureRecoveryCase = await ensureCase(
  system.id,
  tools.id,
  environment.id,
  "TOOL-004 工具失败、恢复与后续循环",
  toolFailureRecoveryDefinition(),
  "新增 calculator 真实除零失败、echo 后续恢复、双段流式/历史哈希关联和完整清理 P1 闭环",
);
const forbiddenToolCase = await ensureCase(
  system.id,
  tools.id,
  environment.id,
  "TOOL-005 禁止的工具与写操作",
  forbiddenToolDefinition(),
  "新增工具目录精确白名单、无写入、无复核、无高风险工具和零副作用 P0 边界校验",
);
const knowledgeBaseCase = await ensureCase(
  system.id,
  knowledgeBase.id,
  environment.id,
  "KB-001 固定 PDF 入库、解析证据与完整清理",
  knowledgeBaseDefinition(),
  "新增固定 PDF 上传、知识解析版本证据和统一清理 P0 闭环",
);
const knowledgeScopeCase = await ensureCase(
  system.id,
  knowledgeBase.id,
  environment.id,
  "KB-002 会话知识库范围、固定版本快照与幂等重放",
  knowledgeScopeDefinition(),
  "新增会话 required 知识范围、不可变文档版本快照、幂等重放和有序清理 P0 闭环",
);
const knowledgeRetrievalCase = await ensureCase(
  system.id,
  knowledgeBase.id,
  environment.id,
  "KB-003 B2C订单文件准确检索",
  knowledgeRetrievalDefinition(),
  "新增订单/科目表固定夹具隔离、不可变快照真实问答、引用回执与结构化证据闭环",
);
const knowledgeIsolationCase = await ensureCase(
  system.id,
  knowledgeBase.id,
  environment.id,
  "KB-004 多知识库数据隔离",
  knowledgeIsolationDefinition(),
  "新增同名同事实订单文件跨知识库隔离、绑定资源标识正反向校验和完整清理闭环",
);
const skillPublicationCase = await ensureCase(
  system.id,
  skills.id,
  environment.id,
  "SKILL-001 受信任 Skill 发布清单与能力投影",
  skillPublicationDefinition(),
  "新增受信任 Skill 用户/管理员投影、有效能力、主资产和精确哈希 P0 校验",
);
const mcpConnectorCase = await ensureCase(
  system.id,
  mcp.id,
  environment.id,
  "MCP-001 内置连接器注册、连接与工具发现",
  mcpConnectorDefinition(),
  "新增内置连接器用户投影、运行前置条件、工具发现、只读风险策略和凭据边界 P0 校验",
);
const automationCase = await ensureCase(
  system.id,
  automations.id,
  environment.id,
  "AUTO-001 新建任务、立即触发、单次结果与完整清理",
  automationDefinition(),
  "新增自动任务定义、立即单次调度、无工具结果关联和版本化清理 P0 闭环",
);
const automationTimezoneCase = await ensureCase(
  system.id,
  automations.id,
  environment.id,
  "AUTO-002 Asia/Shanghai 首次触发与下次计划",
  automationTimezoneDefinition(),
  "新增五秒延迟真实调度、上海时区首次触发误差、UTC/本地五分钟推进和完整清理 P0 闭环",
);
const automationLifecycleCase = await ensureCase(
  system.id,
  automations.id,
  environment.id,
  "AUTO-003 修改、停用、删除与无触发残留",
  automationLifecycleDefinition(),
  "新增延迟任务修改、停用、重新启用、删除、列表无残留、零调度消息和 finally 幂等清理 P1 闭环",
);
const automationIdempotencyCase = await ensureCase(
  system.id,
  automations.id,
  environment.id,
  "AUTO-004 调度幂等与重复投递防护",
  automationIdempotencyDefinition(),
  "新增单次真实调度后固定三次游标、版本、消息基数与回复哈希静默观察 P1 闭环",
);
const conversationSuite = await ensureSuite(
  system.id,
  "spark-x-agent-conversation-p0",
  "星火 Agent 会话 P0 纵向切片",
  "CONV-001 真实会话创建、最近排序、资源登记与清理闭环。",
  [conversation.testCase.id],
);
const conversationReopenSuite = await ensureSuite(
  system.id,
  "spark-x-agent-conversation-reopen-p0",
  "星火 Agent 会话重新打开 P0 纵向切片",
  "CONV-002 首轮后从最近列表重新定位同一会话、续接第二轮、核对空扩展范围并完整清理。",
  [conversationReopenCase.testCase.id],
);
const conversationPaginationSuite = await ensureSuite(
  system.id,
  "spark-x-agent-conversation-pagination-p1",
  "星火 Agent 会话重命名与分页 P1 纵向切片",
  "CONV-003 三个运行隔离会话、手工重命名、每页两条连续双重扫描和逆序清理闭环。",
  [conversationPaginationCase.testCase.id],
);
const conversationDeleteSuite = await ensureSuite(
  system.id,
  "spark-x-agent-conversation-delete-p1",
  "星火 Agent 会话删除与幂等 P1 纵向切片",
  "CONV-004 活动列表唯一性、软删除状态投影、重复删除和 finally 幂等清理闭环。",
  [conversationDeleteCase.testCase.id],
);
const recentConversationSuite = await ensureSuite(
  system.id,
  "spark-x-agent-recent-conversations",
  "星火 Agent 最近会话回归",
  "最近会话模块 CONV-001/002/003/004 创建排序、重新打开续接、重命名分页、删除幂等和完整清理。",
  [
    conversation.testCase.id,
    conversationReopenCase.testCase.id,
    conversationPaginationCase.testCase.id,
    conversationDeleteCase.testCase.id,
  ],
);
const chatContextSuite = await ensureSuite(
  system.id,
  "spark-x-agent-chat-context-p0",
  "星火 Agent 两轮上下文 P0 纵向切片",
  "CHAT-002 独立干扰会话、同会话两轮续接、流式哈希、四消息历史和完整清理闭环。",
  [chatContextCase.testCase.id],
);
const chatCancelSuite = await ensureSuite(
  system.id,
  "spark-x-agent-chat-cancel-p1",
  "星火 Agent 用户停止生成 P1 纵向切片",
  "CHAT-003 active Turn 取消、无外部副作用边界、零幽灵助手消息、同会话独立续接和完整清理闭环。",
  [chatCancelCase.testCase.id],
);
const chatSuite = await ensureSuite(
  system.id,
  "spark-x-agent-chat",
  "星火 Agent 聊天回归",
  "聊天模块当前 CHAT-001/002/003 流式首轮、两轮上下文隔离、用户取消和同会话续接。",
  [chatCase.testCase.id, chatContextCase.testCase.id, chatCancelCase.testCase.id],
);
const toolSuite = await ensureSuite(
  system.id,
  "spark-x-agent-tools-p0",
  "星火 Agent 工具 P0 纵向切片",
  "TOOL-001/002/003/005 内置只读目录、参数绑定、结果进入最终回答、禁止写工具边界、历史证据与清理闭环。",
  [
    toolCatalogCase.testCase.id,
    toolInvocationCase.testCase.id,
    toolResultCase.testCase.id,
    forbiddenToolCase.testCase.id,
  ],
);
const toolFailureRecoverySuite = await ensureSuite(
  system.id,
  "spark-x-agent-tool-failure-recovery-p1",
  "星火 Agent 工具失败恢复 P1 纵向切片",
  "TOOL-004 真实 calculator 除零失败、后续 echo 恢复、两段消息与公开轨迹哈希关联和完整清理闭环。",
  [toolFailureRecoveryCase.testCase.id],
);
const toolModuleSuite = await ensureSuite(
  system.id,
  "spark-x-agent-tools",
  "星火 Agent 工具回归",
  "工具模块 TOOL-001/002/003/004/005 目录、参数、结果映射、失败恢复、禁止写工具边界、证据关联和完整清理。",
  [
    toolCatalogCase.testCase.id,
    toolInvocationCase.testCase.id,
    toolResultCase.testCase.id,
    toolFailureRecoveryCase.testCase.id,
    forbiddenToolCase.testCase.id,
  ],
);
const knowledgeBaseSuite = await ensureSuite(
  system.id,
  "spark-x-agent-knowledge-base-p0",
  "星火 Agent 知识库 P0 纵向切片",
  "KB-001/002 固定 PDF 上传、解析版本、会话知识范围、不可变快照幂等重放、资源登记和完整清理闭环。",
  [knowledgeBaseCase.testCase.id, knowledgeScopeCase.testCase.id],
);
const knowledgeRetrievalSuite = await ensureSuite(
  system.id,
  "spark-x-agent-knowledge-retrieval-p0",
  "星火 Agent 知识检索 P0 纵向切片",
  "KB-003 订单与科目表双知识库隔离、订单不可变快照真实问答、引用证据关联和逆序完整清理。",
  [knowledgeRetrievalCase.testCase.id],
);
const knowledgeIsolationSuite = await ensureSuite(
  system.id,
  "spark-x-agent-knowledge-isolation-p0",
  "星火 Agent 多知识库隔离 P0 纵向切片",
  "KB-004 同名同事实订单文件只命中已绑定知识库，回答、引用和领域证据均排除未绑定资源标识。",
  [knowledgeIsolationCase.testCase.id],
);
const knowledgeModuleSuite = await ensureSuite(
  system.id,
  "spark-x-agent-knowledge-base",
  "星火 Agent 知识库回归",
  "知识库模块 KB-001/002/003/004 固定夹具解析、不可变范围、真实准确检索、跨知识库隔离和完整清理。",
  [
    knowledgeBaseCase.testCase.id,
    knowledgeScopeCase.testCase.id,
    knowledgeRetrievalCase.testCase.id,
    knowledgeIsolationCase.testCase.id,
  ],
);
const skillSuite = await ensureSuite(
  system.id,
  "spark-x-agent-skills-p0",
  "星火 Agent Skill P0 纵向切片",
  "SKILL-001 受信任 Skill 发布清单、有效能力、主资产和精确内容哈希只读证据闭环。",
  [skillPublicationCase.testCase.id],
);
const mcpSuite = await ensureSuite(
  system.id,
  "spark-x-agent-mcp-p0",
  "星火 Agent MCP P0 纵向切片",
  "MCP-001 内置连接器注册、运行状态、工具发现、只读风险策略和凭据边界证据闭环。",
  [mcpConnectorCase.testCase.id],
);
const automationSuite = await ensureSuite(
  system.id,
  "spark-x-agent-automations-p0",
  "星火 Agent 自动任务 P0 纵向切片",
  "AUTO-001 立即触发、单次会话结果、无工具证据、资源登记和版本化清理闭环。",
  [automationCase.testCase.id],
);
const automationTimezoneSuite = await ensureSuite(
  system.id,
  "spark-x-agent-automation-timezone-p0",
  "星火 Agent 自动任务时区 P0 纵向切片",
  "AUTO-002 五秒延迟真实调度、Asia/Shanghai 首次触发误差、UTC/本地五分钟下一次计划和完整清理。",
  [automationTimezoneCase.testCase.id],
);
const automationIdempotencySuite = await ensureSuite(
  system.id,
  "spark-x-agent-automation-idempotency-p1",
  "星火 Agent 自动任务幂等 P1 纵向切片",
  "AUTO-004 单次真实调度后固定三次状态版本、触发游标、唯一消息对和回复哈希静默观察。",
  [automationIdempotencyCase.testCase.id],
);
const automationModuleSuite = await ensureSuite(
  system.id,
  "spark-x-agent-automations",
  "星火 Agent 自动任务回归",
  "自动任务模块 AUTO-001/002/003/004 单次调度、上海时区计划、生命周期、重复投递防护和完整清理。",
  [
    automationCase.testCase.id,
    automationTimezoneCase.testCase.id,
    automationLifecycleCase.testCase.id,
    automationIdempotencyCase.testCase.id,
  ],
);
const suite = await ensureSuite(
  system.id,
  "spark-x-agent-core-smoke",
  "星火 Agent 核心冒烟",
  "发布后核心冒烟套件；当前包含 CONV-001/002、CHAT-001/002、TOOL-001/002、KB-001/002、SKILL-001、MCP-001 与 AUTO-001，共 11 条 P0 覆盖七个核心模块。",
  [
    conversation.testCase.id,
    conversationReopenCase.testCase.id,
    chatCase.testCase.id,
    chatContextCase.testCase.id,
    toolCatalogCase.testCase.id,
    toolInvocationCase.testCase.id,
    knowledgeBaseCase.testCase.id,
    knowledgeScopeCase.testCase.id,
    skillPublicationCase.testCase.id,
    mcpConnectorCase.testCase.id,
    automationCase.testCase.id,
  ],
);
const fullRegressionSuite = await ensureSuite(
  system.id,
  "spark-x-agent-full-regression",
  "星火 Agent 完整回归（建设中 22/32）",
  "手动一键完整回归入口；当前已接入 22/32 条案例，覆盖七个模块的当前 P0、CHAT-003、TOOL-004、AUTO-003/004 与 CONV-003/004 P1，后续持续追加且不改变套件 key。",
  [
    conversation.testCase.id,
    conversationReopenCase.testCase.id,
    conversationPaginationCase.testCase.id,
    conversationDeleteCase.testCase.id,
    chatCase.testCase.id,
    chatContextCase.testCase.id,
    chatCancelCase.testCase.id,
    toolCatalogCase.testCase.id,
    toolInvocationCase.testCase.id,
    toolResultCase.testCase.id,
    toolFailureRecoveryCase.testCase.id,
    forbiddenToolCase.testCase.id,
    knowledgeBaseCase.testCase.id,
    knowledgeScopeCase.testCase.id,
    knowledgeRetrievalCase.testCase.id,
    knowledgeIsolationCase.testCase.id,
    skillPublicationCase.testCase.id,
    mcpConnectorCase.testCase.id,
    automationCase.testCase.id,
    automationTimezoneCase.testCase.id,
    automationLifecycleCase.testCase.id,
    automationIdempotencyCase.testCase.id,
  ],
);
check(
  [
    runSmoke,
    runContextSmoke,
    runCancelSmoke,
    runConversationReopenSmoke,
    runConversationPaginationSmoke,
    runConversationDeleteSmoke,
    runKnowledgeSmoke,
    runKnowledgeRetrievalSmoke,
    runKnowledgeIsolationSmoke,
    runSkillSmoke,
    runMcpSmoke,
    runAutomationSmoke,
  ].filter(Boolean).length <= 1,
  "only one Spark X Agent smoke mode can be true",
);
const run = runSmoke
  ? await executeSmoke(system.id, environment.id, suite.id, password)
  : runContextSmoke
    ? await executeContextSmoke(system.id, environment.id, chatContextSuite.id, password)
    : runCancelSmoke
      ? await executeCancelSmoke(system.id, environment.id, chatCancelSuite.id, password)
      : runConversationReopenSmoke
        ? await executeConversationReopenSmoke(
            system.id,
            environment.id,
            conversationReopenSuite.id,
            password,
          )
        : runConversationPaginationSmoke
          ? await executeConversationPaginationSmoke(
              system.id,
              environment.id,
              conversationPaginationSuite.id,
              password,
            )
          : runConversationDeleteSmoke
            ? await executeConversationDeleteSmoke(
                system.id,
                environment.id,
                conversationDeleteSuite.id,
                password,
              )
            : runKnowledgeSmoke
              ? await executeKnowledgeSmoke(
                  system.id,
                  environment.id,
                  knowledgeBaseSuite.id,
                  password,
                )
              : runKnowledgeRetrievalSmoke
                ? await executeKnowledgeRetrievalSmoke(
                    system.id,
                    environment.id,
                    knowledgeRetrievalSuite.id,
                    password,
                  )
                : runKnowledgeIsolationSmoke
                  ? await executeKnowledgeIsolationSmoke(
                      system.id,
                      environment.id,
                      knowledgeIsolationSuite.id,
                      password,
                    )
                  : runSkillSmoke
                    ? await executeSkillSmoke(system.id, environment.id, skillSuite.id, password)
                    : runMcpSmoke
                      ? await executeMcpSmoke(system.id, environment.id, mcpSuite.id, password)
                      : runAutomationSmoke
                        ? await executeAutomationSmoke(
                            system.id,
                            environment.id,
                            automationSuite.id,
                            password,
                          )
                        : undefined;
const scenario = runContextSmoke
  ? "spark-x-agent-chat-context-p0"
  : runCancelSmoke
    ? "spark-x-agent-chat-cancel-p1"
    : runConversationReopenSmoke
      ? "spark-x-agent-conversation-reopen-p0"
      : runConversationPaginationSmoke
        ? "spark-x-agent-conversation-pagination-p1"
        : runConversationDeleteSmoke
          ? "spark-x-agent-conversation-delete-p1"
          : runKnowledgeSmoke
            ? "spark-x-agent-knowledge-base-p0"
            : runKnowledgeRetrievalSmoke
              ? "spark-x-agent-knowledge-retrieval-p0"
              : runKnowledgeIsolationSmoke
                ? "spark-x-agent-knowledge-isolation-p0"
                : runSkillSmoke
                  ? "spark-x-agent-skills-p0"
                  : runMcpSmoke
                    ? "spark-x-agent-mcp-p0"
                    : runAutomationSmoke
                      ? "spark-x-agent-automations-p0"
                      : "spark-x-agent-core-smoke";

console.info(
  JSON.stringify({
    status: run === undefined ? "provisioned" : run.gateResult,
    scenario,
    assertions:
      run === undefined
        ? 0
        : runContextSmoke
          ? 28
          : runCancelSmoke
            ? 30
            : runConversationReopenSmoke
              ? 23
              : runConversationPaginationSmoke
                ? 24
                : runConversationDeleteSmoke
                  ? 24
                  : runKnowledgeSmoke
                    ? 32
                    : runKnowledgeRetrievalSmoke
                      ? 35
                      : runKnowledgeIsolationSmoke
                        ? 36
                        : runSkillSmoke
                          ? 12
                          : runMcpSmoke
                            ? expectMcpUnavailable
                              ? 10
                              : 12
                            : runAutomationSmoke
                              ? 20
                              : 161,
    caseCount: 22,
    coreSmokeCaseCount: 11,
    targetCaseCount: "10-12",
    secretsUpdated: password !== undefined,
    systemId: system.id,
    environmentId: environment.id,
    conversationCaseId: conversation.testCase.id,
    conversationCaseVersionId: conversation.version.id,
    conversationReopenCaseId: conversationReopenCase.testCase.id,
    conversationReopenCaseVersionId: conversationReopenCase.version.id,
    conversationPaginationCaseId: conversationPaginationCase.testCase.id,
    conversationPaginationCaseVersionId: conversationPaginationCase.version.id,
    conversationDeleteCaseId: conversationDeleteCase.testCase.id,
    conversationDeleteCaseVersionId: conversationDeleteCase.version.id,
    chatCaseId: chatCase.testCase.id,
    chatCaseVersionId: chatCase.version.id,
    chatContextCaseId: chatContextCase.testCase.id,
    chatContextCaseVersionId: chatContextCase.version.id,
    chatCancelCaseId: chatCancelCase.testCase.id,
    chatCancelCaseVersionId: chatCancelCase.version.id,
    toolCatalogCaseId: toolCatalogCase.testCase.id,
    toolCatalogCaseVersionId: toolCatalogCase.version.id,
    toolInvocationCaseId: toolInvocationCase.testCase.id,
    toolInvocationCaseVersionId: toolInvocationCase.version.id,
    toolResultCaseId: toolResultCase.testCase.id,
    toolResultCaseVersionId: toolResultCase.version.id,
    toolFailureRecoveryCaseId: toolFailureRecoveryCase.testCase.id,
    toolFailureRecoveryCaseVersionId: toolFailureRecoveryCase.version.id,
    forbiddenToolCaseId: forbiddenToolCase.testCase.id,
    forbiddenToolCaseVersionId: forbiddenToolCase.version.id,
    knowledgeBaseCaseId: knowledgeBaseCase.testCase.id,
    knowledgeBaseCaseVersionId: knowledgeBaseCase.version.id,
    knowledgeScopeCaseId: knowledgeScopeCase.testCase.id,
    knowledgeScopeCaseVersionId: knowledgeScopeCase.version.id,
    knowledgeRetrievalCaseId: knowledgeRetrievalCase.testCase.id,
    knowledgeRetrievalCaseVersionId: knowledgeRetrievalCase.version.id,
    knowledgeIsolationCaseId: knowledgeIsolationCase.testCase.id,
    knowledgeIsolationCaseVersionId: knowledgeIsolationCase.version.id,
    skillPublicationCaseId: skillPublicationCase.testCase.id,
    skillPublicationCaseVersionId: skillPublicationCase.version.id,
    mcpConnectorCaseId: mcpConnectorCase.testCase.id,
    mcpConnectorCaseVersionId: mcpConnectorCase.version.id,
    automationCaseId: automationCase.testCase.id,
    automationCaseVersionId: automationCase.version.id,
    automationTimezoneCaseId: automationTimezoneCase.testCase.id,
    automationTimezoneCaseVersionId: automationTimezoneCase.version.id,
    automationLifecycleCaseId: automationLifecycleCase.testCase.id,
    automationLifecycleCaseVersionId: automationLifecycleCase.version.id,
    automationIdempotencyCaseId: automationIdempotencyCase.testCase.id,
    automationIdempotencyCaseVersionId: automationIdempotencyCase.version.id,
    conversationSuiteId: conversationSuite.id,
    conversationReopenSuiteId: conversationReopenSuite.id,
    conversationPaginationSuiteId: conversationPaginationSuite.id,
    conversationDeleteSuiteId: conversationDeleteSuite.id,
    recentConversationSuiteId: recentConversationSuite.id,
    chatContextSuiteId: chatContextSuite.id,
    chatCancelSuiteId: chatCancelSuite.id,
    chatSuiteId: chatSuite.id,
    toolSuiteId: toolSuite.id,
    toolFailureRecoverySuiteId: toolFailureRecoverySuite.id,
    toolModuleSuiteId: toolModuleSuite.id,
    knowledgeBaseSuiteId: knowledgeBaseSuite.id,
    knowledgeRetrievalSuiteId: knowledgeRetrievalSuite.id,
    knowledgeIsolationSuiteId: knowledgeIsolationSuite.id,
    knowledgeModuleSuiteId: knowledgeModuleSuite.id,
    skillSuiteId: skillSuite.id,
    mcpSuiteId: mcpSuite.id,
    automationSuiteId: automationSuite.id,
    automationTimezoneSuiteId: automationTimezoneSuite.id,
    automationIdempotencySuiteId: automationIdempotencySuite.id,
    automationModuleSuiteId: automationModuleSuite.id,
    suiteId: suite.id,
    fullRegressionSuiteId: fullRegressionSuite.id,
    ...(run === undefined ? {} : { runId: run.id, gateResult: run.gateResult }),
  }),
);
