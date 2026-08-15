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
  "version": "0.15.0",
  "protocolVersion": "1.0",
  "platformRange": ">=0.1.0 <0.2.0",
  "environmentSchema": {},
  "capabilities": {
    "actions": [
      { "key": "conversation.create" },
      { "key": "conversation.assert-recent" },
      { "key": "conversation.rename-and-assert-pagination" },
      { "key": "conversation.assert-deleted-state" },
      { "key": "chat.ask" },
      { "key": "chat.cancel-and-resume" },
      { "key": "chat.assert-history" },
      { "key": "chat.assert-context-history" },
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

当前 `0.15.0` 纵向切片已经注册 `conversation.create`、`conversation.assert-recent`、
`conversation.rename-and-assert-pagination`、`conversation.assert-deleted-state`、`chat.ask`、
`chat.cancel-and-resume`、`chat.assert-history`、`chat.assert-context-history`、`tool.assert-safe-catalog`、`tool.invoke-safe`、`tool.assert-history` 和
`conversation.delete`，以及 `knowledge-base.create`、`knowledge-base.upload-fixture`、
`knowledge-base.attach-upload`、`knowledge-base.wait-ready`、`knowledge-base.assert-conversation-scope`、`knowledge-base.cleanup` 和
`skill.assert-trusted-publication`，以及 `automation.create`、`automation.wait-fired`、`automation.assert-no-duplicate-delivery`、`automation.assert-lifecycle` 和
`automation.cleanup`。动作只调用适配器内
固定的 `/trade/api` 与 `/trade-domain-api` 路径，所有请求与
重定向执行环境 allowlist 校验；登录 Token、用户密码和模型回答正文都不进入输出、日志、资源台账或
结构化证据。`conversation.assert-recent` 不把列表响应缺失的 `message_count` 当作零，而是通过会话历史接口
读取最多 99 条持久化消息；用例可以声明精确预期数，数量偏差直接归类为产品失败，不轮询或重试。旧用例
未声明预期数时仍返回真实历史计数，保持兼容。
`conversation.rename-and-assert-pagination` 只接受三个已经由本次用例创建并登记的会话 UUID：先通过固定
`PUT /trade/api/conversations/{id}` 持久化手工标题，再以每页两条完整扫描两次活动会话。动作要求三个运行
会话跨越至少两个分页、每次恰好出现一次、保持“重命名目标、最新创建、次新创建”的更新时间顺序，且两次
扫描的页内位置一致；重复、遗漏、标题未持久化或顺序漂移分别保留稳定首错。活动会话超过 200 条时以测试
环境数据超限返回 `environment_failed`，不无限扫描。结构化输出只保留会话 ID、页数、计数、布尔判定和
标题 SHA-256，不返回列表标题或登录 Token。
`conversation.assert-recent` 同时要求目标 UUID 在首个活动分页中恰好出现一次；重复投影在读取历史前保留为
产品首错。`conversation.assert-deleted-state` 兼容被测系统软删除和未来硬删除：详情只允许返回
`status=deleted` 或 404，活动列表中目标 UUID 必须为零，删除列表中必须恰好为一。状态列表完整扫描限制为
1000 条/10 页，超限作为测试环境数据治理问题返回 `environment_failed`；输出仅含 ID、状态枚举、页数和计数。
CONV-004 在首次删除后执行该断言，再次调用同一幂等删除动作，最后仍由 `finally` 和资源台账进行第三次清理，
任何断言失败都不会跳过清理或覆盖首次失败。
`chat.ask` 只向此前已创建并登记的测试会话发送消息，将 SSE 限制在 1 MB 内，要求流中会话
ID 与登记 ID 一致、存在内容事件和唯一终态 `done`，并只输出事件计数、长度与最终回答 SHA-256；
`chat.assert-history` 使用该哈希确认单轮落库回答与流式终态一致；`chat.assert-context-history` 同时核对两轮
`user/assistant` 顺序、两次流式 SHA-256、`stop` 终态、无工具消息和独立干扰会话标识完全缺失。CHAT 用例必须先用 `conversation.create` 登记
`spark-x-agent-conversation` 资源再执行 `chat.ask`，因此聊天取消、超时或失败时，普通 `finally` 和独立
补偿 Worker 都已持有清理 ID。删除动作重新登录；HTTP 404 作为已经清理成功处理，不触发掩盖根因的重试。
`chat.cancel-and-resume` 使用固定 V5 Turn 队列路径且显式关闭工具能力：先等待长回答 Turn 进入
`claimed/running`，再以独立幂等键请求 active cancel。回执必须是首次 `requested` 且动作边界为 `none`；
取消终态必须为 `cancelled`，不能包含助手消息、成功终止原因或失败字段。随后同一会话入队独立续接 Turn，
要求以 `completed/stop` 完成；最终历史必须恰好包含一条取消输入、一条续接输入和一条续接回复，取消 Turn
不能有幽灵助手消息或工具消息。若 Provider 太快导致 active 取消窗口无法建立，稳定返回
`SPARK_X_AGENT_TURN_CANCEL_WINDOW_MISSED/environment_failed`，不会把未执行的取消伪造成通过；正文只输出
SHA-256、长度、Turn ID 和状态计数。

TOOL 动作仅允许仓库内置的 `builtin-demo__calculator`、`builtin-demo__echo` 和 `builtin-demo__time` 只读
工具。目录校验同时检查普通用户投影不含连接命令、环境变量、地址、工作目录或错误详情，以及管理员登记
工具均为启用、已发现、非写入且无需复核；结构化目录证据会分别登记无写入工具、无复核工具和无高风险工具。
调用动作要求且只允许一次工具调用和一次成功结果，拒绝复核事件，
对工具名、调用 ID、参数和结果做精确结构化匹配；历史动作再次核对消息、`public_execution_trace` 与流式
SHA-256。参数、结果、最终回答、凭据和 Token 均不进入平台证据，只登记计数、布尔判定和哈希。
`builtin-demo` 未上线或目录不完整属于测试环境前置条件失败，稳定归类为 `environment_failed`；TOOL-002/003 在
登记会话资源后、模型调用前重复执行该前置检查，既避免把环境缺口误报为模型或产品失败，也保证失败后
`finally` 已持有可清理的会话 ID。

AUTO-002 通过同一受限延迟参数在五秒后触发真实任务；创建回执的 `next_fire_at` 作为不可变预期传给
`automation.wait-fired`。动作要求实际 `last_fire_at` 与预期相差不超过 60 秒，并分别在 UTC 和固定
`Asia/Shanghai (+08:00)` 投影中确认 `next_fire_at - last_fire_at = 300 秒`。结构化证据只保存时间戳、
时区、偏移、误差、计数和正文哈希；若调度漂移超限则保留
`SPARK_X_AGENT_AUTOMATION_TIMEZONE_SCHEDULE_INVALID` 首错，不用重试掩盖。
AUTO-003 通过 `automation.create` 的受限可选延迟创建十分钟后才首次触发的任务，并立即登记自动任务与会话资源。
`automation.assert-lifecycle` 只接受本次运行登记的 UUID 和受控文本：先确认任务尚未触发且至少保留五分钟安全窗口，
再按精确乐观版本依次修改名称/目标/周期、停用、重新启用和删除。每个回执版本必须连续递增，修改后的定义必须
从所有者列表精确读回，删除后列表中必须消失，目标会话历史必须仍为空。动作不重试 409，不返回名称或目标正文，
只登记版本、布尔判定和 SHA-256；`finally` 再次调用幂等清理，Worker 中断时仍可由资源台账补偿。
AUTO-004 在 `automation.wait-fired` 已证明一次成功调度后，把状态版本、`last_fire_at`、`next_fire_at` 和助手回复
SHA-256 作为不可变基线传给 `automation.assert-no-duplicate-delivery`。动作进行固定三次、间隔两秒的连续断言；
每次都重新读取任务定义和会话历史，要求版本与两个触发游标不变、始终只有一条用户消息和一条助手消息、
零工具消息且回复哈希不变。任一观察出现第二次投递或漂移即返回
`SPARK_X_AGENT_AUTOMATION_DUPLICATE_DELIVERY_DETECTED`，观察不会重试失败，也不返回正文。

MCP-001 以独立 `mcp` 模块用例复用 `tool.assert-safe-catalog` 的受信任连接器投影，因为该动作本身同时验证
MCP Server 用户可见状态、管理员发现工具、只读风险策略和私有连接字段缺失。独立诊断套件支持显式声明
`SPARK_X_AGENT_EXPECT_MCP_UNAVAILABLE=true`：管理员停用 `builtin-demo` 时，必须保留
`SPARK_X_AGENT_SAFE_TOOL_CATALOG_UNAVAILABLE` 首次失败并返回 `inconclusive`，不会自动启动服务或把环境缺口
记为产品失败；服务上线后则要求同一用例完整通过。

KNOWLEDGE-BASE 动作不接受文件路径、文件内容、URL 或脚本参数；上传内容只能由适配器仓库代码生成固定的
小型 PDF，并以知识库 UUID 作为幂等键。短期签名解析源只在 Worker 内存中从原始文档接口传递给知识库接口，
不会进入输出或证据。完成判定同时核对知识库文档计数、解析终态、单一当前版本、Parser 版本和原始 PDF
SHA-256。创建动作只登记一个 `spark-x-agent-knowledge-base` 顶层资源；统一清理动作根据该 UUID 恢复原始上传，
先删除知识文档与 Parser 资源，再删除原始上传并归档知识库，因此普通 `finally` 和 Worker 中断后的独立补偿
不依赖中间步骤是否完成捕获。解析服务缺失、配置错误或 5xx 归为 `environment_failed`，首次失败不会被清理
或重试覆盖。

`knowledge-base.assert-conversation-scope` 只接受本次运行登记的会话、知识库、知识文档和 `${run.id}` 幂等键。
动作先确认新会话为空范围且修订号为 0，再以乐观修订绑定唯一 `required` 知识库；首次创建快照必须返回
HTTP 201，同一请求重放必须返回 HTTP 200，且范围哈希、快照 ID、快照哈希、知识版本 ID、Parser 版本 ID 和
内容哈希必须完全一致。创建和重放后再次读取范围，确认修订、哈希、计数和绑定关系没有漂移。输出只登记
资源 ID、哈希、计数和布尔结论；文件名、标题、Parser 内部 ID、签名地址、文档内容、密码和 Token 均不进入
结构化证据。会话后于知识库登记，普通 `finally` 明确先删会话再清知识库，独立补偿按资源倒序保持同一顺序。

SKILL 动作当前只读校验部署系统已经发布的固定 `trade-port-daily-brief`，不接受 Skill 名称、Prompt、文件、
URL 或脚本参数。动作分别读取当前用户清单、用户详情和管理员清单，要求 UUID、名称、展示名、分类、启用状态、
非内置标记、`durable_agent_task_v17` 有效能力、上传来源、规范化正文和三方资产摘要一致；原始 Prompt 只在
Worker 内存中按被测系统 frontmatter 解析后的 `trim()` 语义计算 SHA-256，输出仅包含身份、状态、计数、布尔
判定和哈希。本地资产摘要是 legacy 容器文件兼容层，V12 不可变发布重启后允许为空，但三个 API 投影必须一致，
并如实输出 `assetRootPresent` 与 `mainAssetPresent`，不得把缺失伪装为存在。受信任发布缺失归为 `environment_failed`，投影
不一致归为 `product_failed`，精确发布哈希不匹配保留为 `test_failed`。当前被测系统的删除接口尚不能完整撤销
不可变发布目录、授权和对象存储内容，因此适配器不会创建临时 Skill；实际注入用例将在依赖工具上线且被测系统
具备完整回收语义后单独实现，避免产生无法补偿的残留资源。

AUTOMATION 动作固定创建 `selected_skill_id=null`、300 秒周期且首次执行时间为当前时刻的无工具任务，不接受
任意 Skill、周期或执行脚本参数。等待动作把所有者任务定义中的 `state_version`、`last_fire_at`、`next_fire_at`
与绑定会话历史关联，要求计划只推进一个周期、恰好一条用户目标和一条 `stop` 助手回复，并拒绝任何工具消息、
工具调用或工具公开轨迹。目标与回复原文只在 Worker 内存中比较，证据仅登记计数、状态、时间和 SHA-256。目标
系统调度会递增乐观状态版本，因此清理先读取最新定义再按该版本软删除；只在 HTTP 409 时执行最多两次有界
版本协调，普通业务失败不会重试。任务资源后于会话登记，普通 `finally` 和独立补偿都先删除任务再删除会话；
HTTP 404 视为已经完成幂等清理。
