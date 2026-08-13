# M1 测试环境验证记录（2026-08-13）

## 1. 结论

M1 平台工程骨架已在测试环境 `192.168.110.136` 完成首次部署、基线迁移、质量门禁、正常态冒烟和 Redis 故障恢复验证，结果通过。

本记录不包含密钥、数据库连接串或业务数据。用户本机未启动测试平台服务，也未作为验收证据来源。

## 2. 发布身份

| 项目                 | 值                                         |
| -------------------- | ------------------------------------------ |
| 环境                 | `caishui-test-136` / `192.168.110.136`     |
| Git Ref              | `main`                                     |
| 部署 Commit          | `afa693d8fdef26ecc047fdcaac5f611c7458e0df` |
| Plan ID              | `a2432b8a515a246e64735dd2`                 |
| Job ID               | `job_1786605236343_1lpj7y`                 |
| Execution Release ID | `20260813071356_afa693d8fdef_1lpj7y`       |
| Release Record ID    | `release_1786606045431_cx3v4n`             |
| 发布通道             | `full`                                     |
| 迁移                 | 已批准并成功执行                           |
| 发布结果             | `SUCCESS`                                  |

Youlan Resume 复用了完成的检出、构建、打包、传输、备份、迁移和激活检查点，没有重复执行数据库迁移。

## 3. 测试机质量门禁

质量门禁在测试环境的服务镜像内执行 `npm run check`，结果：

- Prettier、ESLint 和 TypeScript 检查通过；
- 7 个测试文件、16 个测试全部通过；
- 所有包和 Web/API/Scheduler/Worker 构建通过；
- 用例 Schema、适配器清单和 59 个 OpenAPI 操作校验通过；
- npm 审计为 0 个已知漏洞。

## 4. 运行状态

验证时以下长期服务均为 `healthy`：

- Web；
- API；
- Scheduler；
- Worker；
- PostgreSQL；
- Redis；
- MinIO。

Web 首页和健康接口返回 HTTP 200。API、Scheduler 和 Worker 的 `readyz` 均显示 PostgreSQL、Redis、MinIO 为 `ok`。

PostgreSQL 中存在迁移 `0001_platform_bootstrap.sql`，SHA-256 长度为 64。Scheduler 持续写入 `test-runs-control` 心跳，Worker 已消费对应的 `platform.heartbeat` 重复任务。

## 5. Redis 故障恢复演练

在测试机受控停止 Redis，并配置退出恢复保护：

1. API `readyz` 在约 0.004 秒内返回 HTTP 503；
2. 依赖结果只将 Redis 标记为 `error`，PostgreSQL 和 MinIO 保持 `ok`；
3. API `healthz` 继续返回 HTTP 200；
4. API、Scheduler、Worker 和 Web 进程均未退出；
5. Redis 恢复后约 2 秒，API、Scheduler 和 Worker 的 `readyz` 全部恢复 HTTP 200；
6. 最终 7 个长期容器全部恢复为 `healthy`，服务心跳继续更新。

该演练证明 M1 能区分进程存活和依赖就绪，单个依赖中断不会导致服务进程退出，并能在依赖恢复后自动恢复就绪状态。

## 6. 发布过程发现并修复的问题

正式成功发布前，测试环境门禁发现并阻断了以下问题：

1. Compose `--project-directory` 使构建上下文解析错误；修复为按 Compose 文件位置解析；
2. 测试环境指南的 Markdown 表格不符合仓库 Prettier 规则；已机械格式化；
3. 非 root Runtime 镜像中的 `node_modules` 归属错误，Vitest 无法写临时配置；已在镜像复制时设置 `node:node` 归属；
4. 发布控制台在 Web 刚启动时立即探测，出现一次连接重置；健康探针改为已通过容器门禁的 API `readyz`，Web 继续由带重试的 Smoke 检查验证。

前三项失败均发生在迁移执行前。第四项发生在迁移和激活成功后，使用同一 Job Resume 完成健康、Smoke、清理和发布清单检查点。

## 7. M1 范围限制

本次只验收平台工程骨架、依赖、迁移、控制队列、探针和发布生命周期。M1 Worker 尚不执行真实测试案例，测试资产控制面和星火 Agent 业务回归分别在后续里程碑实现。
