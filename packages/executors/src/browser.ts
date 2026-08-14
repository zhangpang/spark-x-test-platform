import { mkdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { sanitizePlaywrightTraceArchive } from "@spark-x-test/reporting";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

import {
  assertHttpTargetAllowed,
  ExecutorFailure,
  interpolateString,
  type HttpExecutionEnvironment,
} from "./base.js";

export const browserActions = [
  "browser:navigate",
  "browser:click",
  "browser:fill",
  "browser:assert-text",
] as const;

export type BrowserAction = (typeof browserActions)[number];

export interface ExecutorArtifact {
  readonly kind: "screenshot" | "trace";
  readonly data: Uint8Array;
  readonly contentType: "image/png" | "application/zip";
  readonly extension: "png" | "zip";
}

export interface BrowserStepResult {
  readonly output: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly ExecutorArtifact[];
}

export interface BrowserExecutionSession {
  execute(
    action: BrowserAction,
    parameters: Readonly<Record<string, unknown>>,
    variables: Readonly<Record<string, unknown>>,
    options: Readonly<{
      stepId: string;
      timeoutMs: number;
      signal: AbortSignal;
      secrets: readonly string[];
    }>,
  ): Promise<BrowserStepResult>;
  close(): Promise<void>;
}

export type BrowserSessionFactory = (
  environment: HttpExecutionEnvironment,
) => Promise<BrowserExecutionSession>;

export class BrowserExecutorFailure extends ExecutorFailure {
  readonly artifacts: readonly ExecutorArtifact[];

  constructor(
    failure: ConstructorParameters<typeof ExecutorFailure>[0],
    artifacts: readonly ExecutorArtifact[] = [],
    cause?: unknown,
  ) {
    super(failure, cause);
    this.name = "BrowserExecutorFailure";
    this.artifacts = artifacts;
  }
}

function browserAction(value: string): BrowserAction {
  if (!browserActions.includes(value as BrowserAction)) {
    throw new ExecutorFailure({
      code: "BROWSER_ACTION_NOT_SUPPORTED",
      message: `Chromium 执行器不支持动作 ${value}。`,
      classification: "test_failed",
    });
  }
  return value as BrowserAction;
}

function stringParameter(
  parameters: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
  maximum = 4_000,
): string {
  const value = parameters[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ExecutorFailure({
      code: "INVALID_BROWSER_PARAMETERS",
      message: `浏览器参数 ${name} 缺失或超过安全长度。`,
      classification: "test_failed",
    });
  }
  return interpolateString(value, variables);
}

function assertBrowserActionLevel(
  action: BrowserAction,
  environment: HttpExecutionEnvironment,
): void {
  if (["browser:click", "browser:fill"].includes(action) && environment.actionLevel === "read") {
    throw new ExecutorFailure({
      code: "ACTION_LEVEL_EXCEEDED",
      message: `环境不允许执行 ${action} 写动作。`,
      classification: "test_failed",
    });
  }
}

function cancellationFailure(signal: AbortSignal, stepId: string): ExecutorFailure {
  const message = signal.reason instanceof Error ? signal.reason.message : "";
  const cancelled = ["Run cancellation requested", "Cancellation state unavailable"].includes(
    message,
  );
  return new ExecutorFailure({
    code: cancelled ? "EXECUTION_CANCELLED" : "BROWSER_TIMEOUT",
    message: cancelled ? "运行已取消。" : "浏览器步骤执行超时。",
    classification: "environment_failed",
    stepId,
  });
}

function internalBrowserUrl(value: string): boolean {
  return value === "about:blank" || value.startsWith("data:") || value.startsWith("blob:");
}

function traceDirectory(): string {
  const configured = process.env.PLAYWRIGHT_TRACE_TMPDIR?.trim();
  const directory = resolve(
    configured === undefined || configured === "" ? "/dev/shm/spark-x-test-traces" : configured,
  );
  if (process.env.NODE_ENV === "production" && !directory.startsWith("/dev/shm/")) {
    throw new Error("PLAYWRIGHT_TRACE_TMPDIR_MUST_USE_TMPFS");
  }
  return directory;
}

class PlaywrightBrowserSession implements BrowserExecutionSession {
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #environment: HttpExecutionEnvironment;
  #policyViolation: ExecutorFailure | null = null;
  #closed = false;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    environment: HttpExecutionEnvironment,
  ) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#environment = environment;
  }

  static async create(environment: HttpExecutionEnvironment): Promise<PlaywrightBrowserSession> {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        ignoreHTTPSErrors: false,
        javaScriptEnabled: true,
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      const session = new PlaywrightBrowserSession(
        browser,
        context,
        await context.newPage(),
        environment,
      );
      await session.#installSafetyRoutes();
      await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
      return session;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw new ExecutorFailure(
        {
          code: "CHROMIUM_START_FAILED",
          message: "Chromium 会话无法启动。",
          classification: "infrastructure_failed",
        },
        error,
      );
    }
  }

  async #installSafetyRoutes(): Promise<void> {
    await this.#context.route("**/*", async (route: Route) => {
      const value = route.request().url();
      if (internalBrowserUrl(value)) {
        await route.continue();
        return;
      }
      try {
        assertHttpTargetAllowed(new URL(value), this.#environment.allowlist);
        await route.continue();
      } catch (error) {
        this.#policyViolation =
          error instanceof ExecutorFailure
            ? error
            : new ExecutorFailure({
                code: "TARGET_NOT_ALLOWED",
                message: "浏览器请求目标不在当前环境白名单内。",
                classification: "test_failed",
              });
        await route.abort("blockedbyclient");
      }
    });
    await this.#context.routeWebSocket(/.*/, (webSocket) => {
      this.#policyViolation = new ExecutorFailure({
        code: "BROWSER_WEBSOCKET_FORBIDDEN",
        message: "当前 Chromium 执行器不允许建立 WebSocket 连接。",
        classification: "test_failed",
      });
      void webSocket.close({ code: 1008, reason: "Blocked by test environment policy" });
    });
    this.#page.on("download", (download) => {
      this.#policyViolation = new ExecutorFailure({
        code: "BROWSER_DOWNLOAD_FORBIDDEN",
        message: "当前 Chromium 执行器不允许下载文件。",
        classification: "test_failed",
      });
      void download.cancel();
    });
    this.#page.on("dialog", (dialog) => void dialog.dismiss());
    this.#page.on("popup", (popup) => {
      this.#policyViolation = new ExecutorFailure({
        code: "BROWSER_POPUP_FORBIDDEN",
        message: "当前 Chromium 执行器不允许打开弹窗页面。",
        classification: "test_failed",
      });
      void popup.close();
    });
  }

  #consumePolicyViolation(): ExecutorFailure | null {
    const violation = this.#policyViolation;
    this.#policyViolation = null;
    return violation;
  }

  async #performAction(
    action: BrowserAction,
    parameters: Readonly<Record<string, unknown>>,
    variables: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<Readonly<Record<string, unknown>>> {
    assertBrowserActionLevel(action, this.#environment);
    if (action === "browser:navigate") {
      const path = stringParameter(parameters, "path", variables);
      const target = new URL(path, this.#environment.baseUrl);
      assertHttpTargetAllowed(target, this.#environment.allowlist);
      const waitUntil = typeof parameters.waitUntil === "string" ? parameters.waitUntil : undefined;
      if (
        parameters.waitUntil !== undefined &&
        (waitUntil === undefined ||
          !["commit", "domcontentloaded", "load", "networkidle"].includes(waitUntil))
      ) {
        throw new ExecutorFailure({
          code: "INVALID_BROWSER_PARAMETERS",
          message: "浏览器 waitUntil 参数不合法。",
          classification: "test_failed",
        });
      }
      const response = await this.#page.goto(target.toString(), {
        timeout: timeoutMs,
        waitUntil: (waitUntil ?? "domcontentloaded") as
          | "commit"
          | "domcontentloaded"
          | "load"
          | "networkidle",
      });
      assertHttpTargetAllowed(new URL(this.#page.url()), this.#environment.allowlist);
      const status = response?.status() ?? null;
      const expectedStatus = parameters.expectedStatus;
      if (
        expectedStatus !== undefined &&
        (!Number.isInteger(expectedStatus) || expectedStatus !== status)
      ) {
        throw new ExecutorFailure({
          code: "BROWSER_STATUS_ASSERTION_FAILED",
          message: `页面状态码断言失败：期望 ${typeof expectedStatus === "number" ? expectedStatus : "无效值"}，实际 ${String(status)}。`,
          classification: "product_failed",
        });
      }
      return { url: this.#page.url(), title: await this.#page.title(), status };
    }
    const selector = stringParameter(parameters, "selector", variables);
    const locator = this.#page.locator(selector);
    if (action === "browser:click") {
      await locator.click({ timeout: timeoutMs });
      const current = this.#page.url();
      if (!internalBrowserUrl(current)) {
        assertHttpTargetAllowed(new URL(current), this.#environment.allowlist);
      }
      return { url: current, selector };
    }
    if (action === "browser:fill") {
      const value = stringParameter(parameters, "value", variables, 100_000);
      await locator.fill(value, { timeout: timeoutMs });
      return { url: this.#page.url(), selector, filled: true };
    }
    const expected = stringParameter(parameters, "text", variables, 100_000);
    const actual = (await locator.textContent({ timeout: timeoutMs })) ?? "";
    const exact = parameters.exact === true;
    if (exact ? actual !== expected : !actual.includes(expected)) {
      throw new ExecutorFailure({
        code: "BROWSER_TEXT_ASSERTION_FAILED",
        message: `页面文本断言失败：未找到${exact ? "精确" : "包含"}匹配文本。`,
        classification: "product_failed",
      });
    }
    return { url: this.#page.url(), selector, text: actual.slice(0, 2_000), exact };
  }

  async #captureScreenshot(secrets: readonly string[]): Promise<ExecutorArtifact> {
    const sensitiveFields = this.#page.locator(
      'input[type="password"], input[autocomplete*="password"], input[name*="token" i], input[name*="secret" i], textarea[name*="token" i], textarea[name*="secret" i]',
    );
    const mask = secrets.length > 0 ? [this.#page.locator("html")] : [sensitiveFields];
    return {
      kind: "screenshot",
      data: await this.#page.screenshot({
        animations: "disabled",
        caret: "hide",
        fullPage: false,
        mask,
        maskColor: "#101828",
        type: "png",
      }),
      contentType: "image/png",
      extension: "png",
    };
  }

  async #captureTrace(path: string, secrets: readonly string[]): Promise<ExecutorArtifact> {
    await this.#context.tracing.stopChunk({ path });
    try {
      return {
        kind: "trace",
        data: sanitizePlaywrightTraceArchive(await readFile(path), secrets),
        contentType: "application/zip",
        extension: "zip",
      };
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }

  async execute(
    actionValue: BrowserAction,
    parameters: Readonly<Record<string, unknown>>,
    variables: Readonly<Record<string, unknown>>,
    options: Readonly<{
      stepId: string;
      timeoutMs: number;
      signal: AbortSignal;
      secrets: readonly string[];
    }>,
  ): Promise<BrowserStepResult> {
    if (this.#closed) {
      throw new ExecutorFailure({
        code: "BROWSER_SESSION_CLOSED",
        message: "Chromium 会话已关闭。",
        classification: "infrastructure_failed",
        stepId: options.stepId,
      });
    }
    const action = browserAction(actionValue);
    this.#policyViolation = null;
    const directory = traceDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const tracePath = join(directory, `${randomUUID()}.zip`);
    await this.#context.tracing.startChunk({ title: `${options.stepId}:${action}` });
    const artifacts: ExecutorArtifact[] = [];
    let output: Readonly<Record<string, unknown>> | undefined;
    let actionError: unknown;
    let abort: (() => void) | undefined;
    try {
      output = await Promise.race([
        this.#performAction(action, parameters, variables, options.timeoutMs),
        new Promise<never>((_resolve, reject) => {
          abort = () => {
            void this.#page.close().catch(() => undefined);
            reject(cancellationFailure(options.signal, options.stepId));
          };
          options.signal.addEventListener("abort", abort, { once: true });
          if (options.signal.aborted) abort();
        }),
      ]);
      const policyViolation = this.#consumePolicyViolation();
      if (policyViolation !== null) {
        throw new ExecutorFailure(policyViolation.failure, policyViolation);
      }
    } catch (error) {
      const policyViolation = this.#consumePolicyViolation();
      actionError = options.signal.aborted
        ? cancellationFailure(options.signal, options.stepId)
        : (policyViolation ?? error);
    } finally {
      if (abort !== undefined) options.signal.removeEventListener("abort", abort);
      if (!this.#page.isClosed()) {
        try {
          artifacts.push(await this.#captureScreenshot(options.secrets));
        } catch (error) {
          actionError ??= new ExecutorFailure(
            {
              code: "SCREENSHOT_CAPTURE_FAILED",
              message: "浏览器截图生成失败。",
              classification: "infrastructure_failed",
              stepId: options.stepId,
            },
            error,
          );
        }
      }
      try {
        artifacts.push(await this.#captureTrace(tracePath, options.secrets));
      } catch (error) {
        await unlink(tracePath).catch(() => undefined);
        actionError ??= new ExecutorFailure(
          {
            code: "TRACE_REDACTION_FAILED",
            message: "Playwright Trace 无法安全脱敏并登记。",
            classification: "infrastructure_failed",
            stepId: options.stepId,
          },
          error,
        );
      }
    }
    if (actionError !== undefined) {
      const failure =
        actionError instanceof ExecutorFailure
          ? actionError.failure
          : {
              code: "BROWSER_EXECUTION_FAILED",
              message: "Chromium 步骤执行失败。",
              classification: "environment_failed" as const,
              stepId: options.stepId,
            };
      throw new BrowserExecutorFailure(failure, artifacts, actionError);
    }
    return {
      output: {
        ...(output ?? {}),
        screenshotRedaction: options.secrets.length > 0 ? "full_page_mask" : "sensitive_fields",
      },
      artifacts,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#context.tracing.stop().catch(() => undefined);
    await this.#context.close().catch(() => undefined);
    await this.#browser.close().catch(() => undefined);
  }
}

export async function createChromiumSession(
  environment: HttpExecutionEnvironment,
): Promise<BrowserExecutionSession> {
  return PlaywrightBrowserSession.create(environment);
}
