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
10. 用例总超时不低于步骤理论最大耗时。

## 8. B2C 订单案例示意

以下片段只展示结构，实际动作和参数以星火 Agent 适配器清单为准：

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

## 9. 兼容性

- Patch 版本只能修正文档或收紧不影响既有已发布定义的校验；
- Minor 版本可增加可选字段和能力；
- Major 版本可进行不兼容调整，但运行引擎必须继续读取历史主版本；
- 导入时保留原 Schema 版本，迁移产生新草稿，不覆盖历史版本。
