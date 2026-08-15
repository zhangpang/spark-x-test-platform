# 星火 Agent 发布回调协议

## 1. 目标与边界

Youlan 仅在星火 Agent 的精确 Commit 发布成功后发送 `release.completed`。平台把该事件绑定到预先配置的星火 Agent 系统、测试环境和核心冒烟套件，不接受调用方临时指定系统、环境、套件或任意执行内容。

回调只创建不可变运行快照并进入既有幂等队列，不执行上传脚本，不接收密钥变量。`testedVersion` 必须是被测星火 Agent 的 40 位小写 Git Commit，不是自动化测试平台版本。

## 2. 请求

```http
POST /api/v1/release-hooks/spark-x-agent
Content-Type: application/json
X-Spark-Release-Timestamp: 1786763285
X-Spark-Release-Signature: sha256=<64 lowercase hex characters>
```

```json
{
  "event": "release.completed",
  "releaseTaskId": "job_1786763285133_52qxun",
  "testedVersion": "e10b0608da5515344d7a7c1f340fa8666d8f4d34"
}
```

请求体只允许以上三个字段。`releaseTaskId` 必须是稳定且唯一的 Youlan 发布任务标识；时间戳使用 Unix 秒，与 API 当前时间最多相差 300 秒。

## 3. 签名

使用固定键序和无空白 JSON 形成签名原文：

```text
<timestamp>.{"event":"release.completed","releaseTaskId":"<task-id>","testedVersion":"<commit>"}
```

以 `PLATFORM_RELEASE_WEBHOOK_SECRET` 对 UTF-8 原文计算 HMAC-SHA256，小写十六进制结果加 `sha256=` 前缀。平台使用恒定时间比较，不记录共享密钥或完整签名。缺少签名、签名错误和过期时间戳统一返回 `401 RELEASE_HOOK_UNAUTHORIZED`。

## 4. 幂等与关联

平台固定生成：

- `triggerType=release`；
- `triggerSource=youlan:<releaseTaskId>`；
- `idempotencyKey=spark-x-agent-release:<releaseTaskId>`；
- `priority=75`；
- `testedVersion=<被测 Commit>`。

通用 `POST /runs` 入口拒绝 `youlan:` 触发源和 `spark-x-agent-release:` 幂等键命名空间，避免匿名内部调用抢占签名发布任务的关联。

第一次回调返回 `202`，相同任务和相同 Commit 的重复回调返回 `200` 及同一 `run.id`。队列发布始终复用 `run.id` 作为 BullMQ Job ID，既能恢复“运行已落库但首次入队失败”，也不会产生第二个业务运行。相同任务号若被换 Commit 或换运行上下文复用，返回 `409 RELEASE_HOOK_CONFLICT`，不得覆盖已有关联。

## 5. 发布平台处理约定

Youlan 只有在目标发布作业最终状态为 `SUCCESS` 且精确 Commit 已激活后才能发送回调。`202` 和 `200` 都表示平台已接受关联；调用方从响应的 `run.id` 查询运行，直到状态结束，再读取 `gateResult`、首次失败和结构化附件。`401`、`409`、`503` 不得被当作发布冒烟通过。

重试必须保留原 `releaseTaskId`、Commit 和请求体，只更新时间戳并重新签名。不得通过换任务号绕过冲突或用重试掩盖首次失败。
