import {
  executeHttpRequest,
  type HttpExecutionResult,
  type HttpStepParameters,
} from "./http.js";
import {
  ExecutorFailure,
  interpolateValue,
  type HttpExecutionEnvironment,
} from "./base.js";

export type WaitConditionOperator = "equals" | "not-equals" | "contains" | "exists";

export interface WaitHttpCondition {
  readonly path: string;
  readonly operator: WaitConditionOperator;
  readonly expected?: unknown;
}

export interface WaitHttpParameters {
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly intervalMs?: number;
  readonly condition: WaitHttpCondition;
}

export interface WaitHttpResult {
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly matched: true;
  readonly lastResponse: Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: unknown;
    url: string;
  }>;
}

const jsonPathPattern = /^\$(?:\.[a-zA-Z0-9_-]+){0,20}$/;
const runCancellationReasons = new Set([
  "Run cancellation requested",
  "Cancellation state unavailable",
]);

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseParameters(parameters: WaitHttpParameters): Readonly<{
  request: HttpStepParameters;
  intervalMs: number;
  condition: WaitHttpCondition;
}> {
  if (
    typeof parameters.path !== "string" ||
    !parameters.path.startsWith("/") ||
    parameters.path.startsWith("//")
  ) {
    throw new ExecutorFailure({
      code: "WAIT_HTTP_PATH_INVALID",
      message: "HTTP 轮询只能使用以 / 开头的相对路径。",
      classification: "test_failed",
    });
  }
  if (
    parameters.intervalMs !== undefined &&
    (!Number.isInteger(parameters.intervalMs) ||
      parameters.intervalMs < 100 ||
      parameters.intervalMs > 30_000)
  ) {
    throw new ExecutorFailure({
      code: "WAIT_INTERVAL_INVALID",
      message: "HTTP 轮询间隔必须是 100 到 30000 毫秒之间的整数。",
      classification: "test_failed",
    });
  }
  const condition = objectValue(parameters.condition);
  const operator = condition?.operator;
  const path = condition?.path;
  if (
    condition === null ||
    typeof path !== "string" ||
    !jsonPathPattern.test(path) ||
    !["equals", "not-equals", "contains", "exists"].includes(String(operator))
  ) {
    throw new ExecutorFailure({
      code: "WAIT_CONDITION_INVALID",
      message: "HTTP 轮询条件必须使用受限 JSON 路径和已注册比较符。",
      classification: "test_failed",
    });
  }
  if (operator !== "exists" && !("expected" in condition)) {
    throw new ExecutorFailure({
      code: "WAIT_EXPECTED_VALUE_REQUIRED",
      message: `HTTP 轮询条件 ${String(operator)} 必须声明 expected。`,
      classification: "test_failed",
    });
  }
  if (
    parameters.headers !== undefined &&
    Object.values(parameters.headers).some((value) => typeof value !== "string")
  ) {
    throw new ExecutorFailure({
      code: "WAIT_HEADERS_INVALID",
      message: "HTTP 轮询请求头必须是字符串键值对。",
      classification: "test_failed",
    });
  }
  return {
    request: {
      method: "GET",
      path: parameters.path,
      ...(parameters.headers === undefined ? {} : { headers: parameters.headers }),
    },
    intervalMs: parameters.intervalMs ?? 500,
    condition: {
      path,
      operator: operator as WaitConditionOperator,
      ...(condition.expected === undefined ? {} : { expected: condition.expected }),
    },
  };
}

function readJsonPath(value: unknown, path: string): Readonly<{ found: boolean; value?: unknown }> {
  if (path === "$") return { found: true, value };
  let current = value;
  for (const segment of path.slice(2).split(".")) {
    const record = objectValue(current);
    if (record === null || !(segment in record)) return { found: false };
    current = record[segment];
  }
  return { found: true, value: current };
}

function valuesEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 20) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => valuesEqual(item, right[index], depth + 1))
    );
  }
  const leftObject = objectValue(left);
  const rightObject = objectValue(right);
  if (leftObject === null || rightObject === null) return false;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    valuesEqual(leftKeys, rightKeys, depth + 1) &&
    leftKeys.every((key) => valuesEqual(leftObject[key], rightObject[key], depth + 1))
  );
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected);
  }
  if (Array.isArray(actual)) return actual.some((item) => valuesEqual(item, expected));
  return false;
}

function conditionMatches(
  response: HttpExecutionResult,
  condition: WaitHttpCondition,
  variables: Readonly<Record<string, unknown>>,
): boolean {
  const selected = readJsonPath(
    {
      status: response.status,
      headers: response.headers,
      body: response.body,
      url: response.url,
    },
    condition.path,
  );
  if (condition.operator === "exists") return selected.found;
  const expected = interpolateValue(condition.expected, variables);
  if (condition.operator === "equals") return selected.found && valuesEqual(selected.value, expected);
  if (condition.operator === "not-equals") {
    return !selected.found || !valuesEqual(selected.value, expected);
  }
  return selected.found && containsValue(selected.value, expected);
}

function abortFailure(signal: AbortSignal): ExecutorFailure {
  const reason = signal.reason instanceof Error ? signal.reason.message : "";
  const cancelled = runCancellationReasons.has(reason);
  return new ExecutorFailure({
    code: cancelled ? "EXECUTION_CANCELLED" : "WAIT_INTERRUPTED",
    message: cancelled ? "运行已取消。" : "HTTP 轮询被用例超时或执行中断终止。",
    classification: "environment_failed",
  });
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortFailure(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortFailure(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function executeWaitHttp(
  environment: HttpExecutionEnvironment,
  parameters: WaitHttpParameters,
  variables: Readonly<Record<string, unknown>>,
  options: Readonly<{
    timeoutMs: number;
    signal: AbortSignal;
    fetcher?: typeof fetch;
  }>,
): Promise<WaitHttpResult> {
  const parsed = parseParameters(parameters);
  const started = performance.now();
  const deadline = started + options.timeoutMs;
  let attempts = 0;
  while (true) {
    if (options.signal.aborted) throw abortFailure(options.signal);
    const remainingBeforeRequest = Math.ceil(deadline - performance.now());
    if (remainingBeforeRequest <= 0) {
      throw new ExecutorFailure({
        code: "WAIT_CONDITION_TIMEOUT",
        message: "HTTP 轮询在步骤超时前未满足声明条件。",
        classification: "product_failed",
      });
    }
    const response = await executeHttpRequest(environment, parsed.request, variables, {
      timeoutMs: remainingBeforeRequest,
      signal: options.signal,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
    attempts += 1;
    if (conditionMatches(response, parsed.condition, variables)) {
      return {
        attempts,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        matched: true,
        lastResponse: {
          status: response.status,
          headers: response.headers,
          body: response.body,
          url: response.url,
        },
      };
    }
    const remainingBeforeDelay = Math.ceil(deadline - performance.now());
    if (remainingBeforeDelay <= 0) continue;
    await delay(Math.min(parsed.intervalMs, remainingBeforeDelay), options.signal);
  }
}
