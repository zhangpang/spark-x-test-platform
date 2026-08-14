import { createHash } from "node:crypto";

import { validateTestCaseDefinition } from "@spark-x-test/case-schema";

import type {
  ActionLevel,
  EnvironmentInput,
  EnvironmentRecord,
  JsonObject,
  JsonValue,
  ValidationIssue,
  ValidationResult,
} from "./model.js";

const referencePattern = /\$\{[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*\}/i;
const suspiciousKeyPattern =
  /^(?:authorization|cookie|password|passwd|passphrase|private[-_]?key|client[-_]?secret|api[-_]?key|access[-_]?key|secret|token)$/i;
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const bearerPattern = /\bbearer\s+[a-z0-9._~+/=-]{12,}/i;
const jwtPattern = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/;

const actionRank: Readonly<Record<ActionLevel, number>> = {
  read: 0,
  write: 1,
  dangerous: 2,
};
const availableActions = new Set([
  "http:request",
  "wait:http",
  "browser:navigate",
  "browser:click",
  "browser:fill",
  "browser:assert-text",
]);
const availableCompensationActions = new Set(["http:request"]);
const availableAssertions = new Set(["status:equals"]);
const waitJsonPathPattern = /^\$(?:\.[a-zA-Z0-9_-]+){0,20}$/;
const waitOperators = new Set(["equals", "not-equals", "contains", "exists"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function jsonEntries(value: JsonObject): readonly (readonly [string, JsonValue])[] {
  return Object.entries(value);
}

function isReference(value: string): boolean {
  return referencePattern.test(value) || /^secretRef:[a-z][a-z0-9_.-]*$/i.test(value);
}

function canonicalize(value: JsonValue): string {
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function joinPath(parent: string, child: string | number): string {
  return typeof child === "number" ? `${parent}[${child}]` : `${parent}.${child}`;
}

export function findPlaintextSecrets(value: JsonValue, path: string = "$"): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (isJsonArray(value)) {
    value.forEach((item, index) =>
      issues.push(...findPlaintextSecrets(item, joinPath(path, index))),
    );
    return issues;
  }
  if (!isObject(value)) {
    if (
      typeof value === "string" &&
      !isReference(value) &&
      (privateKeyPattern.test(value) || bearerPattern.test(value) || jwtPattern.test(value))
    ) {
      issues.push({
        severity: "error",
        code: "PLAINTEXT_SECRET",
        path,
        message: "检测到疑似明文密钥；请改用 secretRef 或受控变量引用。",
      });
    }
    return issues;
  }

  for (const [key, child] of jsonEntries(value)) {
    const childPath = joinPath(path, key);
    if (
      suspiciousKeyPattern.test(key) &&
      key.toLowerCase() !== "secretref" &&
      typeof child === "string" &&
      child.trim() !== "" &&
      !isReference(child)
    ) {
      issues.push({
        severity: "error",
        code: "PLAINTEXT_SECRET",
        path: childPath,
        message: `字段 ${key} 不允许保存明文；请改用 secretRef。`,
      });
    } else {
      issues.push(...findPlaintextSecrets(child, childPath));
    }
  }
  return issues;
}

export function redactSecrets(value: JsonValue): JsonValue {
  if (isJsonArray(value)) return value.map((item) => redactSecrets(item));
  if (!isObject(value)) {
    if (
      typeof value === "string" &&
      (privateKeyPattern.test(value) || bearerPattern.test(value) || jwtPattern.test(value))
    ) {
      return "[REDACTED]";
    }
    return value;
  }
  return Object.fromEntries(
    jsonEntries(value).map(([key, child]) => [
      key,
      suspiciousKeyPattern.test(key) && key.toLowerCase() !== "secretref"
        ? "[REDACTED]"
        : redactSecrets(child),
    ]),
  );
}

export function collectSecretReferences(value: JsonValue): readonly string[] {
  const references = new Set<string>();
  const visit = (current: JsonValue): void => {
    if (isJsonArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isObject(current)) return;
    for (const [key, child] of jsonEntries(current)) {
      if (key.toLowerCase() === "secretref" && typeof child === "string") {
        references.add(child);
      }
      if (typeof child === "string") {
        const directReference = /^secretRef:([a-z][a-z0-9_.-]*)$/i.exec(child);
        if (directReference?.[1] !== undefined) references.add(directReference[1]);
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return [...references].sort();
}

function collectSteps(definition: JsonObject): readonly JsonObject[] {
  const collected: JsonObject[] = [];
  const visit = (steps: JsonValue | undefined): void => {
    if (!isJsonArray(steps)) return;
    for (const step of steps) {
      if (!isObject(step)) continue;
      collected.push(step);
      visit(step.then);
      visit(step.else);
      visit(step.steps);
    }
  };
  visit(definition.steps);
  visit(definition.finally);
  return collected;
}

function collectTemplateReferences(value: JsonValue): readonly string[] {
  const references = new Set<string>();
  const visit = (candidate: JsonValue): void => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/\$\{([^}]+)\}/g)) {
        if (match[1] !== undefined) references.add(match[1]);
      }
      return;
    }
    if (isJsonArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (isObject(candidate)) Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...references];
}

function validateStepSemantics(definition: JsonObject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stepIds = new Set<string>();
  for (const step of collectSteps(definition)) {
    const id = typeof step.id === "string" ? step.id : "";
    if (id !== "") {
      if (stepIds.has(id)) {
        issues.push({
          severity: "error",
          code: "DUPLICATE_STEP_ID",
          path: "$.steps",
          message: `步骤 ID ${id} 重复。`,
        });
      }
      stepIds.add(id);
    }

    if (step.kind !== "action" || typeof step.action !== "string" || !isObject(step.params)) {
      continue;
    }
    const params = step.params;
    if (!availableActions.has(step.action)) {
      issues.push({
        severity: "error",
        code: "ACTION_NOT_AVAILABLE",
        path: `$.steps.${id}.action`,
        message: `当前平台版本未注册动作 ${step.action}。`,
      });
    }
    if (isJsonArray(step.assertions)) {
      for (const [assertionIndex, assertion] of step.assertions.entries()) {
        if (
          isObject(assertion) &&
          typeof assertion.type === "string" &&
          !availableAssertions.has(assertion.type)
        ) {
          issues.push({
            severity: "error",
            code: "ASSERTION_NOT_AVAILABLE",
            path: `$.steps.${id}.assertions[${assertionIndex}].type`,
            message: `当前平台版本未注册断言 ${assertion.type}。`,
          });
        }
      }
    }
    if (step.action === "http:request") {
      const method = step.params.method;
      const path = step.params.path;
      if (
        typeof method !== "string" ||
        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method.toUpperCase())
      ) {
        issues.push({
          severity: "error",
          code: "HTTP_METHOD_INVALID",
          path: `$.steps.${id}.params.method`,
          message: "HTTP 请求必须使用受支持的方法。",
        });
      }
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        issues.push({
          severity: "error",
          code: "HTTP_PATH_INVALID",
          path: `$.steps.${id}.params.path`,
          message: "HTTP 请求只能填写以 / 开头的相对路径，目标主机由环境提供。",
        });
      }
      if ("url" in step.params || "baseUrl" in step.params || "host" in step.params) {
        issues.push({
          severity: "error",
          code: "ARBITRARY_TARGET_FORBIDDEN",
          path: `$.steps.${id}.params`,
          message: "用例不得直接指定 URL、baseUrl 或 host；目标必须来自已登记环境。",
        });
      }
      const metadata = isObject(definition.metadata) ? definition.metadata : undefined;
      if (typeof method === "string" && typeof metadata?.actionLevel === "string") {
        const requiredLevel: ActionLevel =
          method.toUpperCase() === "DELETE"
            ? "dangerous"
            : ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
              ? "read"
              : "write";
        if (
          metadata.actionLevel in actionRank &&
          actionRank[metadata.actionLevel as ActionLevel] < actionRank[requiredLevel]
        ) {
          issues.push({
            severity: "error",
            code: "ACTION_LEVEL_UNDERSPECIFIED",
            path: "$.metadata.actionLevel",
            message: `${method.toUpperCase()} 至少需要 ${requiredLevel} 动作等级。`,
          });
        }
      }
    }
    if (step.action === "wait:http") {
      const path = step.params.path;
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        issues.push({
          severity: "error",
          code: "WAIT_HTTP_PATH_INVALID",
          path: `$.steps.${id}.params.path`,
          message: "HTTP 轮询只能填写以 / 开头的相对路径，目标主机由环境提供。",
        });
      }
      if (
        ["url", "baseUrl", "host", "method", "body", "script", "code"].some(
          (name) => name in params,
        )
      ) {
        issues.push({
          severity: "error",
          code: "ARBITRARY_WAIT_INPUT_FORBIDDEN",
          path: `$.steps.${id}.params`,
          message: "HTTP 轮询仅允许 GET 相对路径与声明式条件，不得指定目标主机、请求体或脚本。",
        });
      }
      if (
        step.params.intervalMs !== undefined &&
        (!Number.isInteger(step.params.intervalMs) ||
          (step.params.intervalMs as number) < 100 ||
          (step.params.intervalMs as number) > 30_000)
      ) {
        issues.push({
          severity: "error",
          code: "WAIT_INTERVAL_INVALID",
          path: `$.steps.${id}.params.intervalMs`,
          message: "HTTP 轮询间隔必须是 100 到 30000 毫秒之间的整数。",
        });
      }
      if (
        step.params.headers !== undefined &&
        (!isObject(step.params.headers) ||
          Object.values(step.params.headers).some((value) => typeof value !== "string"))
      ) {
        issues.push({
          severity: "error",
          code: "WAIT_HEADERS_INVALID",
          path: `$.steps.${id}.params.headers`,
          message: "HTTP 轮询请求头必须是字符串键值对。",
        });
      }
      const condition = isObject(step.params.condition) ? step.params.condition : undefined;
      if (
        condition === undefined ||
        typeof condition.path !== "string" ||
        !waitJsonPathPattern.test(condition.path) ||
        typeof condition.operator !== "string" ||
        !waitOperators.has(condition.operator)
      ) {
        issues.push({
          severity: "error",
          code: "WAIT_CONDITION_INVALID",
          path: `$.steps.${id}.params.condition`,
          message: "HTTP 轮询条件必须使用受限 JSON 路径和已注册比较符。",
        });
      } else if (condition.operator !== "exists" && !("expected" in condition)) {
        issues.push({
          severity: "error",
          code: "WAIT_EXPECTED_VALUE_REQUIRED",
          path: `$.steps.${id}.params.condition.expected`,
          message: `HTTP 轮询条件 ${condition.operator} 必须声明 expected。`,
        });
      }
    }
    if (step.action.startsWith("browser:")) {
      if (
        ["url", "baseUrl", "host", "script", "javascript", "evaluate", "code"].some(
          (name) => name in params,
        )
      ) {
        issues.push({
          severity: "error",
          code: "ARBITRARY_BROWSER_INPUT_FORBIDDEN",
          path: `$.steps.${id}.params`,
          message: "浏览器步骤不得指定目标主机或任意脚本，只允许已注册的声明式参数。",
        });
      }
      if (step.action === "browser:navigate") {
        const path = step.params.path;
        if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
          issues.push({
            severity: "error",
            code: "BROWSER_PATH_INVALID",
            path: `$.steps.${id}.params.path`,
            message: "浏览器导航只能填写以 / 开头的相对路径，目标主机由环境提供。",
          });
        }
      } else if (typeof step.params.selector !== "string" || step.params.selector.length === 0) {
        issues.push({
          severity: "error",
          code: "BROWSER_SELECTOR_INVALID",
          path: `$.steps.${id}.params.selector`,
          message: "浏览器交互步骤必须提供非空 selector。",
        });
      }
      if (
        step.action === "browser:fill" &&
        (typeof step.params.value !== "string" || step.params.value.length === 0)
      ) {
        issues.push({
          severity: "error",
          code: "BROWSER_VALUE_INVALID",
          path: `$.steps.${id}.params.value`,
          message: "浏览器填写步骤必须提供 value。",
        });
      }
      if (
        step.action === "browser:assert-text" &&
        (typeof step.params.text !== "string" || step.params.text.length === 0)
      ) {
        issues.push({
          severity: "error",
          code: "BROWSER_TEXT_INVALID",
          path: `$.steps.${id}.params.text`,
          message: "浏览器文本断言必须提供 text。",
        });
      }
      const metadata = isObject(definition.metadata) ? definition.metadata : undefined;
      if (
        ["browser:click", "browser:fill"].includes(step.action) &&
        metadata?.actionLevel === "read"
      ) {
        issues.push({
          severity: "error",
          code: "ACTION_LEVEL_UNDERSPECIFIED",
          path: "$.metadata.actionLevel",
          message: `${step.action} 至少需要 write 动作等级。`,
        });
      }
    }

    const resource = isObject(step.resource) ? step.resource : undefined;
    const cleanup =
      resource !== undefined && isObject(resource.cleanup) ? resource.cleanup : undefined;
    if (cleanup !== undefined) {
      if (typeof cleanup.action !== "string" || !availableCompensationActions.has(cleanup.action)) {
        const cleanupAction = typeof cleanup.action === "string" ? cleanup.action : "无效动作";
        issues.push({
          severity: "error",
          code: "CLEANUP_ACTION_NOT_AVAILABLE",
          path: `$.steps.${id}.resource.cleanup.action`,
          message: `当前平台版本未注册资源补偿动作 ${cleanupAction}。`,
        });
      }
      const declaredSecrets = new Set(
        isJsonArray(definition.inputs)
          ? definition.inputs.flatMap((input) =>
              isObject(input) &&
              typeof input.name === "string" &&
              typeof input.secretRef === "string"
                ? [`case.${input.name}`]
                : [],
            )
          : [],
      );
      for (const reference of collectTemplateReferences(cleanup)) {
        if (reference !== "resource.id" && !declaredSecrets.has(reference)) {
          issues.push({
            severity: "error",
            code: "CLEANUP_REFERENCE_FORBIDDEN",
            path: `$.steps.${id}.resource.cleanup`,
            message: `资源补偿只能引用 resource.id 或已声明的密钥输入，不能引用 ${reference}。`,
          });
        }
      }
      if (cleanup.action === "http:request" && isObject(cleanup.params)) {
        const method = cleanup.params.method;
        const path = cleanup.params.path;
        if (
          typeof method !== "string" ||
          !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
            method.toUpperCase(),
          )
        ) {
          issues.push({
            severity: "error",
            code: "HTTP_METHOD_INVALID",
            path: `$.steps.${id}.resource.cleanup.params.method`,
            message: "HTTP 补偿请求必须使用受支持的方法。",
          });
        }
        if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
          issues.push({
            severity: "error",
            code: "HTTP_PATH_INVALID",
            path: `$.steps.${id}.resource.cleanup.params.path`,
            message: "HTTP 补偿请求只能填写以 / 开头的相对路径。",
          });
        }
        if ("url" in cleanup.params || "baseUrl" in cleanup.params || "host" in cleanup.params) {
          issues.push({
            severity: "error",
            code: "ARBITRARY_TARGET_FORBIDDEN",
            path: `$.steps.${id}.resource.cleanup.params`,
            message: "资源补偿不得直接指定 URL、baseUrl 或 host。",
          });
        }
        const metadata = isObject(definition.metadata) ? definition.metadata : undefined;
        if (typeof method === "string" && typeof metadata?.actionLevel === "string") {
          const requiredLevel: ActionLevel =
            method.toUpperCase() === "DELETE"
              ? "dangerous"
              : ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
                ? "read"
                : "write";
          if (
            metadata.actionLevel in actionRank &&
            actionRank[metadata.actionLevel as ActionLevel] < actionRank[requiredLevel]
          ) {
            issues.push({
              severity: "error",
              code: "ACTION_LEVEL_UNDERSPECIFIED",
              path: "$.metadata.actionLevel",
              message: `资源补偿 ${method.toUpperCase()} 至少需要 ${requiredLevel} 动作等级。`,
            });
          }
        }
      }
    }
  }
  return issues;
}

