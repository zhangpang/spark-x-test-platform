# M1 部署后冒烟检查

本检查只允许在测试环境 `192.168.110.136` 上执行。开始前必须确认当前主机地址；不得在用户本机启动等价 Compose 栈或用本机结果代替测试环境证据。

正式发布由 Youlan 发布控制台调用版本化的 `infra/deploy/release.sh` 执行。本清单用于核对发布作业证据和必要的只读复查，不替代发布控制台的健康、冒烟和回滚检查点。

## 1. 容器状态

```bash
docker compose --env-file .env -f infra/compose/compose.yaml ps
```

预期：`postgres`、`redis`、`minio`、`api`、`scheduler`、`worker`、`web`均为健康状态；`migrate`和`minio-init`成功退出。

## 2. 统一就绪探针

```bash
curl -fsS http://127.0.0.1:4100/api/v1/readyz
curl -fsS http://127.0.0.1:4101/readyz
curl -fsS http://127.0.0.1:4102/readyz
```

三项响应都必须显示PostgreSQL、Redis和MinIO为`ok`。`healthz`只表示进程存活；部署门禁应使用`readyz`。

## 3. 数据库迁移和服务心跳

在PostgreSQL中只读查询：

```sql
select version, checksum_sha256, applied_at
from platform_schema_migrations
order by version;

select service_name, platform_version, metadata, last_seen_at
from service_heartbeats
order by service_name, last_seen_at desc;
```

预期迁移表包含`0001_platform_bootstrap.sql`，Scheduler和Worker最近心跳持续更新。API当前只提供探针，不写周期心跳。

## 4. 控制队列

Scheduler每60秒发布一次`platform.heartbeat`到`${PLATFORM_QUEUE_NAME}-control`，Worker只处理该固定任务。收到其他任务名时Worker必须拒绝，不能把未知队列消息当作脚本执行。

## 5. 控制台

打开`http://192.168.110.136:4173`，页面应显示平台就绪及三项依赖延迟。M1页面明确标记当前不运行测试案例。

## 6. 故障演练

依次停止一个依赖容器并检查API的`readyz`返回`503`且只标记对应依赖为`error`；`healthz`仍返回`200`。恢复依赖后`readyz`应自动恢复，不需要重启API。

不要在共享测试机上执行数据卷删除演练。
