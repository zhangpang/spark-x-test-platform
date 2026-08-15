# 测试用例模型与 Schema

机器可校验定义见 [`../../schemas/test-case.schema.json`](../../schemas/test-case.schema.json)，当前 Schema 版本为 `1.0`。

## 1. 设计目标

- 页面表单和执行引擎共享同一份 Schema；
- 用例定义不包含任意可执行代码；
- 通用动作和适配器动作使用同一种步骤协议；
- 运行前能够静态发现无效变量、能力和危险操作；
- 历史运行固定到不可变版本；
- 顺序、条件、受限循环和公共步骤足以覆盖 MVP。

`kind=manual` 仅为未来兼容保留，MVP 不允许发布或运行人工用例。

## 2. 变量模型

统一引用格式为 `${scope.name}`。作用域从低到高：

```text
platform < system < environment < suite < run < case < dataset < step
```

更具体的作用域覆盖同名低层变量。表达式解析器只允许属性读取、比较、布尔组合和受限集合操作，不执行 JavaScript。

当前 M3 Worker 在每次诊断重试开始时注入 `run.id`、用例输入的非密钥 `default` 和已解析密钥，并在步骤成功后登记 `capture` 为 `step.*`。敏感名称的输入不得使用 `default`，必须通过 `secretRef` 解析；普通默认值不会被错误加入密钥脱敏集合。发布校验按执行顺序验证引用闭包；捕获路径无效会在发布期失败，运行时响应缺少捕获字段会保留 `CAPTURE_PATH_NOT_FOUND`，不会延迟成下游的变量缺失。

密钥使用输入声明中的 `secretRef` 或动作参数的受控密钥引用。发布校验必须拒绝疑似明文密码、Token 和私钥。

## 3. 步骤类型

### 3.1 `action`

执行已注册动作。通用命名空间包括：

- `browser:*`
- `http:*`
- `mcp:*`
- `wait:*`
- `json:*`
- `variable:*`
- `database:*`
- `adapter:<adapter-key>/<action>`

每个动作由注册表提供参数 Schema、输出 Schema、动作等级、允许环境和默认超时。用例中的 `params` 不能绕过动作注册表校验。

M3 Chromium 纵向切片注册以下声明式动作：

- `browser:navigate`：只接受相对 `path`、可选 `waitUntil` 和 `expectedStatus`；
- `browser:click`：只接受受限 `selector`；
- `browser:fill`：只接受 `selector` 与结构化 `value`，密钥只能来自变量引用；
- `browser:assert-text`：对 `selector` 执行包含或精确文本断言。

浏览器动作不提供 JavaScript、表达式、函数、Shell、文件上传或下载入口。初始导航、重定向和所有子资源请求都重新校验环境 allowlist；当前切片阻断 WebSocket、弹窗、下载和 service worker。

M3 等待纵向切片注册 `wait:http`：

- 仅向当前环境 `baseUrl` 发起 GET 轮询，`path` 必须是相对路径；
- 每次请求及每次重定向都重新执行环境 allowlist 校验；
- `intervalMs` 限制为 100～30000 毫秒，步骤超时是轮询总上限；
- 条件只能读取响应结构中的受限 JSON 路径，并使用 `equals`、`not-equals`、`contains` 或 `exists`；
- 不接受请求方法、请求体、任意 URL、脚本或表达式；网络错误不会被轮询掩盖为重试；
- 成功证据登记尝试次数、耗时和最后一次结构化响应，统一经过证据脱敏。

M3 JSON 与变量链纵向切片注册以下声明式动作：

- `json:extract`：从先前步骤捕获的 JSON 对象或 JSON 文本中读取单个路径，输出 `{path, found, value}`，可通过普通 `capture` 登记为后续 `step.*` 变量；
- `json:assert`：对先前步骤捕获的 JSON 执行 `equals`、`not-equals`、`contains` 或 `exists`，结构化登记路径、比较符、匹配结果和实际选中值；
- `source` 必须是 `${step.capture-name}` 形式的精确引用，而且只能引用当前执行顺序中已经产生的捕获值；不能直接使用密钥输入作为 JSON 证据源；
- JSONPath 只允许根 `$`、点属性和非负数组整数下标，最多 20 层；不允许通配符、递归、过滤器、函数、原型属性或脚本表达式；
- JSON 源上限为 1 MiB、结构深度上限为 50 层，单个选中值的结构化证据上限为 64 KiB；动作不会把完整源对象复制到自己的输入或输出证据；
- 缺失变量、无效路径和越界定义归类为测试定义失败；畸形 JSON、缺失提取路径和断言不匹配保留稳定根因码并归类为产品失败；失败后仍执行 `finally`，诊断重试仍保留第一次失败。

星火 Agent 首个真实 P0 纵向切片注册以下适配器动作：