function validateTimeoutBudget(definition: JsonObject): ValidationIssue[] {
  if (!isObject(definition.execution)) return [];
  const stepTimeout = definition.execution.stepTimeoutMs;
  const caseTimeout = definition.execution.caseTimeoutMs;
  if (typeof stepTimeout !== "number" || typeof caseTimeout !== "number") return [];
  const mainSteps = isJsonArray(definition.steps) ? definition.steps : [];
  const theoretical = mainSteps.reduce<number>((total, step) => {
    if (!isObject(step)) return total;
    return total + (typeof step.timeoutMs === "number" ? step.timeoutMs : stepTimeout);
  }, 0);
  return caseTimeout < theoretical
    ? [
        {
          severity: "error" as const,
          code: "CASE_TIMEOUT_TOO_SMALL",
          path: "$.execution.caseTimeoutMs",
          message: `用例总超时 ${caseTimeout}ms 小于主步骤理论上限 ${theoretical}ms。`,
        },
      ]
    : [];
}

function validateEnvironmentTarget(environment: EnvironmentRecord): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let target: URL;
  try {
    target = new URL(environment.baseUrl);
  } catch {
    return [
      {
        severity: "error",
        code: "ENVIRONMENT_BASE_URL_INVALID",
        path: "$.environment.baseUrl",
        message: "环境 baseUrl 不是有效 URL。",
      },
    ];
  }
  const port = Number.parseInt(
    target.port ||
      (target.protocol === "https:" ? "443" : target.protocol === "http:" ? "80" : "0"),
    10,
  );
  const matchingRule = environment.allowlist.find(
    (rule) =>
      `${rule.protocol}:` === target.protocol &&
      rule.host.toLowerCase() === target.hostname.toLowerCase() &&
      rule.ports.includes(port) &&
      (rule.pathPrefixes === undefined ||
        rule.pathPrefixes.length === 0 ||
        rule.pathPrefixes.some((prefix) => target.pathname.startsWith(prefix))),
  );
  if (matchingRule === undefined) {
    issues.push({
      severity: "error",
      code: "ENVIRONMENT_TARGET_NOT_ALLOWLISTED",
      path: "$.environment.allowlist",
      message: "环境 baseUrl 不在自己的目标白名单内。",
    });
  }
  return issues;
}

