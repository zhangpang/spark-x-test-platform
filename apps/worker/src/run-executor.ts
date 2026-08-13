import { randomUUID } from "node:crypto";

import type {
  CaseResult,
  CleanupStatus,
  RunFailure,
  RunSummary,
  TestRunJob,
} from "@spark-x-test/contracts";
import {
  choosePrimaryFailure,
  gateResultForSummary,
  summarizeCaseResults,
} from "@spark-x-test/execution-engine";
import {
  executeHttpRequest,
  ExecutorFailure,
  type HttpExecutionResult,
  type HttpStepParameters,
} from "@spark-x-test/executors";
import type {
  RunExecutionSnapshot,
  SecretVariableReference,
  TestRunStore,
} from "@spark-x-test/service-runtime";

export type RunExecutionStore = Pick<
  TestRunStore,
  | "claimRun"
  | "setRunStatus"
  | "isCancellationRequested"
  | "resolveSecretVariables"
  | "heartbeat"
  | "startCase"
  | "recordStep"
  | "finishCase"
  | "completeRun"
>;

interface DefinitionStep {
  readonly id: string;
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly capture: Readonly<Record<string, string>>;
  readonly assertions: readonly Readonly<Record<string, unknown>>[];
}

interface ParsedDefinition {
  readonly stepTimeoutMs: number;
  readonly caseTimeoutMs: number;
  readonly steps: readonly DefinitionStep[];
  readonly finallySteps: readonly DefinitionStep[];
  readonly secretInputs: readonly SecretVariableReference[];
}

interface AttemptResult {
  readonly result: CaseResult;
  readonly failure: RunFailure | null;
}

interface CleanupResult {
  readonly status: CleanupStatus;
  readonly failure: RunFailure | null;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function integerValue(value: unknown, fallback: number, max: number): number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= max
    ? (value as number)
    : fallback;
}

function parseSteps(value: unknown): readonly DefinitionStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const step = objectValue(candidate);
    if (step === null || typeof step.id !== "string" || typeof step.action !== "string") return [];
    const params = objectValue(step.params) ?? {};
    const capture = objectValue(step.capture) ?? {};
    const assertions = Array.isArray(step.assertions)
      ? step.assertions.flatMap((assertion) => {
          const parsed = objectValue(assertion);
          return parsed === null ? [] : [parsed];
        })
      : [];
    return [
      {
        id: step.id,
        action: step.action,
        params,
        capture: Object.fromEntries(
          Object.entries(capture).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        assertions,
      },
    ];
  });
}

function parseDefinition(definition: Readonly<Record<string, unknown>>): ParsedDefinition {
  const execution = objectValue(definition.execution) ?? {};
  const steps = parseSteps(definition.steps);
  if (steps.length === 0) {
    throw new ExecutorFailure({
      code: "NO_EXECUTABLE_STEPS",
      message: "用例没有可执行步骤。",
      classification: "test_failed",
    });
  }
  return {
    stepTimeoutMs: integerValue(execution.stepTimeoutMs, 30_000, 300_000),
    caseTimeoutMs: integerValue(execution.caseTimeoutMs, 120_000, 1_800_000),
    steps,
    finallySteps: parseSteps(definition.finally),
    secretInputs: Array.isArray(definition.inputs)
      ? definition.inputs.flatMap((candidate) => {
          const input = objectValue(candidate);
          return input !== null &&
            typeof input.name === "string" &&
            typeof input.secretRef === "string"
            ? [{ name: input.name, secretRef: input.secretRef }]
            : [];
        })
      : [],
  };
}

function redactEvidence(
  value: unknown,
  variables: Readonly<Record<string, unknown>>,
  depth = 0,
): unknown {
  if (depth > 20) return "[TRUNCATED]";
  const secrets = Object.entries(variables)
    .filter(([name, candidate]) => name.startsWith("case.") && typeof candidate === "string")
    .map(([, candidate]) => candidate as string)
    .filter((candidate) => candidate.length > 0);
  if (typeof value === "string") {
    return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactEvidence(item, variables, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /authorization|password|token|secret|cookie/i.test(key)
          ? "[REDACTED]"
          : redactEvidence(item, variables, depth + 1),
      ]),
    );
  }
  return value;
}

