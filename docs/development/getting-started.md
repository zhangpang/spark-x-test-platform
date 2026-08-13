# 本地开发指南

## 1. 前置条件

- Node.js `22.x`；
- npm `10.x`；
- Docker Engine / Docker Desktop 和 Compose V2；
- 至少 8 GB 可用内存用于完整容器栈。

平台自身CI和本地测试不访问星火Agent测试环境或任何其他内网被测系统。

## 2. 纯代码检查

```bash
npm ci
npm run check
```

`check`按顺序执行格式、ESLint、TypeScript、单元/契约测试、所有包和应用构建、Schema及OpenAPI契约检查。

## 3. 启动完整本地栈

复制示例配置并修改所有标记为本地默认值的密码：

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

| 服务              | 地址                           | 暴露范围                                       |
| ----------------- | ------------------------------ | ---------------------------------------------- |
| Web               | `http://localhost:4173`        | 当前主机所有接口，部署到内网服务器后供内部访问 |
| API调试           | `http://127.0.0.1:4100/api/v1` | 仅服务器本机                                   |
| Scheduler健康     | `http://127.0.0.1:4101/readyz` | 仅服务器本机                                   |
| Worker健康        | `http://127.0.0.1:4102/readyz` | 仅服务器本机                                   |
| PostgreSQL        | `127.0.0.1:5432`               | 仅服务器本机                                   |
| Redis             | `127.0.0.1:6379`               | 仅服务器本机                                   |
| MinIO API/Console | `127.0.0.1:9000/9001`          | 仅服务器本机                                   |

Web通过同源Nginx反向代理访问API。Redis、数据库、MinIO管理端和Worker接口不得绑定公网地址。

停止服务：

```bash
npm run compose:down
```

该命令保留数据卷。除非明确需要清空本地平台数据，不要附加`--volumes`。

## 4. 不使用容器开发应用

先启动依赖容器，再将`.env`中的主机名改为本机地址：

```text
DATABASE_URL=postgresql://...@127.0.0.1:5432/...
REDIS_URL=redis://127.0.0.1:6379/0
MINIO_ENDPOINT=127.0.0.1
```

然后执行：

```bash
npm run db:migrate
npm run dev
```

Vite开发服务器位于`http://localhost:5173`，并将`/api`代理到本地API端口。

## 5. 工作区职责

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

## 6. 数据库迁移规则

- 迁移文件名使用`NNNN_description.sql`；
- 已应用迁移不可修改；迁移脚本会校验SHA-256并拒绝漂移；
- 每次Schema变化新增迁移，不覆盖历史文件；
- 迁移在PostgreSQL咨询锁中串行执行；
- 破坏性迁移必须另有回滚和备份方案，不能直接加入普通启动流程。

## 7. M1限制

- Scheduler和Worker只通过内部控制心跳任务验证Redis队列；
- Worker尚不执行真实测试案例；
- 星火Agent适配器只有版本化空清单，没有业务动作；
- Web八个导航项当前是信息架构占位，不是M2功能页面；
- 平台没有登录和Worker认证，只允许部署在受控内网。