function validateStepTargets(
  definition: JsonObject,
  environment: EnvironmentRecord,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const step of collectSteps(definition)) {
    const action = typeof step.action === "string" ? step.action : "";
    if (
      !["http:request", "browser:navigate", "wait:http"].includes(action) ||
      !isObject(step.params) ||
      typeof step.params.path !== "string"
    ) {
      continue;
    }
    let target: URL;
    try {
      target = new URL(step.params.path, environment.baseUrl);
    } catch {
      continue;
    }
    const port = Number.parseInt(
      target.port ||
        (target.protocol === "https:" ? "443" : target.protocol === "http:" ? "80" : "0"),
      10,
    );
    const allowed = environment.allowlist.some(
      (rule) =>
        `${rule.protocol}:` === target.protocol &&
        rule.host.toLowerCase() === target.hostname.toLowerCase() &&
        rule.ports.includes(port) &&
        (rule.pathPrefixes === undefined ||
          rule.pathPrefixes.length === 0 ||
          rule.pathPrefixes.some((prefix) => target.pathname.startsWith(prefix))),
    );
    if (!allowed) {
      issues.push({
        severity: "error",
        code:
          action === "browser:navigate"
            ? "BROWSER_TARGET_NOT_ALLOWLISTED"
            : "HTTP_TARGET_NOT_ALLOWLISTED",
        path: `$.steps.${typeof step.id === "string" ? step.id : "unknown"}.params.path`,
        message: `${action === "browser:navigate" ? "浏览器" : action === "wait:http" ? "HTTP 轮询" : "HTTP"} 路径 ${step.params.path} 不在环境目标白名单内。`,
      });
    }
    const resource = isObject(step.resource) ? step.resource : undefined;
    const cleanup =
      resource !== undefined && isObject(resource.cleanup) ? resource.cleanup : undefined;
    if (
      cleanup?.action === "http:request" &&
      isObject(cleanup.params) &&
      typeof cleanup.params.path === "string"
    ) {
      let cleanupTarget: URL;
      try {
        cleanupTarget = new URL(cleanup.params.path, environment.baseUrl);
      } catch {
        continue;
      }
      const cleanupPort = Number.parseInt(
        cleanupTarget.port ||
          (cleanupTarget.protocol === "https:"
            ? "443"
            : cleanupTarget.protocol === "http:"
              ? "80"
              : "0"),
        10,
      );
      const cleanupAllowed = environment.allowlist.some(
        (rule) =>
          `${rule.protocol}:` === cleanupTarget.protocol &&
          rule.host.toLowerCase() === cleanupTarget.hostname.toLowerCase() &&
          rule.ports.includes(cleanupPort) &&
          (rule.pathPrefixes === undefined ||
            rule.pathPrefixes.length === 0 ||
            rule.pathPrefixes.some((prefix) => cleanupTarget.pathname.startsWith(prefix))),
      );
      if (!cleanupAllowed) {
        issues.push({
          severity: "error",
          code: "HTTP_TARGET_NOT_ALLOWLISTED",
          path: `$.steps.${typeof step.id === "string" ? step.id : "unknown"}.resource.cleanup.params.path`,
          message: `HTTP 补偿路径 ${cleanup.params.path} 不在环境目标白名单内。`,
        });
      }
    }
  }
  return issues;
}

