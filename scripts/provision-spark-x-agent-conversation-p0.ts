import { randomUUID } from "node:crypto";
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
const testedVersion = process.env.SPARK_X_AGENT_TESTED_VERSION?.trim() || "test-environment";
const adminUsername = process.env.SPARK_X_AGENT_ADMIN_USERNAME?.trim() || "admin";
const passwordFile = process.env.SPARK_X_AGENT_ADMIN_PASSWORD_FILE?.trim();

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readPassword(): Promise<string> {
  const raw =
    passwordFile === undefined || passwordFile === ""
      ? await (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          return Buffer.concat(chunks).toString("utf8");
        })()
      : await readFile(passwordFile, "utf8");
  const password = raw.replace(/[\r\n]+$/u, "");
  check(password.length >= 12, "Spark X Agent administrator password is missing or invalid");
  return password;
}

async function api<T>(
  path: string,
  options: Readonly<{ method?: string; body?: unknown; idempotencyKey?: string }> = {},
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
        pathPrefixes: ["/trade/"],
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

async function ensureCase(
  systemId: string,
  moduleId: string,
  environmentId: string,
): Promise<Readonly<{ testCase: CaseRecord; version: CaseVersionRecord }>> {
  const definition = conversationDefinition();
  const cases = (
    await api<{ readonly items: CaseRecord[] }>(`/test-cases?systemId=${systemId}`)
  ).body.items;
  let testCase = cases.find(
    (candidate) => candidate.name === "CONV-001 最近会话创建、排序与清理",
  );
  let version: CaseVersionRecord;
  if (testCase === undefined) {
    testCase = (
      await api<CaseRecord>("/test-cases", {
        method: "POST",
        body: {
          moduleId,
          definition,
          changeNote: "首条星火 Agent 真实 P0 会话回归闭环",
        },
      })
    ).body;
    check(testCase.currentDraftVersionId !== null, "new case does not have a draft version");
    const createdVersions = (
      await api<CaseVersionRecord[]>(`/test-cases/${testCase.id}/versions`)
    ).body;
    const createdVersion = createdVersions.find(
      (candidate) => candidate.id === testCase?.currentDraftVersionId,
    );
    check(createdVersion !== undefined, "new CONV-001 draft version was not found");
    version = createdVersion;
  } else {
    check(testCase.moduleId === moduleId, "CONV-001 is attached to an unexpected module");
    const versions = (await api<CaseVersionRecord[]>(`/test-cases/${testCase.id}/versions`)).body;
    const latest = versions[0];
    check(latest !== undefined, "existing CONV-001 does not have a version");
    if (canonical(latest.definition) === canonical(definition)) {
      version = latest;
    } else {
      version = (
        await api<CaseVersionRecord>(`/test-cases/${testCase.id}/versions`, {
          method: "POST",
          body: {
            definition,
            expectedBaseVersion: latest.version,
            changeNote: "同步星火 Agent 会话 P0 适配器定义",
          },
        })
      ).body;
    }
  }
  const validation = await api<{ readonly valid: boolean; readonly issues: readonly unknown[] }>(
    `/test-case-versions/${version.id}/validations`,
    { method: "POST", body: { environmentId } },
  );
  check(validation.body.valid, `CONV-001 validation failed: ${JSON.stringify(validation.body)}`);
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

async function ensureSuite(systemId: string, caseId: string): Promise<SuiteRecord> {
  const input = {
    systemId,
    key: "spark-x-agent-conversation-p0",
    name: "星火 Agent 会话 P0 纵向切片",
    description: "CONV-001 真实会话创建、最近排序、资源登记与清理闭环。",
    caseIds: [caseId],
    defaultConcurrency: 1,
    defaultDiagnosticRetries: 0,
  };
  const suites = (await api<{ readonly items: SuiteRecord[] }>("/test-suites")).body.items;
  const existing = suites.find(
    (suite) => suite.systemId === systemId && suite.key === input.key,
  );
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
  const deadline = Date.now() + 120_000;
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
  password: string,
): Promise<RunDetail> {
  const accepted = await api<RunDetail>("/runs", {
    method: "POST",
    idempotencyKey: `spark-x-agent-conv-001-${randomUUID()}`,
    body: {
      systemId,
      environmentId,
      suiteId,
      triggerType: "api",
      triggerSource: "spark-x-agent-conversation-p0-verification",
      priority: 95,
      testedVersion,
    },
  });
  check(accepted.status === 202, "Spark X Agent P0 run was not newly accepted");
  const run = await waitForRun(accepted.body.id);
  check(run.gateResult === "passed", `Spark X Agent P0 gate is ${String(run.gateResult)}`);
  check(run.summary.passed === 1, "Spark X Agent P0 case did not pass");
  check(run.firstFailure === null, "Spark X Agent P0 retained an unexpected first failure");
  check(run.cases.length === 1, "Spark X Agent P0 run case linkage is incomplete");
  check(run.cases[0]?.result === "passed", "Spark X Agent P0 run case did not pass");
  check(run.cases[0]?.cleanupStatus === "passed", "Spark X Agent P0 finally cleanup did not pass");
  check(run.steps.length === 3, "Spark X Agent P0 did not record two main steps and finally");
  check(run.steps.every((step) => step.status === "passed"), "Spark X Agent P0 step failed");
  check(
    run.steps.map((step) => `${step.phase}:${step.action}`).join(",") ===
      [
        "main:adapter:spark-x-agent/conversation.create",
        "main:adapter:spark-x-agent/conversation.assert-recent",
        "finally:adapter:spark-x-agent/conversation.delete",
      ].join(","),
    "Spark X Agent P0 structured step sequence is incorrect",
  );
  check(run.resources.length === 1, "Spark X Agent P0 resource ledger linkage is missing");
  check(
    run.resources[0]?.resourceType === "spark-x-agent-conversation",
    "Spark X Agent P0 resource type is incorrect",
  );
  check(run.resources[0]?.cleanupStatus === "passed", "Spark X Agent P0 resource is not cleaned");
  check(run.cleanupJob === null, "normal Spark X Agent P0 run unexpectedly required compensation");
  const evidence = JSON.stringify(run);
  check(!evidence.includes(password), "Spark X Agent administrator password leaked into evidence");
  return run;
}

const password = await readPassword();
const system = await ensureSystem();
const modules = await ensureModules(system.id);
const recentConversations = modules.get("recent-conversations");
check(recentConversations !== undefined, "recent-conversations module was not provisioned");
const environment = await ensureEnvironment(system.id);
await upsertSecrets(system.id, environment.id, password);
const { testCase, version } = await ensureCase(
  system.id,
  recentConversations.id,
  environment.id,
);
const suite = await ensureSuite(system.id, testCase.id);
const run = runSmoke
  ? await executeSmoke(system.id, environment.id, suite.id, password)
  : undefined;

console.info(
  JSON.stringify({
    status: run === undefined ? "provisioned" : "passed",
    scenario: "spark-x-agent-conversation-p0",
    assertions: run === undefined ? 0 : 17,
    systemId: system.id,
    environmentId: environment.id,
    caseId: testCase.id,
    caseVersionId: version.id,
    suiteId: suite.id,
    ...(run === undefined ? {} : { runId: run.id, gateResult: run.gateResult }),
  }),
);