- `adapter:spark-x-agent/conversation.create`：以内存密钥登录，创建标题含 `${run.id}` 的会话并返回非敏感会话 ID；必须同步登记资源和删除补偿；
- `adapter:spark-x-agent/conversation.assert-recent`：重新登录并验证新会话位于最近会话列表的首个非置顶位置，输出列表位置与消息数摘要；
- `adapter:spark-x-agent/chat.ask`：向此前已创建并登记的测试会话发送消息含 `${run.id}` 的受控真实模型请求，逐次校验重定向目标，限制 SSE 为 1 MB，只输出终态、事件计数、长度和最终回答 SHA-256；流中会话 ID 必须与登记 ID 一致；
- `adapter:spark-x-agent/chat.assert-history`：重新登录并校验唯一用户消息、唯一助手回复、`stop` 终止原因，以及落库回答 SHA-256 与流式最终回答一致；
- `adapter:spark-x-agent/chat.assert-context-history`：校验同一主会话两轮用户/助手消息顺序、两次流式哈希、`stop` 终态、零工具消息，并拒绝独立干扰会话标识串入；
- `adapter:spark-x-agent/tool.assert-safe-catalog`：校验 `builtin-demo` 三个内置只读工具在普通用户与管理员目录中一致，且用户投影不暴露连接配置；
- `adapter:spark-x-agent/tool.invoke-safe`：只允许一次白名单内置工具调用，精确匹配工具名、参数、成功结果和最终回复，只输出计数、判定和 SHA-256；
- `adapter:spark-x-agent/tool.assert-history`：重新登录并校验工具调用消息、工具结果、最终回复及 `public_execution_trace` 与流式哈希一致；
- `adapter:spark-x-agent/tool.invoke-failure-recovery`：固定执行一次 calculator 除零失败和一次 echo 恢复，要求失败在前、恢复在后、调用 ID 独立且无额外工具，只输出计数、判定和两段 SHA-256；
- `adapter:spark-x-agent/tool.assert-failure-recovery-history`：重新登录并校验六条有序消息、两次调用/结果、失败与成功标志、最终回复及两段 `public_execution_trace` 与流式哈希一致；
- `adapter:spark-x-agent/automation.assert-lifecycle`：只操作本次运行登记且尚未触发的任务，按乐观版本修改、停用、重新启用和删除，并确认列表无残留、目标会话零调度消息；
- `adapter:spark-x-agent/automation.wait-fired`：可引用创建回执的首次触发时间，校验真实调度误差以及 UTC/`Asia/Shanghai` 下一次计划均精确推进五分钟；
- `adapter:spark-x-agent/automation.assert-no-duplicate-delivery`：一次调度完成后固定三次核对状态版本、触发游标和唯一消息对，任何第二次投递或内容漂移立即失败；
- `adapter:spark-x-agent/knowledge-base.assert-conversation-scope`：将本次运行的唯一就绪知识库绑定到已登记会话，严格固定文档版本，并校验首次创建、幂等重放和最终范围稳定性；输出仅包含资源 ID、哈希、计数和布尔判定；
- `adapter:spark-x-agent/knowledge-base.query-and-assert-evidence`：引用本次运行捕获的会话、订单文档与不可变快照执行真实 V5 Turn，要求订单事实、引用回执和结构化证据完全一致，并拒绝禁止文档；可成对声明已绑定/未绑定知识库 UUID 作为固定夹具资源标识，回答与证据必须包含前者且排除后者；答案、片段、定位器和密钥不进入证据，只登记 ID、计数、布尔判定和 SHA-256；
- `adapter:spark-x-agent/conversation.delete`：重新登录并按资源 ID 幂等删除，用于普通 `finally` 和独立补偿任务；
- 适配器动作只接受清单声明的受限参数，不接受 URL、host、脚本、表达式或任意扩展字段；内部 HTTP 请求及重定向仍执行环境 allowlist 校验；
- 用户名、密码与登录 Token 不写入动作输出。补偿定义只能引用 `resource.id` 和用例声明的密钥输入，避免把临时 Token 持久化。

### 3.2 `if`

执行受限布尔条件，根据结果进入 `then` 或 `else`。条件不得访问网络、文件或执行函数。

### 3.3 `foreach`

遍历已解析集合，默认最多 20 次，最大 100 次。循环按顺序执行，不在用例内部并行。

### 3.4 `call`

调用固定 ID 和版本的公共步骤或 Fixture。禁止引用“最新版”，避免历史运行不可复现。

## 4. 断言

平台内置状态码、JSON Schema、字段相等、包含、集合、页面元素、文本、耗时和只读数据库断言。适配器可注册业务断言；Judge 断言属于软证据，不能成为 MVP 唯一通过条件。

断言严重级别：

- `hard`：失败立即使当前迭代不通过；真实模型重复运行时每次都必须满足；
- `soft`：记录偏差，可参与用例定义的普通成功率门槛。

## 5. 超时、失败和清理

