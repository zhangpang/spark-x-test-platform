import type { ExecutorActionLevel } from "./base.js";

export {
  assertHttpTargetAllowed,
  ExecutorFailure,
  interpolateString,
  interpolateValue,
  type ExecutorActionLevel,
  type HttpExecutionEnvironment,
  type HttpTargetRule,
} from "./base.js";

export { executeHttpRequest, type HttpExecutionResult, type HttpStepParameters } from "./http.js";

export {
  executeJsonAssert,
  executeJsonExtract,
  type JsonAssertionOperator,
  type JsonAssertParameters,
  type JsonAssertResult,
  type JsonExtractParameters,
  type JsonExtractResult,
} from "./json.js";

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

export {
  executeWaitHttp,
  type WaitConditionOperator,
  type WaitHttpCondition,
  type WaitHttpParameters,
  type WaitHttpResult,
} from "./wait.js";
