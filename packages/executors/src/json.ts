import { ExecutorFailure, interpolateValue } from "./base.js";

export type JsonAssertionOperator = "equals" | "not-equals" | "contains" | "exists";

export interface JsonExtractParameters {
  readonly source: string;
  readonly path: string;
}

export interface JsonAssertParameters extends JsonExtractParameters {
  readonly operator: JsonAssertionOperator;
  readonly expected?: unknown;
}

export interface JsonExtractResult {
  readonly [key: string]: unknown;
  readonly path: string;
  readonly found: true;
  readonly value: unknown;
}

export interface JsonAssertResult {
  readonly [key: string]: unknown;
  readonly path: string;
  readonly operator: JsonAssertionOperator;
  readonly matched: true;
  readonly actual?: unknown;
}

type JsonPathSegment = string | number;

const exactReferencePattern = /^\$\{([^}]+)\}$/;
const variableNamePattern = /^step\.[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/i;
const propertyPattern = /^[a-zA-Z0-9_-]+/;
const forbiddenProperties = new Set(["__proto__", "prototype", "constructor"]);
const operators = new Set<JsonAssertionOperator>(["equals", "not-equals", "contains", "exists"]);
const maximumSourceBytes = 1_048_576;
const maximumEvidenceBytes = 65_536;
const maximumPathLength = 500;
const maximumPathSegments = 20;
const maximumArrayIndex = 100_000;
const maximumStructureDepth = 50;
const maximumStructureNodes = 100_000;

function failure(
  code: string,
  message: string,
  classification: "test_failed" | "product_failed",
): ExecutorFailure {
  return new ExecutorFailure({ code, message, classification });
}

function assertAllowedKeys(
  parameters: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(parameters).some((key) => !allowed.has(key))) {
    throw failure("JSON_PARAMETERS_INVALID", "JSON 动作包含未注册的参数。", "test_failed");
  }
}

function parseJsonPath(path: string): readonly JsonPathSegment[] {
  if (path.length === 0 || path.length > maximumPathLength || path[0] !== "$") {
    throw failure("JSON_PATH_INVALID", "JSONPath 必须从 $ 开始且不超过安全长度。", "test_failed");
  }
  const segments: JsonPathSegment[] = [];
  let offset = 1;
  while (offset < path.length) {
    if (segments.length >= maximumPathSegments) {
      throw failure("JSON_PATH_INVALID", "JSONPath 的路径层级超过安全上限。", "test_failed");
    }
    if (path[offset] === ".") {
      const matched = propertyPattern.exec(path.slice(offset + 1));
      const property = matched?.[0];
      if (property === undefined || forbiddenProperties.has(property)) {
        throw failure("JSON_PATH_INVALID", "JSONPath 包含未允许的属性访问。", "test_failed");
      }
      segments.push(property);
      offset += property.length + 1;
      continue;
    }
    if (path[offset] === "[") {
      const matched = /^\[(0|[1-9][0-9]*)\]/.exec(path.slice(offset));
      if (matched?.[1] === undefined) {
        throw failure(
          "JSON_PATH_INVALID",
          "JSONPath 数组访问只能使用非负整数下标。",
          "test_failed",
        );
      }
      const index = Number(matched[1]);
      if (!Number.isSafeInteger(index) || index > maximumArrayIndex) {
        throw failure("JSON_PATH_INVALID", "JSONPath 数组下标超过安全上限。", "test_failed");
      }
      segments.push(index);
      offset += matched[0].length;
      continue;
    }
    throw failure("JSON_PATH_INVALID", "JSONPath 只能使用点属性和数组整数下标。", "test_failed");
  }
  return segments;
}

function serializedBytes(value: unknown, code: string, message: string): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not JSON serializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    throw new ExecutorFailure({ code, message, classification: "test_failed" }, error);
  }
}

function validateStructure(value: unknown): void {
  const stack: Array<Readonly<{ value: unknown; depth: number }>> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > maximumStructureNodes || current.depth > maximumStructureDepth) {
      throw failure(
        "JSON_SOURCE_TOO_COMPLEX",
        "JSON 源的层级或节点数量超过安全上限。",
        "test_failed",
      );
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (typeof current.value === "number" && !Number.isFinite(current.value)) {
      throw failure("JSON_SOURCE_INVALID", "JSON 源包含非有限数值。", "product_failed");
    } else if (
      !["string", "number", "boolean"].includes(typeof current.value) &&
      current.value !== null
    ) {
      throw failure("JSON_SOURCE_INVALID", "变量不是有效的 JSON 值。", "product_failed");
    }
  }
}

