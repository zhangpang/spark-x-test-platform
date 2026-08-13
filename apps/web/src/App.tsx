import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import type { HealthResponse } from "@spark-x-test/contracts";

import {
  ApiError,
  controlPlaneApi,
  type ActionLevel,
  type EnvironmentRecord,
  type ModuleRecord,
  type SecretMetadata,
  type SystemRecord,
  type TestCaseRecord,
  type TestCaseVersionRecord,
  type TestRunDetail,
  type TestRunRecord,
  type TestSuiteRecord,
  type ValidationResult,
} from "./api.js";

const navigation = [
  { id: "assets", label: "系统与环境", milestone: "M2", group: "assets" },
  { id: "cases", label: "用例库", milestone: "M2", group: "assets" },
  { id: "suites", label: "测试套件", milestone: "M2", group: "assets" },
  { id: "shared", label: "公共资产", milestone: "M2", group: "assets" },
  { id: "runs", label: "运行中心", milestone: "M3", group: "execution" },
  { id: "plans", label: "定时计划", milestone: "M5", group: "execution" },
] as const;

type PageId = (typeof navigation)[number]["id"];
type Readiness = HealthResponse | { status: "loading" | "unreachable"; message?: string };
type Notice = Readonly<{ tone: "success" | "error" | "info"; text: string }>;

const pageDetails: Record<
  PageId,
  Readonly<{ eyebrow: string; title: string; description: string }>
> = {
  assets: {
    eyebrow: "CONTROL PLANE · 01",
    title: "系统与环境",
    description: "统一登记被测系统、业务模块、访问边界与密钥引用。",
  },
  cases: {
    eyebrow: "CONTROL PLANE · 02",
    title: "用例库",
    description: "用结构化 Schema 管理可审计、可比较、可回滚的测试用例。",
  },
  suites: {
    eyebrow: "CONTROL PLANE · 03",
    title: "测试套件",
    description: "将已发布用例编排为可复用的业务回归集合。",
  },
  shared: {
    eyebrow: "CONTROL PLANE · 04",
    title: "公共资产",
    description: "跨系统复用的数据、步骤与断言资产。",
  },
  runs: {
    eyebrow: "EXECUTION · 01",
    title: "运行中心",
    description: "查看执行进度、诊断证据与回归结果。",
  },
  plans: {
    eyebrow: "EXECUTION · 02",
    title: "定时计划",
    description: "维护周期性回归策略与触发计划。",
  },
};

