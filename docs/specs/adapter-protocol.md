# 系统适配器协议 1.0

## 1. 作用

系统适配器把通用测试平台无法预知的业务动作、断言、Fixture 和结构化遥测暴露为版本化能力。任何被测系统即使不安装 SDK，也能使用浏览器和 HTTP 通用动作；适配器是增强项，不是接入前置条件。

适配器清单的机器校验定义见 [`../../schemas/adapter-manifest.schema.json`](../../schemas/adapter-manifest.schema.json)。

## 2. 交付方式

- 适配器是受信任的 TypeScript/npm 包；
- 源码进入平台仓库的 `adapters/<adapter-key>/`；
- 构建时安装并锁定版本，随不可变 Worker 镜像发布；
- 运行期间禁止动态下载、上传或替换适配器；
- 每个适配器必须通过 SDK 契约测试和安全检查。

## 3. 清单

每个适配器提供 `adapter.manifest.json`：

```json
{
  "manifestVersion": "1.0",
  "key": "spark-x-agent",
  "name": "星火 Agent",
  "version": "0.2.0",
  "protocolVersion": "1.0",
  "platformRange": ">=0.1.0 <0.2.0",
  "environmentSchema": {},
  "capabilities": {
    "actions": [
      { "key": "conversation.create" },
      { "key": "conversation.assert-recent" },
      { "key": "conversation.delete" }
    ],
    "assertions": [],
    "fixtures": [],
    "telemetry": ["conversation", "tool-call", "document-hit", "final-answer"]
  }
}
```

动作必须声明输入/输出 Schema、动作等级、默认超时、是否创建外部资源和对应清理动作。平台发布用例时根据清单完成静态校验。

## 4. SDK 契约

以下接口描述语义，不是已经发布的实现：

```ts
export interface TestSystemAdapter {
  readonly manifest: AdapterManifest;

  validateEnvironment(
    config: unknown,
    context: ValidationContext,
  ): Promise<ValidationResult>;

  healthCheck(context: AdapterExecutionContext): Promise<HealthResult>;

  executeAction(
    actionKey: string,
    input: unknown,
    context: AdapterExecutionContext,
  ): Promise<ActionResult>;

  evaluateAssertion(
    assertionKey: string,
    input: AssertionInput,
    context: AdapterExecutionContext,
  ): Promise<AssertionResult>;

  collectTelemetry?(
    request: TelemetryRequest,
    context: AdapterExecutionContext,
  ): Promise<TelemetryBundle>;
}
```

## 5. 执行上下文

平台向适配器提供受控能力，适配器不得自行读取平台数据库或 Redis：

```ts
export interface AdapterExecutionContext {
  run: Readonly<RunIdentity>;
  environment: Readonly<ResolvedEnvironment>;
  variables: Readonly<ResolvedVariables>;
  signal: AbortSignal;
  http: AllowlistedHttpClient;
  browser: ControlledBrowserSession;
  mcp: ControlledMcpClient;
  database: ReadOnlyDatabaseClient;
  artifacts: ArtifactWriter;
  resources: ResourceLedgerWriter;
  logger: RedactingLogger;
  clock: Clock;
}
```

- `http`、`browser`、`mcp` 和 `database` 强制执行环境白名单；
- `logger` 和 `artifacts` 写入前统一脱敏；
- `resources` 登记动作创建的资源及清理句柄；
- `signal` 用于取消与超时传播；
- 适配器不得从进程环境读取未声明密钥；
- Worker 容器的网络策略是最终兜底，SDK 约束不能替代网络隔离。

## 6. 返回结果

动作结果必须是结构化、可序列化的数据：

```ts
export interface ActionResult {
  status: "succeeded" | "failed";
  output?: unknown;
  evidence?: EvidenceReference[];
  createdResources?: CreatedResource[];
  error?: AdapterError;
  suggestedClassification?: FailureClassification;
}
```

适配器可以建议失败分类，但平台根据执行阶段、健康检查和证据做最终归类。错误必须包含稳定的错误码，不得依赖自然语言字符串匹配。

## 7. 遥测协议

适配器可将被测系统证据规范化为：

- 会话标识；
- 模型请求元数据，不含完整敏感业务原文；
- 工具名称、规范化参数和调用顺序；
- 工具结果摘要；
- 命中文档 ID、文件名、分数和范围；
- 最终回答；
- 关联的结构化日志事件。

优先通过受控只读测试接口获取；没有接口时可以使用结构化日志查询。禁止依赖 SSH 搜索任意文本日志作为长期协议。

## 8. 资源与清理

创建资源的动作必须返回稳定的资源类型和系统 ID。危险清理动作执行前，平台验证资源属于：

1. 当前 `run_id` 的资源登记；或
2. 环境中显式登记且允许操作的测试资源。

清理动作必须幂等：资源已经不存在时返回成功和 `already_absent=true`，不能把它视为产品失败。

## 9. 错误分类

稳定错误类别：

- `PRODUCT_BEHAVIOR`
- `TEST_DEFINITION`
- `ENVIRONMENT_UNAVAILABLE`
- `INFRASTRUCTURE_FAILURE`
- `CANCELLED`
- `TIMEOUT`
- `CAPABILITY_INCOMPATIBLE`
- `SECURITY_POLICY_REJECTED`

适配器不得通过重试把错误类别改写为成功；诊断重试由平台统一管理。

## 10. 版本与兼容

- 清单 `protocolVersion` 决定 SDK 主协议；
- `platformRange` 声明可运行的平台版本；
- 能力删除、输入含义变化或输出不兼容必须提升适配器主版本；
- 新增可选字段或新能力提升次版本；
- 修复不改变契约的行为提升补丁版本；
- 历史运行只读取结果快照，不要求重新安装旧适配器；
- 重跑历史用例时必须明确选择原版本或迁移后的当前版本。

## 11. 星火 Agent 适配器首批能力

首批建议命名空间：

```text
chat.*
knowledge-base.*
skill.*
mcp.*
automation.*
conversation.*
telemetry.*
```

星火 Agent 适配器优先复用现有 API、浏览器页面和结构化日志。只有确认证据不足时，才向被测系统增加只读、仅测试环境开启的遥测接口。

当前 `0.2.0` 纵向切片已经注册 `conversation.create`、`conversation.assert-recent` 和
`conversation.delete`。三个动作只调用适配器内固定的 `/trade/api` 路径，所有请求与重定向复用平台
allowlist 校验；登录 Token 只保留在动作内存中，不进入输出、日志、资源台账或证据。创建动作必须登记
`spark-x-agent-conversation` 资源，删除动作会重新登录，因此同一定义既可用于普通 `finally`，也可由独立
补偿 Worker 在原 Worker 中断后执行。HTTP 404 作为已经清理成功处理，不触发掩盖根因的重试。