function httpParameters(params: Readonly<Record<string, unknown>>): HttpStepParameters {
  if (typeof params.method !== "string" || typeof params.path !== "string") {
    throw new ExecutorFailure({
      code: "INVALID_HTTP_PARAMETERS",
      message: "HTTP 步骤缺少 method 或 path。",
      classification: "test_failed",
    });
  }
  const headers = objectValue(params.headers);
  const stringHeaders =
    headers === null
      ? undefined
      : Object.fromEntries(
          Object.entries(headers).flatMap(([key, value]) =>
            typeof value === "string" ? [[key, value]] : [],
          ),
        );
  return {
    method: params.method,
    path: params.path,
    ...(stringHeaders === undefined ? {} : { headers: stringHeaders }),
    ...(params.body === undefined ? {} : { body: params.body }),
  };
}

function captureValues(
  response: HttpExecutionResult,
  capture: Readonly<Record<string, string>>,
  variables: Record<string, unknown>,
): void {
  for (const [name, path] of Object.entries(capture)) {
    if (path === "$.status") variables[`step.${name}`] = response.status;
    else if (path === "$.body") variables[`step.${name}`] = response.body;
    else if (path === "$.headers") variables[`step.${name}`] = response.headers;
  }
}

function assertionValue(value: unknown, variables: Readonly<Record<string, unknown>>): unknown {
  if (typeof value !== "string") return value;
  const matched = /^\$\{([^}]+)\}$/.exec(value);
  return matched === null ? value : variables[matched[1] as string];
}

function assertResponse(
  assertions: readonly Readonly<Record<string, unknown>>[],
  variables: Readonly<Record<string, unknown>>,
  stepId: string,
): void {
  for (const assertion of assertions) {
    if (assertion.type === "status:equals") {
      const actual = assertionValue(assertion.actual, variables);
      if (actual !== assertion.expected) {
        throw new ExecutorFailure({
          code: "STATUS_ASSERTION_FAILED",
          message: `状态码断言失败：期望 ${String(assertion.expected)}，实际 ${String(actual)}。`,
          classification: "product_failed",
          stepId,
        });
      }
    }
  }
}

function sanitizedInput(step: DefinitionStep): Readonly<Record<string, unknown>> {
  return {
    action: step.action,
    method: typeof step.params.method === "string" ? step.params.method : undefined,
    path: typeof step.params.path === "string" ? step.params.path : undefined,
  };
}