- 步骤超时继承用例默认值，可单独覆盖；
- 用例总超时包含主步骤，不包含被平台限制的清理宽限期；
- 主步骤失败后停止后续普通步骤，除非显式 `continueOnFailure=true`；
- 无论通过、失败、取消或超时，`finally` 都执行；
- `finally` 失败单独分类，并创建补偿清理任务；
- 诊断重试从用例开头运行，不从失败步骤继续；
- 首次失败输入摘要、输出摘要和附件不得被覆盖。

每个 Chromium 步骤生成一份视口截图和一个 Playwright Trace chunk。截图、Trace 与附件元数据必须关联 `run_id`、`run_case_id`、`step_run_id` 和 `attempt`；已知密钥只在内存中注入，含密钥步骤的截图使用整页遮罩，Trace 原始包只允许位于内存文件系统并在脱敏后删除。对象存储只接收通过敏感字段、密钥值和资源体清理的附件。

## 6. 数据驱动和真实模型重复

用例绑定数据集后，每一行成为独立迭代。配置真实模型重复时，每个数据集迭代再展开为 `repetitions` 次运行。平台同时展示单次结果、数据行汇总和用例成功率。

## 7. 发布校验

发布必须完成：

1. JSON Schema 校验；
2. 步骤 ID 唯一性和引用闭包校验；
3. 变量、输入、数据集列和捕获变量校验；
4. 动作与断言注册表 Schema 校验；
5. 公共步骤无循环依赖校验；
6. 适配器和平台版本兼容性校验；
7. 用例动作等级不高于目标环境允许等级；
8. 写入和危险用例具备可验证清理路径；
9. 所有密钥均使用引用；
10. 用例总超时不低于步骤理论最大耗时；
11. 星火 Agent 会话创建或新对话消息包含 `run.id`、资源登记和可独立重新登录的删除补偿。

## 8. B2C 订单案例示意

以下片段只展示未来知识库扩展结构，实际动作和参数以星火 Agent 适配器清单为准。当前 `chat.ask` 只接受
清单登记的登录凭据、消息和预期文本，不接受本草案中的知识库参数：

```yaml
schemaVersion: "1.0"
kind: automated
metadata:
  name: B2C订单文件准确检索
  systemKey: spark-x-agent
  moduleKey: knowledge-base
  priority: P0
  classification: graybox
  actionLevel: write
  tags: [agent, retrieval, regression]
execution:
  stepTimeoutMs: 30000
  caseTimeoutMs: 300000
  diagnosticRetries: 1
  realModel:
    repetitions: 3
    minimumPasses: 2
    hardConstraintsMustAlwaysPass: true
resourceLocks:
  - "knowledge-base:${run.id}"
steps:
  - id: prepare-knowledge-base
    name: 准备隔离知识库和两份文件
    kind: action
    action: adapter:spark-x-agent/knowledge-base.prepare
    params:
      files:
        - 科目表.xlsx
        - B2C订单_合同抽样订单信息.xlsx
    capture:
      knowledgeBaseId: $.knowledgeBaseId
      createdResourceId: $.resourceId
    resource:
      type: knowledge-base
      id: "${step.createdResourceId}"
      cleanup:
        action: adapter:spark-x-agent/knowledge-base.cleanup
        params:
          resourceId: "${resource.id}"
  - id: ask-order-question
    name: 发送B2C订单问题
    kind: action
    action: adapter:spark-x-agent/chat.ask
    params:
      knowledgeBaseId: "${step.knowledgeBaseId}"
      prompt: "${dataset.question}"
    capture:
      trace: $.trace
      answer: $.answer
    assertions:
      - type: adapter:spark-x-agent/document-used
        actual: "${step.trace}"
        expected: B2C订单_合同抽样订单信息.xlsx
        severity: hard
      - type: adapter:spark-x-agent/document-used
        actual: "${step.trace}"
        expected: 科目表.xlsx
        negate: true
        severity: hard
      - type: adapter:spark-x-agent/answer-facts
        actual: "${step.answer}"
        expected: "${dataset.expectedFacts}"
        severity: soft
finally:
  - id: cleanup-knowledge-base
    name: 清理本次运行创建的知识库
    kind: action
    action: adapter:spark-x-agent/knowledge-base.cleanup
    params:
      resourceId: "${step.createdResourceId}"
```

`resource` 是动作步骤的可选副作用登记。动作成功后，运行引擎把资源类型、系统资源 ID 和独立补偿动作写入资源台账。常规 `finally` 成功时台账标记为已清理；`finally` 失败时，运行进入 `compensation_pending`，补偿 Worker 只允许使用 `resource.id` 和用例声明的密钥引用重新执行清理。`finally` 阶段不得创建新的资源登记。

## 9. 兼容性

- Patch 版本只能修正文档或收紧不影响既有已发布定义的校验；
- Minor 版本可增加可选字段和能力；
- Major 版本可进行不兼容调整，但运行引擎必须继续读取历史主版本；
- 导入时保留原 Schema 版本，迁移产生新草稿，不覆盖历史版本。
