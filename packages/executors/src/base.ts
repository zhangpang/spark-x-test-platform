import type { RunFailure } from "@spark-x-test/contracts";

export type ExecutorActionLevel = "read" | "write" | "dangerous";

export interface HttpTargetRule {
  readonly protocol: "http" | "https";
  readonly host: string;
  readonly ports: readonly number[];
  readonly pathPrefixes?: readonly string[];
}

export interface HttpExecutionEnvironment {
  readonly baseUrl: string;
  readonly allowlist: readonly HttpTargetRule[];
  readonly actionLevel: ExecutorActionLevel;
}

export class ExecutorFailure extends Error {
  readonly failure: RunFailure;

  constructor(failure: RunFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.name = "ExecutorFailure";
    this.failure = failure;
  }
}

function effectivePort(target: URL): number {
  if (target.port !== "") return Number(target.port);
  return target.protocol === "https:" ? 443 : 80;
}

export function assertHttpTargetAllowed(target: URL, allowlist: readonly HttpTargetRule[]): void {
  if (target.username !== "" || target.password !== "") {
    throw new ExecutorFailure({
      code: "TARGET_CREDENTIALS_FORBIDDEN",
      message: "目标 URL 不能包含用户名或密码。",
      classification: "test_failed",
    });
  }
  const protocol = target.protocol.slice(0, -1);
  const port = effectivePort(target);
  const allowed = allowlist.some(
    (rule) =>
      rule.protocol === protocol &&
      rule.host.toLowerCase() === target.hostname.toLowerCase() &&
      rule.ports.includes(port) &&
      (rule.pathPrefixes === undefined ||
        rule.pathPrefixes.some((prefix) => target.pathname.startsWith(prefix))),
  );
  if (!allowed) {
    throw new ExecutorFailure({
      code: "TARGET_NOT_ALLOWED",
      message: "请求目标不在当前环境白名单内。",
      classification: "test_failed",
    });
  }
}

export function interpolateString(
  value: string,
  variables: Readonly<Record<string, unknown>>,
): string {
  return value.replaceAll(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const replacement = variables[name];
    if (replacement === undefined) {
      throw new ExecutorFailure({
        code: "VARIABLE_NOT_FOUND",
        message: `变量 ${name} 不存在。`,
        classification: "test_failed",
      });
    }
    return typeof replacement === "string" ? replacement : JSON.stringify(replacement);
  });
}

export function interpolateValue(
  value: unknown,
  variables: Readonly<Record<string, unknown>>,
  depth = 0,
): unknown {
  if (depth > 20) {
    throw new ExecutorFailure({
      code: "VARIABLE_STRUCTURE_TOO_DEEP",
      message: "请求参数的嵌套层级超过安全上限。",
      classification: "test_failed",
    });
  }
  if (typeof value === "string") return interpolateString(value, variables);
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, variables, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolateValue(item, variables, depth + 1),
      ]),
    );
  }
  return value;
}
