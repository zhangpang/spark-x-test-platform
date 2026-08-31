import { readFile } from "node:fs/promises";

interface IdentifiedRecord {
  readonly id: string;
}

interface SystemRecord extends IdentifiedRecord {
  readonly key: string;
}

interface EnvironmentRecord extends IdentifiedRecord {
  readonly key: string;
}

interface CaseRecord extends IdentifiedRecord {
  readonly name: string;
  readonly status: string;
  readonly currentPublishedVersionId: string | null;
}

interface CaseVersionRecord extends IdentifiedRecord {
  readonly version: number;
  readonly definition: Readonly<Record<string, unknown>>;
}

const apiBase = process.env.SPARK_X_TEST_PLATFORM_API_URL ?? "http://127.0.0.1:4100/api/v1";
const tenantId = process.env.SPARK_X_AGENT_TENANT_ID?.trim() || "0";
const automationTokenFile = process.env.SPARK_X_AGENT_AUTOMATION_TOKEN_FILE?.trim();

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function api<T>(
  path: string,
  options: Readonly<{ method?: string; body?: unknown }> = {},
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Platform API ${path} returned HTTP ${response.status}: ${text}`);
  }
  return (text === "" ? null : JSON.parse(text)) as T;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const governanceInputs = [
  {
    name: "tenant-id",
    type: "string",
    required: true,
    description: "ContiNew 外部租户 ID",
    secretRef: "spark-x-agent-tenant-id",
  },
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
  {
    name: "automation-token",
    type: "string",
    required: true,
    description: "测试环境受控自动化登录凭据",
    secretRef: "spark-x-agent-automation-token",
  },
] as const;

function migrateDefinition(
  definition: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const existingInputs = Array.isArray(definition.inputs) ? definition.inputs : [];
  const governanceNames = new Set<string>(governanceInputs.map((input) => input.name));
  return {
    ...definition,
    inputs: [
      ...governanceInputs,
      ...existingInputs.filter((input) => {
        const record = objectValue(input);
        return (
          record === null || typeof record.name !== "string" || !governanceNames.has(record.name)
        );
      }),
    ],
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = objectValue(value);
  if (object !== null) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const systems = await api<{ readonly items: SystemRecord[] }>("/systems");
const system = systems.items.find((candidate) => candidate.key === "spark-x-agent");
check(system !== undefined, "spark-x-agent system is missing");
const environments = await api<EnvironmentRecord[]>(`/systems/${system.id}/environments`);
const environment = environments.find((candidate) => candidate.key === "test");
check(environment !== undefined, "spark-x-agent test environment is missing");
check(/^[0-9]+$/u.test(tenantId), "Spark X Agent tenant ID must contain only digits");
check(
  automationTokenFile !== undefined && automationTokenFile !== "",
  "Spark X Agent automation token file is missing",
);
const automationToken = (await readFile(automationTokenFile, "utf8")).replace(/[\r\n]+$/u, "");
check(
  /^[0-9a-f]{64}$/u.test(automationToken),
  "Spark X Agent automation token must be 64 lowercase hex characters",
);
await api("/secrets", {
  method: "POST",
  body: {
    systemId: system.id,
    environmentId: environment.id,
    key: "spark-x-agent-tenant-id",
    value: tenantId,
  },
});
await api("/secrets", {
  method: "POST",
  body: {
    systemId: system.id,
    environmentId: environment.id,
    key: "spark-x-agent-automation-token",
    value: automationToken,
  },
});
const cases = await api<{ readonly items: CaseRecord[] }>(`/test-cases?systemId=${system.id}`);

let changed = 0;
let unchanged = 0;
for (const testCase of cases.items) {
  const versions = await api<CaseVersionRecord[]>(`/test-cases/${testCase.id}/versions`);
  const latest = versions[0];
  check(latest !== undefined, `${testCase.name} does not have a version`);
  const migrated = migrateDefinition(latest.definition);
  if (canonical(migrated) === canonical(latest.definition)) {
    unchanged += 1;
    continue;
  }
  const version = await api<CaseVersionRecord>(`/test-cases/${testCase.id}/versions`, {
    method: "POST",
    body: {
      definition: migrated,
      expectedBaseVersion: latest.version,
      changeNote: "适配治理登录租户、RSA 密码与受控自动化验证码",
    },
  });
  const validation = await api<{ readonly valid: boolean; readonly issues: readonly unknown[] }>(
    `/test-case-versions/${version.id}/validations`,
    { method: "POST", body: { environmentId: environment.id } },
  );
  check(
    validation.valid,
    `${testCase.name} governance login migration validation failed: ${JSON.stringify(validation.issues)}`,
  );
  await api(`/test-cases/${testCase.id}/publish`, {
    method: "POST",
    body: { versionId: version.id },
  });
  changed += 1;
}

console.info(
  JSON.stringify({
    status: "migrated",
    scenario: "spark-x-agent-governance-login",
    changed,
    unchanged,
    total: cases.items.length,
  }),
);
