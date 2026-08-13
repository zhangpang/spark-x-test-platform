# 星火自动化测试平台

`spark-x-test-platform` 是一个独立部署、面向多个被测系统的自动化回归测试平台。

平台负责集中维护自动化业务用例、测试套件、执行计划、运行证据和质量门禁；被测系统通过浏览器、HTTP 或可选的系统适配器接入。星火 Agent 是首个接入对象，但知识库、Skill、MCP、自动任务等概念不会写入平台核心。

## 当前阶段

仓库已完成产品与技术基线，当前进入 **M1 平台工程骨架**。M1 仅建设平台自身运行基础，不执行真实测试案例。已确认的第一版目标包括：

- 独立控制台、API、调度器和可横向扩展的 Worker；
- 平台数据库内维护、发布、比较、回滚和导入导出自动化用例；
- 浏览器、HTTP、MCP、轮询、只读数据库查询和系统适配器动作；
- 手工、定时、API/Webhook 和发布门禁触发；
- 截图、日志、Playwright Trace、工具调用和命中文档等运行证据；
- 确定性规则与真实模型多次运行相结合的 Agent 测试；
- 以星火 Agent 测试环境 `192.168.110.136` 完成首批 32 个 P0/P1 用例。

第一版不提供用户登录、Worker 认证、人工测试流程、任意脚本上传执行、Kubernetes 部署、完整缺陷管理、全局视觉回归门禁和复杂统计大屏。

## 基线文档

- [产品范围](docs/product/product-baseline.md)
- [系统架构](docs/architecture/system-architecture.md)
- [数据模型](docs/architecture/data-model.md)
- [用例模型与 Schema](docs/specs/test-case-schema.md)
- [系统适配器协议](docs/specs/adapter-protocol.md)
- [API 基线](docs/api/openapi.yaml)
- [页面线框](docs/ui/wireframes.md)
- [MVP 里程碑](docs/roadmap/mvp-plan.md)
- [验收清单](docs/quality/acceptance.md)
- [星火 Agent 首批案例目录](docs/quality/spark-x-agent-case-catalog.md)
- [决策记录](docs/decisions/0001-platform-boundary.md)
- [开发与测试环境指南](docs/development/getting-started.md)
- [M1 部署后冒烟检查](docs/operations/m1-smoke-check.md)

机器可校验的用例和适配器清单 Schema 位于 [`schemas/`](schemas/)。

## 计划技术栈

- Web：React + TypeScript
- API、调度器与 Worker：Node.js + TypeScript
- 数据库：PostgreSQL
- 队列与租约：Redis
- 运行附件：MinIO
- 浏览器执行：Playwright / Chromium
- 测试环境部署：Docker Compose

## 核心原则

1. 平台内核保持通用，业务能力由版本化适配器扩展。
2. 自动化业务回归用例以平台数据库为事实来源；项目内单元测试仍留在项目仓库。
3. 运行结果必须绑定被测版本、环境快照、Worker 镜像和适配器版本。
4. 任何通过、失败、取消或超时都必须进入清理阶段，清理失败独立记录。
5. 用例只能访问已登记环境的地址，密钥不得进入用例正文、日志或 Git。
6. AI 回归优先断言工具、参数、证据和业务事实，不比较回答全文。

## M1 测试环境部署

以下命令只在登录测试环境 `192.168.110.136` 并确认主机后执行，不在用户本机执行测试、构建或 Compose 验证：

```bash
npm ci
npm run check
cp .env.example .env
npm run compose:up
```

平台开发完成后仍部署在该测试机，默认 Web 入口为 `http://192.168.110.136:4173`。完整说明见[开发与测试环境指南](docs/development/getting-started.md)。

正式部署通过 Youlan 发布控制台按精确 Commit 执行；检测到数据库迁移时必须在备份后获得显式批准，不允许从本机直接 SSH 拼装发布命令。
