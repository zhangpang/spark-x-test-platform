import { useEffect, useState } from "react";

import type { HealthResponse } from "@spark-x-test/contracts";

const navigation = [
  "系统与环境",
  "用例库",
  "公共步骤",
  "测试套件",
  "运行中心",
  "运行详情",
  "定时计划",
  "平台配置",
] as const;

type Readiness = HealthResponse | { status: "loading" | "unreachable"; message?: string };

export function App() {
  const [readiness, setReadiness] = useState<Readiness>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v1/readyz", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as HealthResponse;
        setReadiness(payload);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setReadiness({
            status: "unreachable",
            message: error instanceof Error ? error.message : "API不可访问",
          });
        }
      });
    return () => controller.abort();
  }, []);

  const dependencyEntries =
    "dependencies" in readiness && readiness.dependencies !== undefined
      ? Object.entries(readiness.dependencies)
      : [];

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">SPARK X QUALITY INFRASTRUCTURE</p>
          <h1>星火自动化测试平台</h1>
        </div>
        <div className={`status-pill status-${readiness.status}`}>
          <span aria-hidden="true" />
          {readiness.status === "ok"
            ? "平台就绪"
            : readiness.status === "loading"
              ? "正在检查"
              : "平台未就绪"}
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="平台导航">
          {navigation.map((item, index) => (
            <button className={index === 0 ? "active" : ""} key={item} type="button">
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item}
            </button>
          ))}
        </aside>

        <main>
          <section className="hero">
            <p className="eyebrow">M1 · ENGINEERING FOUNDATION</p>
            <h2>工程骨架已连接，业务控制面将在下一里程碑进入。</h2>
            <p>
              当前页面验证Web、API、PostgreSQL、Redis、MinIO、Scheduler和Worker的基础连通性，
              不使用任何被测系统或真实测试环境数据。
            </p>
          </section>

          <section className="health-grid" aria-label="依赖健康状态">
            {dependencyEntries.length > 0 ? (
              dependencyEntries.map(([name, health]) => (
                <article className="health-card" key={name}>
                  <div className="health-card-title">
                    <h3>{name}</h3>
                    <span className={`badge badge-${health?.status}`}>{health?.status}</span>
                  </div>
                  <strong>{health?.latencyMs ?? "—"} ms</strong>
                  <p>{health?.error ?? "依赖探针响应正常"}</p>
                </article>
              ))
            ) : (
              <article className="health-card wide">
                <h3>依赖探针</h3>
                <p>
                  {"message" in readiness && readiness.message !== undefined
                    ? readiness.message
                    : "等待API返回依赖状态…"}
                </p>
              </article>
            )}
          </section>

          <section className="scope-card">
            <div>
              <p className="eyebrow">CURRENT SCOPE</p>
              <h3>这一阶段明确不运行测试案例</h3>
            </div>
            <ul>
              <li>统一协议与状态机</li>
              <li>服务健康和依赖探针</li>
              <li>队列与Worker心跳</li>
              <li>可重复Docker Compose部署</li>
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}
