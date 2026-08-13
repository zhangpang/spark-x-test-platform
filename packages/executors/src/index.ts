import type { RunFailure } from "@spark-x-test/contracts";

export type ExecutorActionLevel = "read" | "write" | "dangerous";

export interface ExecutorDescriptor {
  readonly key: string;
  readonly actionLevel: ExecutorActionLevel;
  readonly defaultTimeoutMs: number;
}

export class ExecutorRegistry {
  readonly #descriptors = new Map<string, ExecutorDescriptor>();

  register(descriptor: ExecutorDescriptor): void {
    if (this.#descriptors.has(descriptor.key)) {
      throw new Error(`Executor already registered: ${descriptor.key}`);
    }
    this.#descriptors.set(descriptor.key, Object.freeze({ ...descriptor }));
  }

  get(key: string): ExecutorDescriptor | undefined {
    return this.#descriptors.get(key);
  }

  list(): readonly ExecutorDescriptor[] {
    return [...this.#descriptors.values()].sort((left, right) => left.key.localeCompare(right.key));
  }
}

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

export interface HttpStepParameters {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HttpExecutionResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly durationMs: number;
  readonly url: string;
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

function requiredActionLevel(method: string): ExecutorActionLevel {
  if (method === "DELETE") return "dangerous";
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return "read";
  return "write";
}

const actionRank: Readonly<Record<ExecutorActionLevel, number>> = {
  read: 1,
  write: 2,
  dangerous: 3,
};

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

function safeHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...headers.entries()]
      .filter(([name]) => !["set-cookie", "authorization", "proxy-authorization"].includes(name))
      .slice(0, 100)
      .map(([name, value]) => [name, value.slice(0, 2_000)]),
  );
}

async function responseBody(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 1_000_000);
  if (text === "") return null;
  if (response.headers.get("content-type")?.includes("application/json") === true) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ExecutorFailure({
        code: "INVALID_JSON_RESPONSE",
        message: "响应声明为 JSON，但内容无法解析。",
        classification: "product_failed",
      });
    }
  }
  return text;
}

export async function executeHttpRequest(
  environment: HttpExecutionEnvironment,
  parameters: HttpStepParameters,
  variables: Readonly<Record<string, unknown>>,
  options: Readonly<{
    timeoutMs: number;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  }>,
): Promise<HttpExecutionResult> {
  const method = parameters.method.toUpperCase();
  if (actionRank[requiredActionLevel(method)] > actionRank[environment.actionLevel]) {
    throw new ExecutorFailure({
      code: "ACTION_LEVEL_EXCEEDED",
      message: `环境不允许执行 ${method} 动作。`,
      classification: "test_failed",
    });
  }
  const path = interpolateString(parameters.path, variables);
  let target = new URL(path, environment.baseUrl);
  assertHttpTargetAllowed(target, environment.allowlist);
  const headers = Object.fromEntries(
    Object.entries(parameters.headers ?? {}).map(([name, value]) => [
      name,
      interpolateString(value, variables),
    ]),
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("HTTP request timed out")),
    options.timeoutMs,
  );
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const startedAt = performance.now();
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await (options.fetcher ?? fetch)(target, {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
        ...(parameters.body === undefined
          ? {}
          : {
              body:
                typeof parameters.body === "string"
                  ? interpolateString(parameters.body, variables)
                  : JSON.stringify(interpolateValue(parameters.body, variables)),
            }),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) break;
        if (redirect === 5) {
          throw new ExecutorFailure({
            code: "TOO_MANY_REDIRECTS",
            message: "HTTP 重定向次数超过上限。",
            classification: "environment_failed",
          });
        }
        target = new URL(location, target);
        assertHttpTargetAllowed(target, environment.allowlist);
        continue;
      }
      return {
        status: response.status,
        headers: safeHeaders(response.headers),
        body: await responseBody(response),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        url: target.toString(),
      };
    }
    throw new ExecutorFailure({
      code: "INVALID_REDIRECT",
      message: "HTTP 重定向响应缺少目标地址。",
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
          code: externallyCancelled ? "EXECUTION_CANCELLED" : "HTTP_TIMEOUT",
          message: externallyCancelled ? "运行已取消。" : "HTTP 请求超时。",
          classification: "environment_failed",
        },
        error,
      );
    }
    throw new ExecutorFailure(
      {
        code: "HTTP_NETWORK_ERROR",
        message: "HTTP 目标无法访问。",
        classification: "environment_failed",
      },
      error,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
