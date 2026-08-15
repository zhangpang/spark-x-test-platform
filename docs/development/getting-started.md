# 开发与测试环境指南

## 1. 环境边界

- 用户本机只用于源码编辑、代码审阅和 Git 操作；
- 不在用户本机执行单元测试、契约测试、构建、Compose 启动、迁移、接口联调或故障演练；
- 所有测试验证和平台运行统一在测试环境 `192.168.110.136` 完成；
- 平台开发完成后仍长期部署在该测试机，不迁回用户本机。

测试机需要 Node.js `22.x`、npm `10.x`、Docker Engine 和 Compose V2。GitHub Actions 若执行验证，必须使用部署在该测试机并带有 `spark-x-test-env` 标签的受控自托管 Runner。

## 2. 测试环境代码检查

以下命令只能在确认当前主机为 `192.168.110.136` 后执行：

```bash
npm ci
npm run check
```

`check`按顺序执行格式、ESLint、TypeScript、单元/契约测试、所有包和应用构建、Schema及OpenAPI契约检查。

## 3. 在测试环境启动完整栈

正式部署统一通过 Youlan 发布控制台执行，发布对象必须是已经推送的精确 Commit。控制台在测试机共享目录生成并持久保存运行配置，调用 [`infra/deploy/release.sh`](../../infra/deploy/release.sh) 完成构建、测试、迁移、启动和冒烟。

以下手工命令只用于测试机上的受控诊断，不作为日常发布入口。登录测试机，复制示例配置并修改所有示例密码：

```bash
cp .env.example .env
npm run compose:up
```

首次启动会：

1. 启动PostgreSQL、Redis和MinIO；
2. 幂等创建附件Bucket；
3. 对PostgreSQL迁移加全局咨询锁并执行未应用迁移；
4. 启动API、Scheduler和Worker；
5. API就绪后启动Web控制台。

默认入口：

| 服务              | 地址                           | 暴露范围         |
| ----------------- | ------------------------------ | ---------------- |
| Web               | `http://192.168.110.136:4173`  | 测试环境内网访问 |
| API调试           | `http://127.0.0.1:4100/api/v1` | 仅服务器本机     |
| Scheduler健康     | `http://127.0.0.1:4101/readyz` | 仅服务器本机     |
| Worker健康        | `http://127.0.0.1:4102/readyz` | 仅服务器本机     |
| PostgreSQL        | `127.0.0.1:5432`               | 仅服务器本机     |
| Redis             | `127.0.0.1:6379`               | 仅服务器本机     |
| MinIO API/Console | `127.0.0.1:9000/9001`          | 仅服务器本机     |

Web通过同源Nginx反向代理访问API。Redis、数据库、MinIO管理端和Worker接口不得绑定公网地址。

停止服务：

```bash
npm run compose:down
```

该命令保留数据卷。除非明确需要清空测试平台数据，不要附加`--volumes`。

## 4. 工作区职责

| 路径                        | 职责                                  |
| --------------------------- | ------------------------------------- |
| `apps/web`                  | React控制台，不维护独立的领域状态枚举 |
| `apps/api`                  | 控制面API和外部集成入口               |
| `apps/scheduler`            | 定时计划与队列发布                    |
| `apps/worker`               | 受控执行与证据采集                    |
| `packages/contracts`        | 跨进程稳定契约                        |
| `packages/case-schema`      | 用例Schema加载与校验                  |
| `packages/adapter-sdk`      | 适配器清单和执行协议                  |
| `packages/execution-engine` | 状态机和执行编排                      |
| `packages/executors`        | 通用执行器注册表                      |
| `packages/reporting`        | 结果分类和报告模型                    |
| `packages/service-runtime`  | 配置、依赖客户端、探针和服务运行时    |
| `adapters`                  | 被测系统专用增强能力                  |

## 5. 数据库迁移规则

- 迁移文件名使用`NNNN_description.sql`；
- 已应用迁移不可修改；迁移脚本会校验SHA-256并拒绝漂移；
- 每次Schema变化新增迁移，不覆盖历史文件；
- 迁移在PostgreSQL咨询锁中串行执行；
- 破坏性迁移必须另有回滚和备份方案，不能直接加入普通启动流程。
- Youlan 发布计划检测到 `infra/migrations/**` 变化时，必须先生成数据库备份或首发基线标记，并取得显式迁移批准后才能执行。

## 6. 星火 Agent 发布回调配置

发布回调只在 API 容器注入以下运行时配置，密钥不得提交到仓库、写入用例或进入证据：

| 变量名                                  | 含义                                |
| --------------------------------------- | ----------------------------------- |
| `PLATFORM_RELEASE_WEBHOOK_SECRET`       | 至少 32 字节的 HMAC-SHA256 共享密钥 |
| `PLATFORM_SPARK_X_AGENT_SYSTEM_ID`      | 已登记的星火 Agent 系统 UUID        |
| `PLATFORM_SPARK_X_AGENT_ENVIRONMENT_ID` | 测试环境 UUID                       |
| `PLATFORM_SPARK_X_AGENT_CORE_SUITE_ID`  | 核心冒烟套件 UUID                   |

四项全部为空时回调入口以稳定的 `RELEASE_HOOK_DISABLED` 返回 `503`；部分配置、弱密钥或非法 UUID 会阻止 API 启动。签名和联动约定见[发布回调协议](../operations/spark-x-agent-release-hook.md)。

CHAT-005 的确定性 Provider 夹具只用于受控测试环境。API 容器必须显式设置 `PLATFORM_CONTEXT_COMPACTION_FIXTURE_ENABLED=true` 才注册固定端点；默认值为 `false`。夹具不使用真实密钥、不转发 Provider 请求，也不能作为通用模型接口。

## 7. 当前实施边界

- Scheduler继续通过内部控制队列维护心跳；Worker另消费优先级运行队列；
- Worker已支持受控HTTP用例、步骤捕获变量、密钥引用、状态码断言、诊断重试、超时/取消传播与`finally`清理；
- Chromium、受限 HTTP 轮询、JSON 提取/断言变量链、资源锁和补偿任务已进入 M3 验证闭环；MCP、只读数据库和隔离容器尚未完成；
- 星火Agent适配器只有版本化空清单，没有业务动作；
- Web已开放系统与环境、用例库、测试套件和运行中心；公共资产与定时计划仍在后续里程碑；
- 平台没有登录和Worker认证，只允许部署在受控内网。