function resolveSource(source: unknown, variables: Readonly<Record<string, unknown>>): unknown {
  if (typeof source !== "string") {
    throw failure("JSON_PARAMETERS_INVALID", "JSON 动作必须声明 source 变量引用。", "test_failed");
  }
  const reference = exactReferencePattern.exec(source)?.[1];
  if (reference === undefined || !variableNamePattern.test(reference)) {
    throw failure(
      "JSON_PARAMETERS_INVALID",
      "JSON source 必须是先前步骤捕获值的精确变量引用。",
      "test_failed",
    );
  }
  if (!Object.hasOwn(variables, reference)) {
    throw failure("VARIABLE_NOT_FOUND", `变量 ${reference} 不存在。`, "test_failed");
  }
  let value = variables[reference];
  const sourceWasText = typeof value === "string";
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > maximumSourceBytes) {
      throw failure("JSON_SOURCE_TOO_LARGE", "JSON 源超过 1 MiB 安全上限。", "test_failed");
    }
    try {
      value = JSON.parse(value) as unknown;
    } catch (error) {
      throw new ExecutorFailure(
        {
          code: "JSON_SOURCE_INVALID",
          message: "JSON 源变量不是有效的 JSON 文本。",
          classification: "product_failed",
        },
        error,
      );
    }
  }
  validateStructure(value);
  if (
    !sourceWasText &&
    serializedBytes(value, "JSON_SOURCE_INVALID", "变量不是可安全处理的 JSON 值。") >
      maximumSourceBytes
  ) {
    throw failure("JSON_SOURCE_TOO_LARGE", "JSON 源超过 1 MiB 安全上限。", "test_failed");
  }
  return value;
}

function selectPath(source: unknown, path: string): Readonly<{ found: boolean; value?: unknown }> {
  let current = source;
  for (const segment of parseJsonPath(path)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { found: false };
      current = current[segment];
      continue;
    }
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false };
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return { found: true, value: current };
}

function safeEvidenceValue(value: unknown): unknown {
  if (
    serializedBytes(value, "JSON_SELECTED_VALUE_INVALID", "选中的 JSON 值无法登记为结构化证据。") >
    maximumEvidenceBytes
  ) {
    throw failure(
      "JSON_SELECTED_VALUE_TOO_LARGE",
      "选中的 JSON 值超过 64 KiB 证据上限。",
      "test_failed",
    );
  }
  return value;
}

function valuesEqual(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > maximumStructureDepth) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => valuesEqual(item, right[index], depth + 1))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return false;
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    valuesEqual(leftKeys, rightKeys, depth + 1) &&
    leftKeys.every((key) => valuesEqual(leftRecord[key], rightRecord[key], depth + 1))
  );
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
  if (Array.isArray(actual)) return actual.some((item) => valuesEqual(item, expected));
  throw failure(
    "JSON_COMPARISON_UNSUPPORTED",
    "contains 只支持字符串包含或数组成员比较。",
    "test_failed",
  );
}

function expectedValue(expected: unknown, variables: Readonly<Record<string, unknown>>): unknown {
  if (typeof expected === "string") {
    const reference = exactReferencePattern.exec(expected)?.[1];
    if (reference !== undefined) {
      if (!Object.hasOwn(variables, reference)) {
        throw failure("VARIABLE_NOT_FOUND", `变量 ${reference} 不存在。`, "test_failed");
      }
      return variables[reference];
    }
  }
  return interpolateValue(expected, variables);
}

export function executeJsonExtract(
  parameters: JsonExtractParameters,
  variables: Readonly<Record<string, unknown>>,
): JsonExtractResult {
  assertAllowedKeys(
    parameters as unknown as Readonly<Record<string, unknown>>,
    new Set(["source", "path"]),
  );
  if (typeof parameters.path !== "string") {
    throw failure("JSON_PARAMETERS_INVALID", "JSON 提取动作必须声明 path。", "test_failed");
  }
  const selected = selectPath(resolveSource(parameters.source, variables), parameters.path);
  if (!selected.found) {
    throw failure("JSON_PATH_NOT_FOUND", `JSON 路径 ${parameters.path} 不存在。`, "product_failed");
  }
  return { path: parameters.path, found: true, value: safeEvidenceValue(selected.value) };
}

export function executeJsonAssert(
  parameters: JsonAssertParameters,
  variables: Readonly<Record<string, unknown>>,
): JsonAssertResult {
  assertAllowedKeys(
    parameters as unknown as Readonly<Record<string, unknown>>,
    new Set(["source", "path", "operator", "expected"]),
  );
  if (
    typeof parameters.path !== "string" ||
    typeof parameters.operator !== "string" ||
    !operators.has(parameters.operator)
  ) {
    throw failure(
      "JSON_PARAMETERS_INVALID",
      "JSON 断言动作必须声明受支持的 path 和 operator。",
      "test_failed",
    );
  }
  if (parameters.operator !== "exists" && !("expected" in parameters)) {
    throw failure(
      "JSON_PARAMETERS_INVALID",
      `JSON 断言 ${parameters.operator} 必须声明 expected。`,
      "test_failed",
    );
  }
  if (parameters.operator === "exists" && "expected" in parameters) {
    throw failure("JSON_PARAMETERS_INVALID", "JSON exists 断言不得声明 expected。", "test_failed");
  }
  const selected = selectPath(resolveSource(parameters.source, variables), parameters.path);
  const expected =
    parameters.operator === "exists" ? undefined : expectedValue(parameters.expected, variables);
  const matched =
    parameters.operator === "exists"
      ? selected.found
      : selected.found &&
        (parameters.operator === "equals"
          ? valuesEqual(selected.value, expected)
          : parameters.operator === "not-equals"
            ? !valuesEqual(selected.value, expected)
            : containsValue(selected.value, expected));
  if (!matched) {
    throw failure(
      "JSON_ASSERTION_FAILED",
      `JSON 断言失败：路径 ${parameters.path} 未满足 ${parameters.operator}。`,
      "product_failed",
    );
  }
  return {
    path: parameters.path,
    operator: parameters.operator,
    matched: true,
    ...(selected.found ? { actual: safeEvidenceValue(selected.value) } : {}),
  };
}