function NavigationIcon({ id }: Readonly<{ id: PageId }>) {
  const paths: Record<PageId, readonly string[]> = {
    assets: ["M4 5h16v5H4z", "M4 14h7v6H4z", "M15 14h5v6h-5z"],
    cases: ["M6 3h9l4 4v14H6z", "M15 3v5h4", "M9 12h6", "M9 16h6"],
    suites: ["M5 4h14v16H5z", "M8 8h8", "M8 12h8", "M8 16h5"],
    shared: [
      "M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
      "M16 20a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
      "M11 9l2 6",
    ],
    runs: ["M12 3a9 9 0 1 0 9 9", "M12 7v5l3 2", "M17 3h4v4"],
    plans: ["M5 4h14v16H5z", "M8 2v4", "M16 2v4", "M5 9h14", "M8 13h3", "M8 17h6"],
  };

  return (
    <svg aria-hidden="true" className="nav-icon" fill="none" viewBox="0 0 24 24">
      {paths[id].map((path) => (
        <path d={path} key={path} />
      ))}
    </svg>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.requestId === undefined ? "" : `（请求 ${error.requestId}）`}`;
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function systemKey(systems: readonly SystemRecord[], id: string): string {
  return systems.find((system) => system.id === id)?.key ?? "";
}

function moduleKey(modules: readonly ModuleRecord[], id: string): string {
  return modules.find((module) => module.id === id)?.key ?? "";
}

function formString(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
}

const runStatusLabels: Readonly<Record<TestRunRecord["status"], string>> = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  cancelling: "取消中",
  cleaning: "清理中",
  interrupted: "已中断",
  compensation_pending: "待补偿",
  completed: "已完成",
};

const caseResultLabels = {
  passed: "通过",
  product_failed: "产品失败",
  test_failed: "用例失败",
  environment_failed: "环境失败",
  infrastructure_failed: "基础设施失败",
  flaky: "不稳定",
  cancelled: "已取消",
  skipped: "已跳过",
} as const;

function runProgress(run: TestRunRecord): number {
  if (run.summary.total === 0) return 0;
  const finished =
    run.summary.passed +
    run.summary.productFailed +
    run.summary.testFailed +
    run.summary.environmentFailed +
    run.summary.infrastructureFailed +
    run.summary.flaky +
    run.summary.cancelled +
    run.summary.skipped;
  return Math.round((finished / run.summary.total) * 100);
}

function elapsed(run: TestRunRecord): string {
  const start = new Date(run.startedAt ?? run.queuedAt).getTime();
  const end = run.finishedAt === null ? Date.now() : new Date(run.finishedAt).getTime();
  const seconds = Math.max(0, Math.round((end - start) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function buildHttpDefinition(
  input: Readonly<{
    name: string;
    systemKey: string;
    moduleKey: string;
    method: string;
    path: string;
    expectedStatus: number;
    actionLevel: ActionLevel;
    secretRef?: string;
    cleanupMethod?: string;
    cleanupPath?: string;
  }>,
): Readonly<Record<string, unknown>> {
  const headers =
    input.secretRef === undefined ? undefined : { Authorization: "Bearer ${case.auth-token}" };
  const requiresCleanup = input.actionLevel !== "read";
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: input.name,
      systemKey: input.systemKey,
      moduleKey: input.moduleKey,
      priority: "P1",
      classification: "blackbox",
      actionLevel: input.actionLevel,
      tags: ["http", "regression"],
    },
    inputs:
      input.secretRef === undefined
        ? []
        : [{ name: "auth-token", type: "string", required: true, secretRef: input.secretRef }],
    execution: { stepTimeoutMs: 30_000, caseTimeoutMs: 120_000, diagnosticRetries: 0 },
    resourceLocks: [],
    steps: [
      {
        id: "request",
        name: `${input.method} ${input.path}`,
        kind: "action",
        action: "http:request",
        params: {
          method: input.method,
          path: input.path,
          ...(headers === undefined ? {} : { headers }),
        },
        capture: { "response-status": "$.status", "response-body": "$.body" },
        assertions: [
          {
            type: "status:equals",
            actual: "${step.response-status}",
            expected: input.expectedStatus,
            severity: "hard",
          },
        ],
      },
    ],
    finally: requiresCleanup
      ? [
          {
            id: "cleanup",
            name: "清理测试写入",
            kind: "action",
            action: "http:request",
            params: { method: input.cleanupMethod, path: input.cleanupPath },
          },
        ]
      : [],
  };
}

export function App() {
  const [page, setPage] = useState<PageId>("assets");
  const [readiness, setReadiness] = useState<Readiness>({ status: "loading" });
  const [systems, setSystems] = useState<readonly SystemRecord[]>([]);
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [modules, setModules] = useState<readonly ModuleRecord[]>([]);
  const [environments, setEnvironments] = useState<readonly EnvironmentRecord[]>([]);
  const [cases, setCases] = useState<readonly TestCaseRecord[]>([]);
  const [secrets, setSecrets] = useState<readonly SecretMetadata[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [versions, setVersions] = useState<readonly TestCaseVersionRecord[]>([]);
  const [suites, setSuites] = useState<readonly TestSuiteRecord[]>([]);
  const [runs, setRuns] = useState<readonly TestRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState<TestRunDetail>();
  const [validation, setValidation] = useState<ValidationResult>();
  const [comparison, setComparison] = useState<
    readonly Readonly<{ path: string; before?: unknown; after?: unknown }>[]
  >([]);
  const [method, setMethod] = useState("GET");
  const [cleanupMethod, setCleanupMethod] = useState("POST");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>({
    tone: "info",
    text: "请选择或创建一个被测系统。",
  });

  const selectedCase = useMemo(
    () => cases.find((testCase) => testCase.id === selectedCaseId),
    [cases, selectedCaseId],
  );
  const publishedCases = cases.filter((testCase) => testCase.currentPublishedVersionId !== null);
  const scopedSuites = suites.filter((suite) => suite.systemId === selectedSystemId);
  const scopedSecrets = secrets.filter((secret) => secret.systemId === selectedSystemId);
  const requiresCleanup = !["GET", "HEAD", "OPTIONS"].includes(method);

  async function perform<T>(success: string, operation: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    try {
      const result = await operation();
      setNotice({ tone: "success", text: success });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function refreshSystems(preferredId?: string): Promise<void> {
    const loaded = await controlPlaneApi.listSystems();
    setSystems(loaded);
    setSelectedSystemId(
      (current) => preferredId ?? (current === "" ? (loaded[0]?.id ?? "") : current),
    );
  }

  async function refreshSystemAssets(systemId: string): Promise<void> {
    const [loadedModules, loadedEnvironments, loadedCases] = await Promise.all([
      controlPlaneApi.listModules(systemId),
      controlPlaneApi.listEnvironments(systemId),
      controlPlaneApi.listCases(systemId),
    ]);
    setModules(loadedModules);
    setEnvironments(loadedEnvironments);
    setCases(loadedCases);
    setSelectedCaseId((current) =>
      loadedCases.some((testCase) => testCase.id === current)
        ? current
        : (loadedCases[0]?.id ?? ""),
    );
  }

  async function refreshSuites(): Promise<void> {
    setSuites(await controlPlaneApi.listSuites());
  }

  async function refreshSecrets(): Promise<void> {
    setSecrets(await controlPlaneApi.listSecrets());
  }

  const refreshRuns = useCallback(
    async (preferredId?: string): Promise<void> => {
      if (selectedSystemId === "") {
        setRuns([]);
        setSelectedRunId("");
        setSelectedRun(undefined);
        return;
      }
      const loaded = await controlPlaneApi.listRuns(selectedSystemId);
      setRuns(loaded);
      setSelectedRunId((current) => {
        const candidate = preferredId ?? current;
        return loaded.some((run) => run.id === candidate) ? candidate : (loaded[0]?.id ?? "");
      });
    },
    [selectedSystemId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/v1/readyz", { signal: controller.signal }).then(async (response) => {
        setReadiness((await response.json()) as HealthResponse);
      }),
      refreshSystems(),
      refreshSuites(),
      refreshSecrets(),
    ]).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setReadiness({ status: "unreachable", message: errorMessage(error) });
        setNotice({ tone: "error", text: errorMessage(error) });
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedSystemId === "") {
      setModules([]);
      setEnvironments([]);
      setCases([]);
      return;
    }
    void refreshSystemAssets(selectedSystemId).catch((error: unknown) =>
      setNotice({ tone: "error", text: errorMessage(error) }),
    );
  }, [selectedSystemId]);

  useEffect(() => {
    if (selectedCaseId === "") {
      setVersions([]);
      return;
    }
    void controlPlaneApi
      .listCaseVersions(selectedCaseId)
      .then(setVersions)
      .catch((error: unknown) => setNotice({ tone: "error", text: errorMessage(error) }));
  }, [selectedCaseId]);

  useEffect(() => {
    void refreshRuns().catch((error: unknown) =>
      setNotice({ tone: "error", text: errorMessage(error) }),
    );
  }, [refreshRuns]);

  useEffect(() => {
    if (selectedRunId === "") {
      setSelectedRun(undefined);
      return;
    }
    let active = true;
    const refresh = async () => {
      const detail = await controlPlaneApi.getRun(selectedRunId);
      if (active) setSelectedRun(detail);
      await refreshRuns(selectedRunId);
    };
    void refresh().catch((error: unknown) =>
      setNotice({ tone: "error", text: errorMessage(error) }),
    );
    const unsubscribe = controlPlaneApi.subscribeRunEvents(selectedRunId, () => {
      void refresh().catch((error: unknown) =>
        setNotice({ tone: "error", text: errorMessage(error) }),
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refreshRuns, selectedRunId]);

  async function createSystem(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const created = await perform("系统已创建。", () =>
      controlPlaneApi.createSystem({
        key: data.get("key"),
        name: data.get("name"),
        description: data.get("description"),
        concurrencyLimit: Number(data.get("concurrencyLimit")),
      }),
    );
    if (created !== undefined) {
      form.reset();
      await refreshSystems(created.id);
    }
  }

  async function createModule(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedSystemId === "") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const created = await perform("模块已创建。", () =>
      controlPlaneApi.createModule(selectedSystemId, {
        key: data.get("key"),
        name: data.get("name"),
        sortOrder: modules.length,
      }),
    );
    if (created !== undefined) {
      form.reset();
      await refreshSystemAssets(selectedSystemId);
    }
  }

  async function createEnvironment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedSystemId === "") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const baseUrl = formString(data, "baseUrl");
    let target: URL;
    try {
      target = new URL(baseUrl);
    } catch {
      setNotice({ tone: "error", text: "baseUrl 不是有效 URL。" });
      return;
    }
    const created = await perform("环境和目标白名单已创建。", () =>
      controlPlaneApi.createEnvironment(selectedSystemId, {
        key: data.get("key"),
        name: data.get("name"),
        kind: data.get("kind"),
        baseUrl,
        actionLevel: data.get("actionLevel"),
        allowlist: [
          {
            protocol: target.protocol.slice(0, -1),
            host: target.hostname,
            ports: [Number(target.port || (target.protocol === "https:" ? 443 : 80))],
            pathPrefixes: [target.pathname || "/"],
          },
        ],
        timezone: "Asia/Shanghai",
        concurrencyLimit: Number(data.get("concurrencyLimit")),
      }),
    );
    if (created !== undefined) {
      form.reset();
      await refreshSystemAssets(selectedSystemId);
    }
  }

  async function createCase(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedSystemId === "") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const moduleId = formString(data, "moduleId");
    const actionLevel: ActionLevel =
      method === "DELETE" || cleanupMethod === "DELETE"
        ? "dangerous"
        : requiresCleanup
          ? "write"
          : "read";
    const secretRef = formString(data, "secretRef").trim();
    const definition = buildHttpDefinition({
      name: formString(data, "name"),
      systemKey: systemKey(systems, selectedSystemId),
      moduleKey: moduleKey(modules, moduleId),
      method,
      path: formString(data, "path"),
      expectedStatus: Number(data.get("expectedStatus")),
      actionLevel,
      ...(secretRef === "" ? {} : { secretRef }),
      ...(requiresCleanup
        ? {
            cleanupMethod,
            cleanupPath: formString(data, "cleanupPath"),
          }
        : {}),
    });
    const created = await perform("HTTP 用例草稿已创建。", () =>
      controlPlaneApi.createCase(moduleId, definition),
    );
    if (created !== undefined) {
      setSelectedCaseId(created.id);
      setValidation(undefined);
      form.reset();
      setMethod("GET");
      setCleanupMethod("POST");
      await refreshSystemAssets(selectedSystemId);
    }
  }

  async function upsertSecret(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedSystemId === "") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const environmentId = formString(data, "environmentId");
    const result = await perform("密钥已加密保存；页面不会回显密钥值。", () =>
      controlPlaneApi.upsertSecret({
        systemId: selectedSystemId,
        ...(environmentId === "" ? {} : { environmentId }),
        key: data.get("key"),
        value: data.get("value"),
      }),
    );
    if (result !== undefined) {
      form.reset();
      await refreshSecrets();
    }
  }

  async function validateLatest(): Promise<void> {
    const version = versions[0];
    if (version === undefined) return;
    const environmentId = environments[0]?.id;
    const result = await perform("静态校验已完成。", () =>
      controlPlaneApi.validateVersion(version.id, environmentId),
    );
    if (result !== undefined) setValidation(result);
  }

  async function publishLatest(): Promise<void> {
    const version = versions[0];
    if (version === undefined || selectedCase === undefined) return;
    const result = await perform("用例版本已发布。", () =>
      controlPlaneApi.publishCase(selectedCase.id, version.id),
    );
    if (result !== undefined) {
      await Promise.all([refreshSystemAssets(selectedSystemId), refreshSuites()]);
      setVersions(await controlPlaneApi.listCaseVersions(selectedCase.id));
    }
  }

  async function rollback(sourceVersionId: string): Promise<void> {
    if (selectedCase === undefined) return;
    const result = await perform("历史版本已恢复为新的草稿版本。", () =>
      controlPlaneApi.rollbackCase(selectedCase.id, sourceVersionId),
    );
    if (result !== undefined) {
      setVersions(await controlPlaneApi.listCaseVersions(selectedCase.id));
      await refreshSystemAssets(selectedSystemId);
    }
  }

  async function compare(sourceVersionId: string): Promise<void> {
    const latest = versions[0];
    if (latest === undefined || selectedCase === undefined) return;
    const changes = await perform("版本比较已完成。", () =>
      controlPlaneApi.compareVersions(selectedCase.id, sourceVersionId, latest.id),
    );
    if (changes !== undefined) setComparison(changes);
  }

  async function exportSelected(): Promise<void> {
    if (selectedCase === undefined) return;
    const blob = await perform("用例导出已生成。", () =>
      controlPlaneApi.exportCases([selectedCase.id], "json"),
    );
    if (blob === undefined) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedCase.name}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importBundle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedSystemId === "") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("bundle");
    if (!(file instanceof File) || file.size === 0) {
      setNotice({ tone: "error", text: "请选择 JSON 或 YAML 导出包。" });
      return;
    }
    const format = file.name.endsWith(".yaml") || file.name.endsWith(".yml") ? "yaml" : "json";
    const result = await perform("导入包已校验并创建草稿。", async () =>
      controlPlaneApi.importCases(selectedSystemId, format, await file.text(), "create_drafts"),
    );
    if (result !== undefined) {
      setValidation(result);
      if (result.valid) await refreshSystemAssets(selectedSystemId);
    }
  }

  async function createSuite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedSystemId === "") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await perform("测试套件已创建。", () =>
      controlPlaneApi.createSuite({
        systemId: selectedSystemId,
        key: data.get("key"),
        name: data.get("name"),
        description: data.get("description"),
        caseIds: data.getAll("caseIds"),
        defaultConcurrency: Number(data.get("defaultConcurrency")),
        defaultDiagnosticRetries: Number(data.get("defaultDiagnosticRetries")),
      }),
    );
    if (result !== undefined) {
      form.reset();
      await refreshSuites();
    }
  }

  async function createRun(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedSystemId === "") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const created = await perform("回归运行已创建，正在等待 Worker。", () =>
      controlPlaneApi.createRun({
        triggerType: "manual",
        triggerSource: "web-console",
        idempotencyKey: crypto.randomUUID(),
        priority: Number(data.get("priority")),
        systemId: selectedSystemId,
        environmentId: data.get("environmentId"),
        suiteId: data.get("suiteId"),
        testedVersion: data.get("testedVersion"),
      }),
    );
    if (created !== undefined) {
      setSelectedRunId(created.id);
      await refreshRuns(created.id);
    }
  }

  async function cancelSelectedRun(): Promise<void> {
    if (selectedRunId === "") return;
    const cancelled = await perform("取消请求已提交，Worker 将进入清理阶段。", () =>
      controlPlaneApi.cancelRun(selectedRunId),
    );
    if (cancelled !== undefined) await refreshRuns(selectedRunId);
  }

  const overviewMetrics =
    page === "assets"
      ? [
          { label: "被测系统", value: systems.length, caption: "已登记" },
          { label: "业务模块", value: modules.length, caption: "当前系统" },
          { label: "可用环境", value: environments.length, caption: "受白名单保护" },
          { label: "密钥引用", value: scopedSecrets.length, caption: "只显示元数据" },
        ]
      : page === "cases"
        ? [
            { label: "全部用例", value: cases.length, caption: "当前系统" },
            { label: "已发布", value: publishedCases.length, caption: "可进入套件" },
            {
              label: "草稿用例",
              value: cases.filter((testCase) => testCase.status === "draft").length,
              caption: "等待校验",
            },
            { label: "版本记录", value: versions.length, caption: "当前选中用例" },
          ]
        : page === "runs"
          ? [
              { label: "全部运行", value: runs.length, caption: "当前系统" },
              {
                label: "执行中",
                value: runs.filter((run) => run.status !== "completed").length,
                caption: "实时更新",
              },
              {
                label: "门禁通过",
                value: runs.filter((run) => run.gateResult === "passed").length,
                caption: "最近 200 次",
              },
              {
                label: "门禁阻断",
                value: runs.filter((run) => run.gateResult === "blocked").length,
                caption: "需处理",
              },
            ]
          : [
              { label: "测试套件", value: suites.length, caption: "已编排" },
              { label: "可选用例", value: publishedCases.length, caption: "已发布" },
              { label: "全部用例", value: cases.length, caption: "当前系统" },
              { label: "业务模块", value: modules.length, caption: "覆盖范围" },
            ];

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar" aria-label="平台导航">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>Spark X</strong>
            <small>自动化测试平台</small>
          </span>
        </div>
        <nav className="sidebar-nav">
          {[
            { id: "assets", label: "资产控制" },
            { id: "execution", label: "执行调度" },
          ].map((group) => (
            <section key={group.id}>
              <p className="nav-group-label">{group.label}</p>
              {navigation
                .filter((item) => item.group === group.id)
                .map((item, index) => {
                  const enabled = ["assets", "cases", "suites", "runs"].includes(item.id);
                  return (
                    <button
                      aria-current={page === item.id ? "page" : undefined}
                      className={page === item.id ? "active" : ""}
                      disabled={!enabled}
                      key={item.id}
                      onClick={() => setPage(item.id)}
                      type="button"
                    >
                      <NavigationIcon id={item.id} />
                      <span className="nav-copy">
                        <b>{item.label}</b>
                        <small>
                          {enabled
                            ? `0${index + 1} · ${item.milestone}`
                            : `${item.milestone} 即将开放`}
                        </small>
                      </span>
                      <span className="nav-arrow" aria-hidden="true">
                        →
                      </span>
                    </button>
                  );
                })}
            </section>
          ))}
        </nav>
        <div className="sidebar-footnote">
          <span className="live-indicator" aria-hidden="true" />
          <span>
            <small>PRIVATE NETWORK</small>
            <strong>{readiness.status === "ok" ? "测试环境在线" : "正在检查服务"}</strong>
          </span>
        </div>
      </aside>

      <div className="app-surface">
        <header className="topbar">
          <div className="breadcrumb" aria-label="当前位置">
            <span>测试控制台</span>
            <i aria-hidden="true">/</i>
            <strong>{pageDetails[page].title}</strong>
          </div>
          <div className="topbar-actions">
            <span className="release-chip">
              {page === "runs" ? "M3 · EXECUTION LOOP" : "M2 · ASSET PLANE"}
            </span>
            <div className={`status-pill status-${readiness.status}`} role="status">
              <span aria-hidden="true" />
              {readiness.status === "ok"
                ? "服务正常"
                : readiness.status === "loading"
                  ? "正在检查"
                  : "服务异常"}
            </div>
          </div>
        </header>

        <main id="main-content">
          <section className="page-heading">
            <div className="page-title-block">
              <p className="eyebrow">{pageDetails[page].eyebrow}</p>
              <div className="title-line">
                <h2>{pageDetails[page].title}</h2>
                <span>ONLINE</span>
              </div>
              <p>{pageDetails[page].description}</p>
            </div>
            <label className="system-switcher">
              <span>当前被测系统</span>
              <select
                disabled={systems.length === 0}
                onChange={(event) => setSelectedSystemId(event.target.value)}
                value={selectedSystemId}
              >
                {systems.length === 0 ? <option value="">尚未创建系统</option> : null}
                {systems.map((system) => (
                  <option key={system.id} value={system.id}>
                    {system.name} · {system.key}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="overview-strip" aria-label="资产概览">
            {overviewMetrics.map((metric, index) => (
              <article key={metric.label}>
                <span className="metric-index">0{index + 1}</span>
                <div>
                  <strong>{metric.value}</strong>
                  <span>{metric.label}</span>
                </div>
                <small>{metric.caption}</small>
              </article>
            ))}
          </section>

          <div aria-atomic="true" aria-live="polite" className={`notice notice-${notice.tone}`}>
            <span className="notice-symbol" aria-hidden="true" />
            <span>{busy ? "正在处理…" : notice.text}</span>
          </div>

          {page === "assets" ? (
            <section className="panel-grid">
              <article className="panel">
                <div className="panel-title">
                  <div>
                    <span className="step-number">01</span>
                    <h3>登记被测系统</h3>
                  </div>
                  <span className="count">{systems.length}</span>
                </div>
                <form className="form-stack" onSubmit={(event) => void createSystem(event)}>
                  <label>
                    系统标识
                    <input name="key" pattern="[a-z][a-z0-9-]+" placeholder="my-product" required />
                  </label>
                  <label>
                    显示名称
                    <input name="name" placeholder="我的业务系统" required />
                  </label>
                  <label>
                    说明
                    <textarea name="description" placeholder="该系统的测试范围" rows={2} />
                  </label>
                  <label>
                    并发上限
                    <input
                      defaultValue="5"
                      max="100"
                      min="1"
                      name="concurrencyLimit"
                      type="number"
                    />
                  </label>
                  <button className="primary" disabled={busy} type="submit">
                    创建系统
                  </button>
                </form>
              </article>

              <article className="panel">
                <div className="panel-title">
                  <div>
                    <span className="step-number">02</span>
                    <h3>划分业务模块</h3>
                  </div>
                  <span className="count">{modules.length}</span>
                </div>
                <form className="form-stack" onSubmit={(event) => void createModule(event)}>
                  <label>
                    模块标识
                    <input
                      disabled={selectedSystemId === ""}
                      name="key"
                      placeholder="order"
                      required
                    />
                  </label>
                  <label>
                    模块名称
                    <input
                      disabled={selectedSystemId === ""}
                      name="name"
                      placeholder="订单中心"
                      required
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || selectedSystemId === ""}
                    type="submit"
                  >
                    创建模块
                  </button>
                </form>
                <ul className="compact-list">
                  {modules.map((module) => (
                    <li key={module.id}>
                      <strong>{module.name}</strong>
                      <code>{module.key}</code>
                    </li>
                  ))}
                </ul>
              </article>

              <article className="panel panel-wide">
                <div className="panel-title">
                  <div>
                    <span className="step-number">03</span>
                    <h3>配置环境与目标白名单</h3>
                  </div>
                  <span className="count">{environments.length}</span>
                </div>
                <form className="form-grid" onSubmit={(event) => void createEnvironment(event)}>
                  <label>
                    环境标识
                    <input name="key" placeholder="test" required />
                  </label>
                  <label>
                    环境名称
                    <input name="name" placeholder="集成测试环境" required />
                  </label>
                  <label>
                    类型
                    <select defaultValue="test" name="kind">
                      <option value="test">测试</option>
                      <option value="staging">预发布</option>
                      <option value="production">生产（只读）</option>
                    </select>
                  </label>
                  <label>
                    最高动作等级
                    <select defaultValue="write" name="actionLevel">
                      <option value="read">read</option>
                      <option value="write">write</option>
                      <option value="dangerous">dangerous</option>
                    </select>
                  </label>
                  <label className="span-2">
                    Base URL（自动生成协议、主机、端口和路径白名单）
                    <input
                      name="baseUrl"
                      placeholder="http://test.example.internal/api/"
                      required
                      type="url"
                    />
                  </label>
                  <label>
                    环境并发
                    <input
                      defaultValue="5"
                      max="100"
                      min="1"
                      name="concurrencyLimit"
                      type="number"
                    />
                  </label>
                  <button
                    className="primary align-end"
                    disabled={busy || selectedSystemId === ""}
                    type="submit"
                  >
                    保存环境
                  </button>
                </form>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>环境</th>
                        <th>目标</th>
                        <th>动作等级</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {environments.map((environment) => (
                        <tr key={environment.id}>
                          <td>{environment.name}</td>
                          <td>
                            <code>{environment.baseUrl}</code>
                          </td>
                          <td>{environment.actionLevel}</td>
                          <td>
                            <span className={`tag tag-${environment.status}`}>
                              {environment.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="panel panel-wide">
                <div className="panel-title">
                  <div>
                    <span className="step-number">04</span>
                    <h3>登记密钥引用</h3>
                  </div>
                  <span className="count">{scopedSecrets.length}</span>
                </div>
                <p className="helper">
                  密钥值经 AES-256-GCM 加密后写入数据库；API、审计和页面只返回引用元数据。
                </p>
                <form className="form-grid" onSubmit={(event) => void upsertSecret(event)}>
                  <label>
                    引用名
                    <input
                      name="key"
                      pattern="[a-z][a-z0-9_.-]+"
                      placeholder="order-api-token"
                      required
                    />
                  </label>
                  <label>
                    作用环境
                    <select defaultValue="" name="environmentId">
                      <option value="">系统级（所有环境）</option>
                      {environments.map((environment) => (
                        <option key={environment.id} value={environment.id}>
                          {environment.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="span-2">
                    密钥值（保存后立即清空且永不回显）
                    <input autoComplete="new-password" name="value" required type="password" />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || selectedSystemId === ""}
                    type="submit"
                  >
                    加密保存 / 轮换
                  </button>
                </form>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>引用名</th>
                        <th>作用域</th>
                        <th>版本</th>
                        <th>最后轮换</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scopedSecrets.map((secret) => (
                        <tr key={secret.id}>
                          <td>
                            <code>{secret.key}</code>
                          </td>
                          <td>
                            {secret.environmentId === null
                              ? "系统级"
                              : (environments.find((item) => item.id === secret.environmentId)
                                  ?.name ?? "环境级")}
                          </td>
                          <td>v{secret.version}</td>
                          <td>{new Date(secret.updatedAt).toLocaleString("zh-CN")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </section>
          ) : null}

          {page === "cases" ? (
            <section className="case-layout">
              <article className="panel editor-panel">
                <div className="panel-title">
                  <div>
                    <span className="step-number">HTTP</span>
                    <h3>Schema 驱动用例编辑器</h3>
                  </div>
                </div>
                <p className="helper">目标主机来自环境；编辑器只接受相对路径，密钥只填写引用名。</p>
                <form className="form-stack" onSubmit={(event) => void createCase(event)}>
                  <label>
                    业务模块
                    <select name="moduleId" required>
                      <option value="">选择模块</option>
                      {modules.map((module) => (
                        <option key={module.id} value={module.id}>
                          {module.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    用例名称
                    <input name="name" placeholder="订单详情接口返回成功" required />
                  </label>
                  <div className="inline-fields">
                    <label>
                      方法
                      <select
                        name="method"
                        onChange={(event) => setMethod(event.target.value)}
                        value={method}
                      >
                        {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grow">
                      相对路径
                      <input name="path" pattern="/.*" placeholder="/orders/health" required />
                    </label>
                  </div>
                  <div className="inline-fields">
                    <label>
                      预期状态码
                      <input
                        defaultValue="200"
                        max="599"
                        min="100"
                        name="expectedStatus"
                        required
                        type="number"
                      />
                    </label>
                    <label className="grow">
                      可选密钥引用
                      <input name="secretRef" placeholder="order-api-token（不填明文）" />
                    </label>
                  </div>
                  {requiresCleanup ? (
                    <fieldset>
                      <legend>写入用例清理步骤</legend>
                      <div className="inline-fields">
                        <label>
                          清理方法
                          <select
                            name="cleanupMethod"
                            onChange={(event) => setCleanupMethod(event.target.value)}
                            value={cleanupMethod}
                          >
                            <option value="POST">POST</option>
                            <option value="DELETE">DELETE（需要 dangerous 环境）</option>
                          </select>
                        </label>
                        <label className="grow">
                          清理路径
                          <input
                            name="cleanupPath"
                            pattern="/.*"
                            placeholder="/orders/${step.createdId}"
                            required
                          />
                        </label>
                      </div>
                    </fieldset>
                  ) : null}
                  <button className="primary" disabled={busy || modules.length === 0} type="submit">
                    创建不可变草稿 v1
                  </button>
                </form>
                <form className="import-box" onSubmit={(event) => void importBundle(event)}>
                  <label>
                    导入平台用例包
                    <input accept=".json,.yaml,.yml" name="bundle" type="file" />
                  </label>
                  <button
                    className="secondary"
                    disabled={busy || selectedSystemId === ""}
                    type="submit"
                  >
                    校验并创建草稿
                  </button>
                </form>
              </article>

              <article className="panel library-panel">
                <div className="panel-title">
                  <div>
                    <span className="step-number">LIB</span>
                    <h3>用例与版本历史</h3>
                  </div>
                  <span className="count">{cases.length}</span>
                </div>
                <div className="case-list">
                  {cases.map((testCase) => (
                    <button
                      className={testCase.id === selectedCaseId ? "selected" : ""}
                      key={testCase.id}
                      onClick={() => {
                        setSelectedCaseId(testCase.id);
                        setComparison([]);
                        setValidation(undefined);
                      }}
                      type="button"
                    >
                      <span>
                        <strong>{testCase.name}</strong>
                        <small>{testCase.id.slice(0, 8)}</small>
                      </span>
                      <span className={`tag tag-${testCase.status}`}>{testCase.status}</span>
                    </button>
                  ))}
                  {cases.length === 0 ? (
                    <p className="empty">还没有用例，请从左侧编辑器创建。</p>
                  ) : null}
                </div>

                {selectedCase !== undefined ? (
                  <div className="version-detail">
                    <div className="action-row">
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void validateLatest()}
                        type="button"
                      >
                        校验最新草稿
                      </button>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void publishLatest()}
                        type="button"
                      >
                        发布最新草稿
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void exportSelected()}
                        type="button"
                      >
                        导出 JSON
                      </button>
                    </div>
                    {validation !== undefined ? (
                      <div
                        className={`validation validation-${validation.valid ? "valid" : "invalid"}`}
                      >
                        <strong>{validation.valid ? "校验通过" : "校验失败"}</strong>
                        {validation.issues.length === 0 ? (
                          <p>Schema、目标和密钥规则均通过。</p>
                        ) : null}
                        <ul>
                          {validation.issues.map((issue) => (
                            <li key={`${issue.code}-${issue.path}`}>
                              <code>{issue.path}</code> {issue.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <ol className="version-list">
                      {versions.map((version, index) => (
                        <li key={version.id}>
                          <div>
                            <strong>v{version.version}</strong>
                            <small>{new Date(version.createdAt).toLocaleString("zh-CN")}</small>
                            {version.publishedAt === null ? null : (
                              <span className="tag tag-published">已发布</span>
                            )}
                          </div>
                          <code>{version.contentHash.slice(0, 12)}</code>
                          <div className="row-actions">
                            {index === 0 ? null : (
                              <button onClick={() => void compare(version.id)} type="button">
                                与最新比较
                              </button>
                            )}
                            <button
                              disabled={busy}
                              onClick={() => void rollback(version.id)}
                              type="button"
                            >
                              恢复为新草稿
                            </button>
                          </div>
                        </li>
                      ))}
                    </ol>
                    {comparison.length > 0 ? (
                      <div className="diff-list">
                        <h4>版本差异</h4>
                        {comparison.slice(0, 20).map((change) => (
                          <div key={change.path}>
                            <code>{change.path}</code>
                            <span>
                              {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </section>
          ) : null}

          {page === "runs" ? (
            <section className="run-center-layout">
              <article className="panel launch-panel">
                <div className="panel-title">
                  <div>
                    <span className="step-number">RUN</span>
                    <h3>一键发起回归</h3>
                  </div>
                  <span className="count">HTTP</span>
                </div>
                <p className="helper">
                  创建运行时固定当前已发布用例版本；执行期间的资产修改不会改变本次结果。
                </p>
                <form className="form-stack" onSubmit={(event) => void createRun(event)}>
                  <label>
                    目标环境
                    <select name="environmentId" required>
                      <option value="">选择受控环境</option>
                      {environments
                        .filter((environment) => environment.status === "active")
                        .map((environment) => (
                          <option key={environment.id} value={environment.id}>
                            {environment.name} · {environment.actionLevel}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    测试套件
                    <select name="suiteId" required>
                      <option value="">选择测试套件</option>
                      {scopedSuites.map((suite) => (
                        <option key={suite.id} value={suite.id}>
                          {suite.name} · {suite.caseIds.length} 例
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    被测版本
                    <input name="testedVersion" placeholder="Commit / Release / Build ID" />
                  </label>
                  <label>
                    优先级
                    <select defaultValue="50" name="priority">
                      <option value="90">P0 · 发布冒烟</option>
                      <option value="70">P1 · 核心回归</option>
                      <option value="50">P2 · 常规回归</option>
                      <option value="30">P3 · 巡检任务</option>
                    </select>
                  </label>
                  <div className="launch-safety-note">
                    <span aria-hidden="true">✓</span>
                    <p>目标由环境白名单控制；写入步骤必须执行 finally 清理；首次失败永久保留。</p>
                  </div>
                  <button
                    className="primary"
                    disabled={busy || environments.length === 0 || scopedSuites.length === 0}
                    type="submit"
                  >
                    发起一键回归
                  </button>
                </form>
              </article>

              <article className="panel run-list-panel">
                <div className="panel-title">
                  <div>
                    <span className="step-number">LIVE</span>
                    <h3>运行队列</h3>
                  </div>
                  <span className="live-refresh">
                    <i aria-hidden="true" /> SSE 实时
                  </span>
                </div>
                <div className="run-list" aria-label="测试运行列表">
                  {runs.map((run) => {
                    const progress = runProgress(run);
                    return (
                      <button
                        aria-current={run.id === selectedRunId ? "true" : undefined}
                        className={run.id === selectedRunId ? "selected" : ""}
                        key={run.id}
                        onClick={() => setSelectedRunId(run.id)}
                        type="button"
                      >
                        <span className="run-identity">
                          <strong>#{run.sequenceNumber}</strong>
                          <span>
                            <b>{run.suiteName}</b>
                            <small>
                              {run.environmentName} ·{" "}
                              {new Date(run.queuedAt).toLocaleString("zh-CN")}
                            </small>
                          </span>
                        </span>
                        <span className="run-state-column">
                          <span className={`run-status run-status-${run.status}`}>
                            {runStatusLabels[run.status]}
                          </span>
                          <small>{elapsed(run)}</small>
                        </span>
                        <span className="run-progress-column">
                          <span>
                            <b>{progress}%</b>
                            <small>
                              {run.summary.passed + run.summary.flaky}/{run.summary.total}
                            </small>
                          </span>
                          <span
                            aria-label={`运行进度 ${progress}%`}
                            aria-valuemax={100}
                            aria-valuemin={0}
                            aria-valuenow={progress}
                            className="progress-track"
                            role="progressbar"
                          >
                            <i style={{ width: `${progress}%` }} />
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {runs.length === 0 ? (
                    <div className="run-empty-state">
                      <span aria-hidden="true">◎</span>
                      <strong>还没有测试运行</strong>
                      <p>从左侧选择环境和套件，创建第一条可追踪的回归记录。</p>
                    </div>
                  ) : null}
                </div>
              </article>

              {selectedRun !== undefined ? (
                <article className="panel run-detail-panel">
                  <div className="run-detail-heading">
                    <div>
                      <p className="eyebrow">RUN #{selectedRun.sequenceNumber}</p>
                      <h3>{selectedRun.suiteName}</h3>
                      <p>
                        {selectedRun.environmentName} ·{" "}
                        {selectedRun.testedVersion || "未声明被测版本"}
                      </p>
                    </div>
                    <div className="run-detail-actions">
                      <span className={`gate-badge gate-${selectedRun.gateResult ?? "pending"}`}>
                        {selectedRun.gateResult === "passed"
                          ? "门禁通过"
                          : selectedRun.gateResult === "blocked"
                            ? "门禁阻断"
                            : selectedRun.gateResult === "inconclusive"
                              ? "结论不确定"
                              : runStatusLabels[selectedRun.status]}
                      </span>
                      {selectedRun.status === "completed" ? null : (
                        <button
                          className="secondary danger-action"
                          disabled={busy || selectedRun.cancellationRequested}
                          onClick={() => void cancelSelectedRun()}
                          type="button"
                        >
                          {selectedRun.cancellationRequested ? "取消处理中" : "取消运行"}
                        </button>
                      )}
                    </div>
                  </div>

                  <dl className="run-metadata">
                    <div>
                      <dt>状态</dt>
                      <dd>{runStatusLabels[selectedRun.status]}</dd>
                    </div>
                    <div>
                      <dt>Worker</dt>
                      <dd>{selectedRun.workerId?.slice(0, 12) ?? "等待分配"}</dd>
                    </div>
                    <div>
                      <dt>Worker 镜像</dt>
                      <dd>{selectedRun.workerImageDigest?.slice(0, 18) ?? "等待分配"}</dd>
                    </div>
                    <div>
                      <dt>执行器</dt>
                      <dd>{selectedRun.executorVersion ?? "等待分配"}</dd>
                    </div>
                    <div>
                      <dt>优先级</dt>
                      <dd>{selectedRun.priority}</dd>
                    </div>
                    <div>
                      <dt>耗时</dt>
                      <dd>{elapsed(selectedRun)}</dd>
                    </div>
                  </dl>

                  <section className="result-summary" aria-label="运行结果汇总">
                    <span>
                      <strong>{selectedRun.summary.passed}</strong>通过
                    </span>
                    <span>
                      <strong>{selectedRun.summary.productFailed}</strong>产品失败
                    </span>
                    <span>
                      <strong>{selectedRun.summary.testFailed}</strong>用例失败
                    </span>
                    <span>
                      <strong>{selectedRun.summary.environmentFailed}</strong>环境失败
                    </span>
                    <span>
                      <strong>{selectedRun.summary.infrastructureFailed}</strong>设施失败
                    </span>
                    <span>
                      <strong>{selectedRun.summary.flaky}</strong>不稳定
                    </span>
                  </section>

                  {selectedRun.firstFailure === null ? null : (
                    <div className="first-failure" role="alert">
                      <span>首次失败</span>
                      <strong>{selectedRun.firstFailure.code}</strong>
                      <p>{selectedRun.firstFailure.message}</p>
                    </div>
                  )}

                  <div className="evidence-layout">
                    <section className="run-case-column">
                      <h4>用例 / 迭代</h4>
                      <ol>
                        {selectedRun.cases.map((runCase) => (
                          <li key={runCase.id}>
                            <span
                              className={`case-result case-result-${runCase.result ?? runCase.status}`}
                              aria-hidden="true"
                            />
                            <span>
                              <strong>{runCase.caseName}</strong>
                              <small>
                                v{runCase.version} · {runCase.durationMs ?? 0}ms · 清理
                                {runCase.cleanupStatus}
                              </small>
                            </span>
                            <b>
                              {runCase.result === null
                                ? runCase.status
                                : caseResultLabels[runCase.result]}
                            </b>
                          </li>
                        ))}
                      </ol>
                    </section>
                    <section className="run-timeline">
                      <h4>步骤证据</h4>
                      <ol>
                        {selectedRun.steps.map((step) => (
                          <li key={step.id}>
                            <span className={`timeline-dot timeline-${step.status}`} />
                            <div>
                              <span>
                                <strong>{step.stepId}</strong>
                                <small>
                                  {step.phase === "finally" ? "清理" : `尝试 ${step.attempt}`} ·
                                  {step.durationMs ?? 0}ms
                                </small>
                              </span>
                              <code>{step.action}</code>
                              {step.error === null ? null : <p>{step.error.message}</p>}
                            </div>
                          </li>
                        ))}
                        {selectedRun.steps.length === 0 ? (
                          <li className="timeline-waiting">
                            <span className="timeline-dot" />
                            <div>
                              <strong>等待 Worker 生成第一条步骤证据</strong>
                            </div>
                          </li>
                        ) : null}
                      </ol>
                    </section>
                  </div>
                </article>
              ) : null}
            </section>
          ) : null}

          {page === "suites" ? (
            <section className="panel-grid">
              <article className="panel">
                <div className="panel-title">
                  <div>
                    <span className="step-number">SET</span>
                    <h3>创建测试套件</h3>
                  </div>
                </div>
                <form className="form-stack" onSubmit={(event) => void createSuite(event)}>
                  <label>
                    套件标识
                    <input name="key" placeholder="smoke" required />
                  </label>
                  <label>
                    套件名称
                    <input name="name" placeholder="核心接口冒烟" required />
                  </label>
                  <label>
                    说明
                    <textarea name="description" rows={2} />
                  </label>
                  <fieldset>
                    <legend>选择已发布用例</legend>
                    <div className="checkbox-list">
                      {publishedCases.map((testCase) => (
                        <label key={testCase.id}>
                          <input name="caseIds" type="checkbox" value={testCase.id} />
                          {testCase.name}
                        </label>
                      ))}
                      {publishedCases.length === 0 ? (
                        <p className="empty">请先发布至少一个用例。</p>
                      ) : null}
                    </div>
                  </fieldset>
                  <div className="inline-fields">
                    <label>
                      默认并发
                      <input
                        defaultValue="1"
                        max="100"
                        min="1"
                        name="defaultConcurrency"
                        type="number"
                      />
                    </label>
                    <label>
                      诊断重试
                      <input
                        defaultValue="0"
                        max="3"
                        min="0"
                        name="defaultDiagnosticRetries"
                        type="number"
                      />
                    </label>
                  </div>
                  <button
                    className="primary"
                    disabled={busy || publishedCases.length === 0}
                    type="submit"
                  >
                    创建套件
                  </button>
                </form>
              </article>
              <article className="panel panel-wide suite-catalog">
                <div className="panel-title">
                  <div>
                    <span className="step-number">CAT</span>
                    <h3>套件目录</h3>
                  </div>
                  <span className="count">{suites.length}</span>
                </div>
                <div className="suite-grid">
                  {suites.map((suite) => (
                    <section key={suite.id}>
                      <div>
                        <span className="tag tag-active">{suite.key}</span>
                        <h4>{suite.name}</h4>
                        <p>{suite.description || "未填写说明"}</p>
                      </div>
                      <dl>
                        <div>
                          <dt>用例</dt>
                          <dd>{suite.caseIds.length}</dd>
                        </div>
                        <div>
                          <dt>并发</dt>
                          <dd>{suite.defaultConcurrency}</dd>
                        </div>
                        <div>
                          <dt>重试</dt>
                          <dd>{suite.defaultDiagnosticRetries}</dd>
                        </div>
                      </dl>
                    </section>
                  ))}
                  {suites.length === 0 ? <p className="empty">还没有测试套件。</p> : null}
                </div>
              </article>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}