async function executeStep(
  runId: string,
  runCaseId: string,
  attempt: number,
  step: DefinitionStep,
  path: string,
  phase: "main" | "finally",
  snapshot: RunExecutionSnapshot,
  variables: Record<string, unknown>,
  store: RunExecutionStore,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<AttemptResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    if (step.action !== "http:request") {
      throw new ExecutorFailure({
        code: "EXECUTOR_NOT_AVAILABLE",
        message: `执行器 ${step.action} 尚未在当前 Worker 镜像中注册。`,
        classification: "test_failed",
        stepId: step.id,
      });
    }
    const response = await executeHttpRequest(
      snapshot.environment,
      httpParameters(step.params),
      variables,
      { timeoutMs, signal },
    );
    captureValues(response, step.capture, variables);
    assertResponse(step.assertions, variables, step.id);
    await store.recordStep(runId, {
      id: randomUUID(),
      runCaseId,
      attempt,
      path,
      stepId: step.id,
      action: step.action,
      phase,
      status: "passed",
      result: "passed",
      inputSummary: sanitizedInput(step),
      outputSummary: {
        status: response.status,
        headers: redactEvidence(response.headers, variables),
        body: redactEvidence(response.body, variables),
        url: redactEvidence(response.url, variables),
      },
      startedAt,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return { result: "passed", failure: null };
  } catch (error) {
    const failure =
      error instanceof ExecutorFailure
        ? error.failure
        : {
            code: "EXECUTOR_INTERNAL_ERROR",
            message: "执行器发生未预期错误。",
            classification: "infrastructure_failed" as const,
            stepId: step.id,
          };
    const cancelled = signal.aborted && failure.code === "EXECUTION_CANCELLED";
    await store.recordStep(runId, {
      id: randomUUID(),
      runCaseId,
      attempt,
      path,
      stepId: step.id,
      action: step.action,
      phase,
      status: cancelled ? "cancelled" : "failed",
      result: cancelled ? "cancelled" : failure.classification,
      inputSummary: sanitizedInput(step),
      ...(cancelled ? {} : { error: failure }),
      startedAt,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    });
    return {
      result: cancelled ? "cancelled" : failure.classification,
      failure: cancelled ? null : failure,
    };
  }
}

async function executeAttempt(
  runId: string,
  runCaseId: string,
  attempt: number,
  definition: ParsedDefinition,
  snapshot: RunExecutionSnapshot,
  store: RunExecutionStore,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AttemptResult> {
  for (const [index, step] of definition.steps.entries()) {
    if (signal.aborted) {
      return {
        result: "cancelled",
        failure: null,
      };
    }
    const result = await executeStep(
      runId,
      runCaseId,
      attempt,
      step,
      `steps[${index}]`,
      "main",
      snapshot,
      variables,
      store,
      definition.stepTimeoutMs,
      signal,
    );
    if (result.result !== "passed") return result;
  }
  return { result: "passed", failure: null };
}

async function executeCleanup(
  runId: string,
  runCaseId: string,
  attempt: number,
  definition: ParsedDefinition,
  snapshot: RunExecutionSnapshot,
  store: RunExecutionStore,
  variables: Record<string, unknown>,
): Promise<CleanupResult> {
  if (definition.finallySteps.length === 0) return { status: "not_required", failure: null };
  const cleanupSignal = new AbortController().signal;
  for (const [index, step] of definition.finallySteps.entries()) {
    const result = await executeStep(
      runId,
      runCaseId,
      attempt,
      step,
      `finally[${index}]`,
      "finally",
      snapshot,
      variables,
      store,
      definition.stepTimeoutMs,
      cleanupSignal,
    );
    if (result.result !== "passed") {
      return {
        status: "failed",
        failure: {
          code: "CLEANUP_FAILED",
          message:
            result.failure === null
              ? "用例清理步骤失败，需要检查测试数据或执行环境。"
              : `用例清理步骤失败：${result.failure.message}`,
          classification: "infrastructure_failed",
          ...(result.failure?.stepId === undefined ? {} : { stepId: result.failure.stepId }),
        },
      };
    }
  }
  return { status: "passed", failure: null };
}

export async function executeRunJob(
  job: TestRunJob,
  workerId: string,
  store: RunExecutionStore,
): Promise<Readonly<{ ignored?: true; summary?: RunSummary }>> {
  if (job.protocolVersion !== "1.0") throw new Error("Unsupported run job protocol");
  const snapshot = await store.claimRun(job.runId, workerId);
  if (snapshot === null) return { ignored: true };
  const controller = new AbortController();
  if (await store.isCancellationRequested(job.runId)) {
    controller.abort(new Error("Run cancellation requested"));
  } else {
    const enteredRunning = await store.setRunStatus(job.runId, "running");
    if (!enteredRunning) controller.abort(new Error("Run cancellation requested"));
  }
  const poll = setInterval(() => {
    void store
      .isCancellationRequested(job.runId)
      .then((requested) => {
        if (requested) controller.abort(new Error("Run cancellation requested"));
      })
      .catch(() => controller.abort(new Error("Cancellation state unavailable")));
  }, 500);
  const heartbeat = setInterval(() => {
    void store.heartbeat(job.runId, workerId).catch(() => {
      // The cancellation poll remains the authoritative fail-closed liveness check.
    });
  }, 5_000);
  const results: CaseResult[] = [];
  const failures: RunFailure[] = [];
  try {
    for (const item of snapshot.cases) {
      const caseStartedAt = Date.now();
      if (controller.signal.aborted) {
        await store.finishCase(
          job.runId,
          item.runCaseId,
          "cancelled",
          "not_required",
          null,
          caseStartedAt,
        );
        results.push("cancelled");
        continue;
      }
      let definition: ParsedDefinition;
      try {
        definition = parseDefinition(item.definition);
      } catch (error) {
        const failure =
          error instanceof ExecutorFailure
            ? error.failure
            : {
                code: "INVALID_CASE_DEFINITION",
                message: "用例定义无法解析。",
                classification: "test_failed" as const,
              };
        await store.startCase(job.runId, item.runCaseId, 1);
        await store.finishCase(
          job.runId,
          item.runCaseId,
          failure.classification,
          "not_required",
          failure,
          caseStartedAt,
        );
        results.push(failure.classification);
        failures.push(failure);
        continue;
      }
      let secretVariables: Readonly<Record<string, string>>;
      try {
        secretVariables = await store.resolveSecretVariables(job.runId, definition.secretInputs);
      } catch (error) {
        const knownCodes = [
          "SECRET_VAULT_UNAVAILABLE",
          "SECRET_REFERENCE_NOT_FOUND",
          "SECRET_DECRYPTION_FAILED",
        ];
        const failure: RunFailure = {
          code:
            error instanceof Error && knownCodes.includes(error.message)
              ? error.message
              : "SECRET_RESOLUTION_FAILED",
          message: "运行所需密钥无法在当前系统和环境作用域内解析。",
          classification: "environment_failed",
        };
        await store.startCase(job.runId, item.runCaseId, 1);
        await store.finishCase(
          job.runId,
          item.runCaseId,
          failure.classification,
          "not_required",
          failure,
          caseStartedAt,
        );
        results.push(failure.classification);
        failures.push(failure);
        continue;
      }
      const caseController = new AbortController();
      const cancelCase = () => caseController.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", cancelCase, { once: true });
      const caseTimeout = setTimeout(
        () => caseController.abort(new Error("Case timeout")),
        definition.caseTimeoutMs,
      );
      let attemptResult: AttemptResult = { result: "passed", failure: null };
      let firstFailure: RunFailure | null = null;
      let flaky = false;
      let attempt = 1;
      let lastAttempt = 1;
      let attemptVariables: Record<string, unknown> = {
        "run.id": job.runId,
        ...secretVariables,
      };
      for (; attempt <= snapshot.suite.diagnosticRetries + 1; attempt += 1) {
        lastAttempt = attempt;
        attemptVariables = { "run.id": job.runId, ...secretVariables };
        await store.startCase(job.runId, item.runCaseId, attempt);
        attemptResult = await executeAttempt(
          job.runId,
          item.runCaseId,
          attempt,
          definition,
          snapshot,
          store,
          attemptVariables,
          caseController.signal,
        );
        if (attemptResult.result === "passed") {
          flaky = firstFailure !== null;
          break;
        }
        if (attemptResult.failure !== null && firstFailure === null)
          firstFailure = attemptResult.failure;
        if (attemptResult.result === "cancelled" || caseController.signal.aborted) break;
      }
      clearTimeout(caseTimeout);
      controller.signal.removeEventListener("abort", cancelCase);
      const cleanup = await executeCleanup(
        job.runId,
        item.runCaseId,
        lastAttempt,
        definition,
        snapshot,
        store,
        attemptVariables,
      );
      const executionResult: CaseResult = flaky ? "flaky" : attemptResult.result;
      const finalResult: CaseResult =
        cleanup.status === "failed" ? "infrastructure_failed" : executionResult;
      const finalFailure = firstFailure ?? attemptResult.failure ?? cleanup.failure;
      await store.finishCase(
        job.runId,
        item.runCaseId,
        finalResult,
        cleanup.status,
        finalFailure,
        caseStartedAt,
        flaky,
      );
      results.push(finalResult);
      if (finalFailure !== null) failures.push(finalFailure);
    }
    const summary = summarizeCaseResults(results);
    await store.setRunStatus(job.runId, "cleaning");
    await store.completeRun(
      job.runId,
      summary,
      gateResultForSummary(summary),
      choosePrimaryFailure(failures),
    );
    return { summary };
  } finally {
    clearInterval(poll);
    clearInterval(heartbeat);
  }
}