export function validateEnvironmentInput(input: EnvironmentInput): ValidationResult {
  const asRecord: EnvironmentRecord = {
    ...input,
    id: "00000000-0000-4000-8000-000000000000",
    systemId: "00000000-0000-4000-8000-000000000000",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const issues = [
    ...validateEnvironmentTarget(asRecord),
    ...findPlaintextSecrets(input.adapterConfig ?? {}),
  ];
  if (input.kind === "production" && input.actionLevel !== "read") {
    issues.push({
      severity: "error",
      code: "PRODUCTION_MUST_BE_READ_ONLY",
      path: "$.actionLevel",
      message: "MVP 的生产环境仅允许 read 动作等级。",
    });
  }
  return { valid: issues.every((issue) => issue.severity !== "error"), issues };
}

export interface DefinitionValidationContext {
  readonly systemKey: string;
  readonly moduleKey: string;
  readonly environment?: EnvironmentRecord;
}

export function validateDefinition(
  definition: JsonObject,
  context: DefinitionValidationContext,
): ValidationResult {
  const schemaResult = validateTestCaseDefinition(definition);
  const issues: ValidationIssue[] = schemaResult.errors.map((error) => ({
    severity: "error",
    code: "SCHEMA_INVALID",
    path: error.instancePath === "" ? "$" : `$${error.instancePath.replaceAll("/", ".")}`,
    message: error.message ?? "用例定义不符合 Schema。",
  }));
  const metadata = isObject(definition.metadata) ? definition.metadata : undefined;
  if (definition.kind === "manual") {
    issues.push({
      severity: "error",
      code: "MANUAL_CASE_NOT_PUBLISHABLE",
      path: "$.kind",
      message: "MVP 不允许发布人工用例。",
    });
  }
  if (metadata?.systemKey !== context.systemKey) {
    issues.push({
      severity: "error",
      code: "SYSTEM_KEY_MISMATCH",
      path: "$.metadata.systemKey",
      message: `用例 systemKey 必须为 ${context.systemKey}。`,
    });
  }
  if (metadata?.moduleKey !== context.moduleKey) {
    issues.push({
      severity: "error",
      code: "MODULE_KEY_MISMATCH",
      path: "$.metadata.moduleKey",
      message: `用例 moduleKey 必须为 ${context.moduleKey}。`,
    });
  }
  issues.push(...findPlaintextSecrets(definition));
  issues.push(...validateStepSemantics(definition));
  issues.push(...validateTimeoutBudget(definition));

  if (isJsonArray(definition.resourceLocks)) {
    definition.resourceLocks.forEach((lock, index) => {
      if (typeof lock !== "string") return;
      for (const reference of collectTemplateReferences(lock)) {
        if (reference !== "run.id") {
          issues.push({
            severity: "error",
            code: "RESOURCE_LOCK_REFERENCE_FORBIDDEN",
            path: `$.resourceLocks[${index}]`,
            message: `资源锁只能引用 run.id，不能引用 ${reference}。`,
          });
        }
      }
    });
  }

  if (isJsonArray(definition.finally)) {
    definition.finally.forEach((step, index) => {
      if (isObject(step) && step.resource !== undefined) {
        issues.push({
          severity: "error",
          code: "FINALLY_RESOURCE_REGISTRATION_FORBIDDEN",
          path: `$.finally[${index}].resource`,
          message: "finally 清理阶段不得登记新的外部资源。",
        });
      }
    });
  }

  if (context.environment !== undefined) {
    issues.push(...validateEnvironmentTarget(context.environment));
    issues.push(...validateStepTargets(definition, context.environment));
    if (
      metadata !== undefined &&
      typeof metadata.actionLevel === "string" &&
      metadata.actionLevel in actionRank &&
      actionRank[metadata.actionLevel as ActionLevel] > actionRank[context.environment.actionLevel]
    ) {
      issues.push({
        severity: "error",
        code: "ACTION_LEVEL_EXCEEDS_ENVIRONMENT",
        path: "$.metadata.actionLevel",
        message: `用例动作等级高于环境允许的 ${context.environment.actionLevel}。`,
      });
    }
  }

  if (
    metadata !== undefined &&
    (metadata.actionLevel === "write" || metadata.actionLevel === "dangerous") &&
    (!isJsonArray(definition.finally) || definition.finally.length === 0)
  ) {
    issues.push({
      severity: "error",
      code: "CLEANUP_REQUIRED",
      path: "$.finally",
      message: "write 或 dangerous 用例必须提供清理步骤。",
    });
  }

  const uniqueIssues = issues.filter(
    (issue, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === issue.code &&
          candidate.path === issue.path &&
          candidate.message === issue.message,
      ) === index,
  );
  return {
    valid: uniqueIssues.every((issue) => issue.severity !== "error"),
    issues: uniqueIssues,
  };
}
