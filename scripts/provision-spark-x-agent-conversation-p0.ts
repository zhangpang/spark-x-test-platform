import { randomUUID } from "node:crypto";
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
const runKnowledgeSmoke = process.env.SPARK_X_AGENT_RUN_KNOWLEDGE_SMOKE === "true";
const runSkillSmoke = process.env.SPARK_X_AGENT_RUN_SKILL_SMOKE === "true";
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
  check(run.summary.passed === 6, "Spark X Agent core smoke cases did not all pass");
  check(run.firstFailure === null, "Spark X Agent core smoke retained an unexpected first failure");
  check(run.cases.length === 6, "Spark X Agent core smoke run case linkage is incomplete");
  check(
    run.cases.every((item) => item.result === "passed"),
    "Spark X Agent core smoke case failed",
  );
  check(
    run.cases.every((item) => item.cleanupStatus === "passed"),
    "Spark X Agent core smoke finally cleanup did not pass",
  );
  check(
    run.steps.length === 19,
    "Spark X Agent core smoke did not record fifteen main steps and four finally steps",
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
        "main:adapter:spark-x-agent/chat.assert-history",
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
        "main:adapter:spark-x-agent/skill.assert-trusted-publication",
      ].join(","),
    "Spark X Agent core smoke structured step sequence is incorrect",
  );
  check(run.resources.length === 4, "Spark X Agent core smoke resource ledger linkage is missing");
  check(
    run.resources.filter((resource) => resource.resourceType === "spark-x-agent-conversation")
      .length === 3 &&
      run.resources.filter((resource) => resource.resourceType === "spark-x-agent-knowledge-base")
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
  const chatAsk = run.steps.find((step) => step.action === "adapter:spark-x-agent/chat.ask");
  const chatHistory = run.steps.find(
    (step) => step.action === "adapter:spark-x-agent/chat.assert-history",
  );
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
  assertSkillEvidence(run);
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
  check(run.summary.passed === 1, "Spark X Agent knowledge-base case did not pass");
  check(run.firstFailure === null, "Spark X Agent knowledge-base retained a first failure");
  check(
    run.cases.length === 1 &&
      run.cases[0]?.result === "passed" &&
      run.cases[0].cleanupStatus === "passed",
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
      ].join(",") && run.steps.every((step) => step.status === "passed"),
    "Spark X Agent knowledge-base structured step sequence is incomplete",
  );
  check(
    run.resources.length === 1 &&
      run.resources[0]?.resourceType === "spark-x-agent-knowledge-base" &&
      run.resources[0].cleanupStatus === "passed" &&
      run.resources[0].cleanupDefinition.action === "adapter:spark-x-agent/knowledge-base.cleanup",
    "Spark X Agent knowledge-base resource ledger or cleanup definition is incomplete",
  );
  check(run.cleanupJob === null, "normal knowledge-base run unexpectedly required compensation");
  assertKnowledgeEvidence(run);
  if (password !== undefined) {
    check(
      !JSON.stringify(run).includes(password),
      "administrator password leaked into KB evidence",
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
      run.cases[0].cleanupStatus === "passed",
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
const chatCase = await ensureCase(
  system.id,
  chat.id,
  environment.id,
  "CHAT-001 流式对话、历史持久化与清理",
  chatDefinition(),
  "新增星火 Agent 真实流式对话与历史证据闭环",
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
const knowledgeBaseCase = await ensureCase(
  system.id,
  knowledgeBase.id,
  environment.id,
  "KB-001 固定 PDF 入库、解析证据与完整清理",
  knowledgeBaseDefinition(),
  "新增固定 PDF 上传、知识解析版本证据和统一清理 P0 闭环",
);
const skillPublicationCase = await ensureCase(
  system.id,
  skills.id,
  environment.id,
  "SKILL-001 受信任 Skill 发布清单与能力投影",
  skillPublicationDefinition(),
  "新增受信任 Skill 用户/管理员投影、有效能力、主资产和精确哈希 P0 校验",
);
const conversationSuite = await ensureSuite(
  system.id,
  "spark-x-agent-conversation-p0",
  "星火 Agent 会话 P0 纵向切片",
  "CONV-001 真实会话创建、最近排序、资源登记与清理闭环。",
  [conversation.testCase.id],
);
const toolSuite = await ensureSuite(
  system.id,
  "spark-x-agent-tools-p0",
  "星火 Agent 工具 P0 纵向切片",
  "TOOL-001/002 内置只读工具目录、调用、结果回填、历史证据与会话清理闭环。",
  [toolCatalogCase.testCase.id, toolInvocationCase.testCase.id],
);
const knowledgeBaseSuite = await ensureSuite(
  system.id,
  "spark-x-agent-knowledge-base-p0",
  "星火 Agent 知识库 P0 纵向切片",
  "KB-001 固定 PDF 上传、解析版本与内容哈希、资源登记和完整清理闭环。",
  [knowledgeBaseCase.testCase.id],
);
const skillSuite = await ensureSuite(
  system.id,
  "spark-x-agent-skills-p0",
  "星火 Agent Skill P0 纵向切片",
  "SKILL-001 受信任 Skill 发布清单、有效能力、主资产和精确内容哈希只读证据闭环。",
  [skillPublicationCase.testCase.id],
);
const suite = await ensureSuite(
  system.id,
  "spark-x-agent-core-smoke",
  "星火 Agent 核心冒烟",
  "发布后核心冒烟套件；当前包含 CONV-001、CHAT-001、TOOL-001/002、KB-001 与 SKILL-001，后续按模块扩充到 10～12 条 P0。",
  [
    conversation.testCase.id,
    chatCase.testCase.id,
    toolCatalogCase.testCase.id,
    toolInvocationCase.testCase.id,
    knowledgeBaseCase.testCase.id,
    skillPublicationCase.testCase.id,
  ],
);
check(
  [runSmoke, runKnowledgeSmoke, runSkillSmoke].filter(Boolean).length <= 1,
  "only one Spark X Agent smoke mode can be true",
);
const run = runSmoke
  ? await executeSmoke(system.id, environment.id, suite.id, password)
  : runKnowledgeSmoke
    ? await executeKnowledgeSmoke(system.id, environment.id, knowledgeBaseSuite.id, password)
    : runSkillSmoke
      ? await executeSkillSmoke(system.id, environment.id, skillSuite.id, password)
      : undefined;
const scenario = runKnowledgeSmoke
  ? "spark-x-agent-knowledge-base-p0"
  : runSkillSmoke
    ? "spark-x-agent-skills-p0"
    : "spark-x-agent-core-smoke";

console.info(
  JSON.stringify({
    status: run === undefined ? "provisioned" : "passed",
    scenario,
    assertions: run === undefined ? 0 : runKnowledgeSmoke ? 16 : runSkillSmoke ? 12 : 62,
    caseCount: 6,
    targetCaseCount: "10-12",
    secretsUpdated: password !== undefined,
    systemId: system.id,
    environmentId: environment.id,
    conversationCaseId: conversation.testCase.id,
    conversationCaseVersionId: conversation.version.id,
    chatCaseId: chatCase.testCase.id,
    chatCaseVersionId: chatCase.version.id,
    toolCatalogCaseId: toolCatalogCase.testCase.id,
    toolCatalogCaseVersionId: toolCatalogCase.version.id,
    toolInvocationCaseId: toolInvocationCase.testCase.id,
    toolInvocationCaseVersionId: toolInvocationCase.version.id,
    knowledgeBaseCaseId: knowledgeBaseCase.testCase.id,
    knowledgeBaseCaseVersionId: knowledgeBaseCase.version.id,
    skillPublicationCaseId: skillPublicationCase.testCase.id,
    skillPublicationCaseVersionId: skillPublicationCase.version.id,
    conversationSuiteId: conversationSuite.id,
    toolSuiteId: toolSuite.id,
    knowledgeBaseSuiteId: knowledgeBaseSuite.id,
    skillSuiteId: skillSuite.id,
    suiteId: suite.id,
    ...(run === undefined ? {} : { runId: run.id, gateResult: run.gateResult }),
  }),
);
