import {
  assertHttpTargetAllowed,
  ExecutorFailure,
  interpolateString,
  interpolateValue,
  type ExecutorActionLevel,
  type HttpExecutionEnvironment,
} from "./base.js";

export {
  assertHttpTargetAllowed,
  ExecutorFailure,
  interpolateString,
  interpolateValue,
  type ExecutorActionLevel,
  type HttpExecutionEnvironment,
  type HttpTargetRule,
} from "./base.js";

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

export {
  browserActions,
  BrowserExecutorFailure,
  createChromiumSession,
  type BrowserAction,
  type BrowserExecutionSession,
  type BrowserSessionFactory,
  type BrowserStepResult,
  type ExecutorArtifact,
} from "./browser.js";
