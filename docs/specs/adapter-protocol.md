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
  "version": "0.3.0",
  "protocolVersion": "1.0",
  "platformRange": ">=0.1.0 <0.2.0",
  "environmentSchema": {},
  "capabilities": {
    "actions": [
      { "key": "conversation.create" },
      { "key": "conversation.assert-recent" },
      { "key": "chat.ask" },
      { "key": "chat.assert-history" },
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

当前 `0.6.0` 纵向切片已经注册 `conversation.create`、`conversation.assert-recent`、`chat.ask`、
`chat.assert-history`、`tool.assert-safe-catalog`、`tool.invoke-safe`、`tool.assert-history` 和
`conversation.delete`，以及 `knowledge-base.create`、`knowledge-base.upload-fixture`、
`knowledge-base.attach-upload`、`knowledge-base.wait-ready`、`knowledge-base.cleanup` 和
`skill.assert-trusted-publication`。动作只调用适配器内
固定的 `/trade/api` 与 `/trade-domain-api` 路径，所有请求与
重定向执行环境 allowlist 校验；登录 Token、用户密码和模型回答正文都不进入输出、日志、资源台账或
结构化证据。`chat.ask` 只向此前已创建并登记的测试会话发送消息，将 SSE 限制在 1 MB 内，要求流中会话
ID 与登记 ID 一致、存在内容事件和唯一终态 `done`，并只输出事件计数、长度与最终回答 SHA-256；
`chat.assert-history` 使用该哈希确认落库回答与流式终态一致。CHAT 用例必须先用 `conversation.create` 登记
`spark-x-agent-conversation` 资源再执行 `chat.ask`，因此聊天取消、超时或失败时，普通 `finally` 和独立
补偿 Worker 都已持有清理 ID。删除动作重新登录；HTTP 404 作为已经清理成功处理，不触发掩盖根因的重试。

TOOL 动作仅允许仓库内置的 `builtin-demo__calculator`、`builtin-demo__echo` 和 `builtin-demo__time` 只读
工具。目录校验同时检查普通用户投影不含连接命令、环境变量、地址、工作目录或错误详情，以及管理员登记
工具均为启用、已发现、非写入且无需复核。调用动作要求且只允许一次工具调用和一次成功结果，拒绝复核事件，
对工具名、调用 ID、参数和结果做精确结构化匹配；历史动作再次核对消息、`public_execution_trace` 与流式
SHA-256。参数、结果、最终回答、凭据和 Token 均不进入平台证据，只登记计数、布尔判定和哈希。
`builtin-demo` 未上线或目录不完整属于测试环境前置条件失败，稳定归类为 `environment_failed`；TOOL-002 在
登记会话资源后、模型调用前重复执行该前置检查，既避免把环境缺口误报为模型或产品失败，也保证失败后
`finally` 已持有可清理的会话 ID。

KNOWLEDGE-BASE 动作不接受文件路径、文件内容、URL 或脚本参数；上传内容只能由适配器仓库代码生成固定的
小型 PDF，并以知识库 UUID 作为幂等键。短期签名解析源只在 Worker 内存中从原始文档接口传递给知识库接口，
不会进入输出或证据。完成判定同时核对知识库文档计数、解析终态、单一当前版本、Parser 版本和原始 PDF
SHA-256。创建动作只登记一个 `spark-x-agent-knowledge-base` 顶层资源；统一清理动作根据该 UUID 恢复原始上传，
先删除知识文档与 Parser 资源，再删除原始上传并归档知识库，因此普通 `finally` 和 Worker 中断后的独立补偿
不依赖中间步骤是否完成捕获。解析服务缺失、配置错误或 5xx 归为 `environment_failed`，首次失败不会被清理
或重试覆盖。

SKILL 动作当前只读校验部署系统已经发布的固定 `trade-port-daily-brief`，不接受 Skill 名称、Prompt、文件、
URL 或脚本参数。动作分别读取当前用户清单、用户详情和管理员清单，要求 UUID、名称、展示名、分类、启用状态、
非内置标记、`durable_agent_task_v17` 有效能力、上传来源、主资产和资产摘要一致；原始 Prompt 只在 Worker 内存
中计算 SHA-256，输出仅包含身份、状态、计数、布尔判定和哈希。受信任发布缺失归为 `environment_failed`，投影
不一致归为 `product_failed`，精确发布哈希不匹配保留为 `test_failed`。当前被测系统的删除接口尚不能完整撤销
不可变发布目录、授权和对象存储内容，因此适配器不会创建临时 Skill；实际注入用例将在依赖工具上线且被测系统
具备完整回收语义后单独实现，避免产生无法补偿的残留资源。
