import { createHash } from "node:crypto";

import type { AdapterManifest } from "@spark-x-test/adapter-sdk";
import {
  assertHttpTargetAllowed,
  executeHttpRequest,
  ExecutorFailure,
  interpolateString,
  type HttpExecutionEnvironment,
  type HttpExecutionResult,
} from "@spark-x-test/executors";

export const sparkXAgentActions = [
  "adapter:spark-x-agent/conversation.create",
  "adapter:spark-x-agent/conversation.assert-recent",
  "adapter:spark-x-agent/conversation.delete",
  "adapter:spark-x-agent/chat.ask",
  "adapter:spark-x-agent/chat.assert-history",
  "adapter:spark-x-agent/chat.assert-context-history",
  "adapter:spark-x-agent/tool.assert-safe-catalog",
  "adapter:spark-x-agent/tool.invoke-safe",
  "adapter:spark-x-agent/tool.assert-history",
  "adapter:spark-x-agent/knowledge-base.create",
  "adapter:spark-x-agent/knowledge-base.upload-fixture",
  "adapter:spark-x-agent/knowledge-base.attach-upload",
  "adapter:spark-x-agent/knowledge-base.wait-ready",
  "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
  "adapter:spark-x-agent/knowledge-base.cleanup",
  "adapter:spark-x-agent/skill.assert-trusted-publication",
  "adapter:spark-x-agent/automation.create",
  "adapter:spark-x-agent/automation.wait-fired",
  "adapter:spark-x-agent/automation.cleanup",
] as const;

export type SparkXAgentAction = (typeof sparkXAgentActions)[number];

export interface SparkXAgentExecutionOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

const conversationActionCapabilities = [
  {
    key: "conversation.create",
    name: "创建会话",
    description: "使用受控登录凭据创建带运行标识的星火 Agent 会话。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "conversation.delete",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "title"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        title: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["conversationId", "title"],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        title: { type: "string" },
      },
    },
  },
  {
    key: "conversation.assert-recent",
    name: "校验最近会话",
    description: "验证会话出现在最近列表的首个非置顶位置，并用历史接口核对消息数。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "title"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1, maxLength: 200 },
        expectedMessageCount: { type: "integer", minimum: 0, maximum: 99 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "listed",
        "recentPosition",
        "messageCount",
        "messageCountSource",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        listed: { const: true },
        recentPosition: { type: "integer", minimum: 0 },
        messageCount: { type: "integer", minimum: 0 },
        messageCountSource: { const: "conversation-history" },
      },
    },
  },
  {
    key: "chat.ask",
    name: "发送对话并校验回复",
    description: "向已登记测试会话发送带运行标识的受控消息，并校验完整 SSE 回复。",
    actionLevel: "write",
    defaultTimeoutMs: 120_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "message", "expectedText"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        message: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedText: { type: "string", minLength: 1, maxLength: 5_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "done",
        "expectedTextMatched",
        "contentEventCount",
        "statusEventCount",
        "assistantPreviewEventCount",
        "toolEventCount",
        "skillEventCount",
        "reviewEventCount",
        "streamBytes",
        "streamedContentLength",
        "finalContentLength",
        "finalContentSha256",
        "truncated",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        done: { const: true },
        expectedTextMatched: { const: true },
        contentEventCount: { type: "integer", minimum: 1 },
        statusEventCount: { type: "integer", minimum: 0 },
        assistantPreviewEventCount: { type: "integer", minimum: 0 },
        toolEventCount: { type: "integer", minimum: 0 },
        skillEventCount: { type: "integer", minimum: 0 },
        reviewEventCount: { type: "integer", minimum: 0 },
        streamBytes: { type: "integer", minimum: 1, maximum: 1_000_000 },
        streamedContentLength: { type: "integer", minimum: 1 },
        finalContentLength: { type: "integer", minimum: 1 },
        finalContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        truncated: { const: false },
        stopReason: { type: "string" },
        durationMs: { type: "number", minimum: 0 },
      },
    },
  },
  {
    key: "chat.assert-history",
    name: "校验对话历史",
    description: "重新登录并校验用户消息、助手回复和终止原因已完整持久化。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "expectedUserText",
        "expectedAssistantText",
        "expectedAssistantSha256",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        expectedUserText: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedAssistantText: {
          type: "string",
          minLength: 1,
          maxLength: 5_000,
        },
        expectedAssistantSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "expectedUserTextMatched",
        "expectedAssistantTextMatched",
        "assistantContentLength",
        "assistantContentSha256",
        "assistantFinishReason",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        messageCount: { type: "integer", minimum: 2 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 1 },
        expectedUserTextMatched: { const: true },
        expectedAssistantTextMatched: { const: true },
        assistantContentLength: { type: "integer", minimum: 1 },
        assistantContentSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
        },
        assistantFinishReason: { const: "stop" },
        assistantTurnStatus: { type: "string" },
      },
    },
  },
  {
    key: "chat.assert-context-history",
    name: "校验两轮上下文历史",
    description: "重新登录并校验同一会话两轮消息的顺序、流式哈希、上下文命中和跨会话隔离。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "firstUserText",
        "firstAssistantSha256",
        "secondUserText",
        "secondExpectedText",
        "secondAssistantSha256",
        "forbiddenText",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        firstUserText: { type: "string", minLength: 1, maxLength: 20_000 },
        firstAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
        secondUserText: { type: "string", minLength: 1, maxLength: 20_000 },
        secondExpectedText: { type: "string", minLength: 1, maxLength: 5_000 },
        secondAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
        forbiddenText: { type: "string", minLength: 1, maxLength: 5_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "toolMessageCount",
        "expectedOrderMatched",
        "firstAssistantHashMatched",
        "secondAssistantHashMatched",
        "secondExpectedTextMatched",
        "forbiddenTextAbsent",
        "firstAssistantContentSha256",
        "secondAssistantContentSha256",
        "assistantFinishReasonsMatched",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        messageCount: { const: 4 },
        userMessageCount: { const: 2 },
        assistantMessageCount: { const: 2 },
        toolMessageCount: { const: 0 },
        expectedOrderMatched: { const: true },
        firstAssistantHashMatched: { const: true },
        secondAssistantHashMatched: { const: true },
        secondExpectedTextMatched: { const: true },
        forbiddenTextAbsent: { const: true },
        firstAssistantContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        secondAssistantContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantFinishReasonsMatched: { const: true },
      },
    },
  },
  {
    key: "tool.assert-safe-catalog",
    name: "校验安全工具目录",
    description:
      "校验当前用户可见的 builtin-demo 只读工具目录与管理员登记目录一致，且不暴露连接凭据。",
    actionLevel: "read",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "serverName",
        "visible",
        "running",
        "credentialFieldsAbsent",
        "advertisedToolCount",
        "enabledDiscoveredToolCount",
        "expectedToolsMatched",
        "catalogSha256",
      ],
      properties: {
        serverName: { const: "builtin-demo" },
        visible: { const: true },
        running: { const: true },
        credentialFieldsAbsent: { const: true },
        advertisedToolCount: { const: 3 },
        enabledDiscoveredToolCount: { const: 3 },
        expectedToolsMatched: { const: true },
        catalogSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "tool.invoke-safe",
    name: "调用并校验安全工具",
    description:
      "通过受控对话只调用已允许的 builtin-demo 只读工具，并校验名称、参数、结果和最终回复。",
    actionLevel: "write",
    defaultTimeoutMs: 120_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "message",
        "expectedText",
        "expectedToolName",
        "expectedArgumentsJson",
        "expectedResultJson",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        message: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedText: { type: "string", minLength: 1, maxLength: 5_000 },
        expectedToolName: { type: "string", minLength: 1, maxLength: 200 },
        expectedArgumentsJson: { type: "string", minLength: 2, maxLength: 20_000 },
        expectedResultJson: { type: "string", minLength: 2, maxLength: 20_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "done",
        "expectedTextMatched",
        "expectedToolNameMatched",
        "argumentsMatched",
        "resultMatched",
        "toolCallCount",
        "toolResultCount",
        "reviewEventCount",
        "toolCallIdSha256",
        "argumentsSha256",
        "resultSha256",
        "finalContentLength",
        "finalContentSha256",
        "streamBytes",
        "truncated",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        done: { const: true },
        expectedTextMatched: { const: true },
        expectedToolNameMatched: { const: true },
        argumentsMatched: { const: true },
        resultMatched: { const: true },
        toolCallCount: { const: 1 },
        toolResultCount: { const: 1 },
        reviewEventCount: { const: 0 },
        toolCallIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        argumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        resultSha256: { type: "string", minLength: 64, maxLength: 64 },
        finalContentLength: { type: "integer", minimum: 1 },
        finalContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        streamBytes: { type: "integer", minimum: 1, maximum: 1_000_000 },
        truncated: { const: false },
      },
    },
  },
  {
    key: "tool.assert-history",
    name: "校验工具调用历史",
    description: "重新登录并校验工具调用、工具结果、公开执行轨迹和最终助手回复已一致持久化。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "expectedUserText",
        "expectedAssistantText",
        "expectedAssistantSha256",
        "expectedToolName",
        "expectedArgumentsSha256",
        "expectedResultSha256",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        expectedUserText: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedAssistantText: { type: "string", minLength: 1, maxLength: 5_000 },
        expectedAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
        expectedToolName: { type: "string", minLength: 1, maxLength: 200 },
        expectedArgumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        expectedResultSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "toolMessageCount",
        "toolCallCount",
        "toolResultCount",
        "traceToolCallCount",
        "traceToolResultCount",
        "expectedUserTextMatched",
        "expectedAssistantTextMatched",
        "expectedToolNameMatched",
        "argumentsSha256",
        "resultSha256",
        "assistantContentLength",
        "assistantContentSha256",
        "assistantFinishReason",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        messageCount: { type: "integer", minimum: 4 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 2 },
        toolMessageCount: { const: 1 },
        toolCallCount: { const: 1 },
        toolResultCount: { const: 1 },
        traceToolCallCount: { const: 1 },
        traceToolResultCount: { const: 1 },
        expectedUserTextMatched: { const: true },
        expectedAssistantTextMatched: { const: true },
        expectedToolNameMatched: { const: true },
        argumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        resultSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantContentLength: { type: "integer", minimum: 1 },
        assistantContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantFinishReason: { const: "stop" },
      },
    },
  },
  {
    key: "knowledge-base.create",
    name: "创建知识库测试资源",
    description: "创建名称含运行标识的私有知识库，并登记统一清理资源。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "knowledge-base.cleanup",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "name", "description"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        name: { type: "string", minLength: 1, maxLength: 256 },
        description: { type: "string", minLength: 1, maxLength: 4_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["knowledgeBaseId", "created", "active", "nameSha256"],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        created: { const: true },
        active: { const: true },
        nameSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "knowledge-base.upload-fixture",
    name: "上传固定知识库文件",
    description: "只上传适配器内置的受控 PDF 测试夹具，不接受页面或用例提供的任意文件内容。",
    actionLevel: "write",
    defaultTimeoutMs: 180_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "knowledgeBaseId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        knowledgeBaseId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "knowledgeBaseId",
        "uploadedDocumentId",
        "uploaded",
        "fixtureSizeBytes",
        "fixtureSha256",
        "fileNameSha256",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        uploadedDocumentId: { type: "string", format: "uuid" },
        uploaded: { const: true },
        fixtureSizeBytes: { type: "integer", minimum: 1, maximum: 1_000_000 },
        fixtureSha256: { type: "string", minLength: 64, maxLength: 64 },
        fileNameSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "knowledge-base.attach-upload",
    name: "将固定文件加入知识库",
    description: "以内存中的短期解析源地址将已上传夹具绑定到本次运行创建的知识库。",
    actionLevel: "write",
    defaultTimeoutMs: 30_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "knowledgeBaseId", "uploadedDocumentId", "title"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        knowledgeBaseId: { type: "string", format: "uuid" },
        uploadedDocumentId: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "uploadedDocumentId",
        "attached",
        "parseJobPresent",
        "documentStatus",
        "titleSha256",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        uploadedDocumentId: { type: "string", format: "uuid" },
        attached: { const: true },
        parseJobPresent: { type: "boolean" },
        documentStatus: {
          type: "string",
          enum: ["pending", "processing", "completed", "failed"],
        },
        titleSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "knowledge-base.wait-ready",
    name: "等待知识文档解析就绪",
    description: "有界轮询知识文档状态，并校验知识库计数、当前版本和内容哈希一致。",
    actionLevel: "write",
    defaultTimeoutMs: 180_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "expectedFixtureSha256",
        "expectedTitle",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        expectedFixtureSha256: { type: "string", minLength: 64, maxLength: 64 },
        expectedTitle: { type: "string", minLength: 1, maxLength: 512 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "ready",
        "documentStatus",
        "documentCount",
        "readyDocumentCount",
        "currentVersionNumber",
        "versionCount",
        "parserVersionPresent",
        "contentHashMatched",
        "titleMatched",
        "fixtureSha256",
        "pollAttempts",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        ready: { const: true },
        documentStatus: { const: "completed" },
        documentCount: { const: 1 },
        readyDocumentCount: { const: 1 },
        currentVersionNumber: { const: 1 },
        versionCount: { const: 1 },
        parserVersionPresent: { const: true },
        contentHashMatched: { const: true },
        titleMatched: { const: true },
        fixtureSha256: { type: "string", minLength: 64, maxLength: 64 },
        pollAttempts: { type: "integer", minimum: 1, maximum: 120 },
      },
    },
  },
  {
    key: "knowledge-base.assert-conversation-scope",
    name: "校验会话知识范围与不可变快照",
    description:
      "将本次运行创建的知识库绑定到测试会话，严格固定文档版本，并校验快照幂等重放与范围稳定性。",
    actionLevel: "write",
    defaultTimeoutMs: 30_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "expectedFixtureSha256",
        "clientRequestId",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        expectedFixtureSha256: { type: "string", minLength: 64, maxLength: 64 },
        clientRequestId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "retrievalPolicy",
        "scopeRevision",
        "scopeHash",
        "scopeKnowledgeBaseCount",
        "scopeDocumentCount",
        "scopeReadyDocumentCount",
        "snapshotId",
        "snapshotStatus",
        "snapshotHash",
        "snapshotKnowledgeBaseCount",
        "snapshotReadyDocumentCount",
        "snapshotExcludedDocumentCount",
        "snapshotDocumentCount",
        "scopeMatched",
        "documentMatched",
        "contentHashMatched",
        "firstCreated",
        "idempotentReplay",
        "snapshotIdentityMatched",
        "scopeStable",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        retrievalPolicy: { const: "required" },
        scopeRevision: { const: 1 },
        scopeHash: { type: "string", minLength: 64, maxLength: 64 },
        scopeKnowledgeBaseCount: { const: 1 },
        scopeDocumentCount: { const: 1 },
        scopeReadyDocumentCount: { const: 1 },
        snapshotId: { type: "string", format: "uuid" },
        snapshotStatus: { const: "prepared" },
        snapshotHash: { type: "string", minLength: 64, maxLength: 64 },
        snapshotKnowledgeBaseCount: { const: 1 },
        snapshotReadyDocumentCount: { const: 1 },
        snapshotExcludedDocumentCount: { const: 0 },
        snapshotDocumentCount: { const: 1 },
        scopeMatched: { const: true },
        documentMatched: { const: true },
        contentHashMatched: { const: true },
        firstCreated: { const: true },
        idempotentReplay: { const: true },
        snapshotIdentityMatched: { const: true },
        scopeStable: { const: true },
      },
    },
  },
  {
    key: "knowledge-base.cleanup",
    name: "清理知识库测试资源",
    description: "按已登记知识库 ID 删除其文档与原始上传，并幂等归档知识库。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 180_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "knowledgeBaseId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        knowledgeBaseId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "knowledgeBaseId",
        "cleaned",
        "knowledgeDocumentDeleteCount",
        "rawDocumentDeleted",
        "knowledgeBaseArchived",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        cleaned: { const: true },
        knowledgeDocumentDeleteCount: { type: "integer", minimum: 0 },
        rawDocumentDeleted: { type: "boolean" },
        knowledgeBaseArchived: { type: "boolean" },
        alreadyMissing: { type: "boolean" },
      },
    },
  },
  {
    key: "automation.create",
    name: "创建立即触发的自动任务",
    description: "为已登记测试会话创建固定五分钟周期、无 Skill 的立即触发任务并登记清理资源。",
    actionLevel: "write",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "automation.cleanup",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "name", "goal"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        name: { type: "string", minLength: 1, maxLength: 160 },
        goal: { type: "string", minLength: 1, maxLength: 65_536 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "automationId",
        "conversationId",
        "created",
        "enabled",
        "stateVersion",
        "intervalSeconds",
        "selectedSkillAbsent",
        "nextFireAt",
        "nameSha256",
        "goalSha256",
      ],
      properties: {
        automationId: { type: "string", format: "uuid" },
        conversationId: { type: "string", format: "uuid" },
        created: { const: true },
        enabled: { const: true },
        stateVersion: { type: "integer", minimum: 1 },
        intervalSeconds: { const: 300 },
        selectedSkillAbsent: { const: true },
        nextFireAt: { type: "string", format: "date-time" },
        nameSha256: { type: "string", minLength: 64, maxLength: 64 },
        goalSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "automation.wait-fired",
    name: "等待自动任务单次执行",
    description: "有界轮询任务调度与会话历史，验证定义未漂移、仅触发一次且无工具或 Skill 执行。",
    actionLevel: "write",
    defaultTimeoutMs: 180_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "automationId",
        "conversationId",
        "expectedName",
        "expectedGoal",
        "expectedAssistantText",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        automationId: { type: "string", format: "uuid" },
        conversationId: { type: "string", format: "uuid" },
        expectedName: { type: "string", minLength: 1, maxLength: 160 },
        expectedGoal: { type: "string", minLength: 1, maxLength: 65_536 },
        expectedAssistantText: { type: "string", minLength: 1, maxLength: 5_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "automationId",
        "conversationId",
        "fired",
        "singleFireObserved",
        "enabled",
        "stateVersion",
        "lastFireAt",
        "nextFireAt",
        "scheduleAdvancedBySeconds",
        "userMessageCount",
        "assistantMessageCount",
        "toolMessageCount",
        "toolCallCount",
        "toolTraceEventCount",
        "selectedSkillAbsent",
        "expectedAssistantTextMatched",
        "userContentSha256",
        "assistantContentSha256",
        "assistantContentLength",
        "assistantFinishReason",
        "pollAttempts",
      ],
      properties: {
        automationId: { type: "string", format: "uuid" },
        conversationId: { type: "string", format: "uuid" },
        fired: { const: true },
        singleFireObserved: { const: true },
        enabled: { const: true },
        stateVersion: { type: "integer", minimum: 2 },
        lastFireAt: { type: "string", format: "date-time" },
        nextFireAt: { type: "string", format: "date-time" },
        scheduleAdvancedBySeconds: { const: 300 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 1 },
        toolMessageCount: { const: 0 },
        toolCallCount: { const: 0 },
        toolTraceEventCount: { const: 0 },
        selectedSkillAbsent: { const: true },
        expectedAssistantTextMatched: { const: true },
        userContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantContentLength: { type: "integer", minimum: 1 },
        assistantFinishReason: { const: "stop" },
        pollAttempts: { type: "integer", minimum: 1, maximum: 120 },
      },
    },
  },
  {
    key: "automation.cleanup",
    name: "清理自动任务",
    description: "重新读取最新状态版本并幂等软删除自动任务，供 finally 与独立补偿任务使用。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 30_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "automationId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        automationId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["automationId", "cleaned", "deleted", "conflictCount"],
      properties: {
        automationId: { type: "string", format: "uuid" },
        cleaned: { const: true },
        deleted: { type: "boolean" },
        conflictCount: { type: "integer", minimum: 0, maximum: 2 },
        alreadyMissing: { type: "boolean" },
        deletedStateVersion: { type: "integer", minimum: 2 },
      },
    },
  },
  {
    key: "skill.assert-trusted-publication",
    name: "校验受信任 Skill 发布",
    description: "只读核对发布系统预置 Skill 的用户/管理员投影、有效能力、主资产和精确内容哈希。",
    actionLevel: "read",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "expectedPublicationSha256"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        expectedPublicationSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "skillId",
        "skillName",
        "available",
        "enabled",
        "builtin",
        "durableAgentTask",
        "userAdminProjectionMatched",
        "publicationHashMatched",
        "promptSha256",
        "promptSizeBytes",
        "assetRootPresent",
        "mainAssetPresent",
        "mainFileSha256",
      ],
      properties: {
        skillId: { type: "string", format: "uuid" },
        skillName: { const: "trade-port-daily-brief" },
        available: { const: true },
        enabled: { const: true },
        builtin: { const: false },
        durableAgentTask: { const: true },
        userAdminProjectionMatched: { const: true },
        publicationHashMatched: { const: true },
        promptSha256: { type: "string", minLength: 64, maxLength: 64 },
        promptSizeBytes: { type: "integer", minimum: 1, maximum: 65_536 },
        assetRootPresent: { type: "boolean" },
        mainAssetPresent: { type: "boolean" },
        mainFileSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "conversation.delete",
    name: "删除会话",
    description: "重新登录后按会话 ID 执行幂等清理，可用于 finally 与独立补偿任务。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["conversationId", "deleted"],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        deleted: { type: "boolean" },
        alreadyMissing: { type: "boolean" },
      },
    },
  },
] as const;

export const sparkXAgentAdapterManifest: AdapterManifest = {
  manifestVersion: "1.0",
  key: "spark-x-agent",
  name: "星火 Agent",
  version: "0.8.2",
  protocolVersion: "1.0",
  platformRange: ">=0.1.0 <0.2.0",
  environmentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: { baseUrl: { type: "string", format: "uri" } },
  },
  capabilities: {
    actions: conversationActionCapabilities,
    assertions: [],
    fixtures: [],
    telemetry: [],
  },
};

export const sparkXAgentAdapterPhase = "core-smoke-reopen" as const;

const maxChatStreamBytes = 1_000_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const safeToolServerName = "builtin-demo";
const safeToolCatalog = ["calculator", "echo", "time"] as const;
const safeQualifiedToolNames = new Set(
  safeToolCatalog.map((name) => `${safeToolServerName}__${name}`),
);
const trustedSkillName = "trade-port-daily-brief";
const trustedSkillDisplayName = "贸易与港口每日简报";
const trustedSkillCategory = "utility";
const trustedSkillBusinessType = "行业研究";
const trustedSkillMainFile = "trade-port-daily-brief.md";
const privateCatalogFields = [
  "command",
  "args",
  "env",
  "address",
  "cwd",
  "filesystem_path",
  "last_error",
] as const;

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertBoundedJson(
  value: unknown,
  failure: () => ExecutorFailure,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): void {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > 2_000) throw failure();
  if (typeof value === "number" && !Number.isFinite(value)) throw failure();
  if (typeof value === "string" && value.length > 20_000) throw failure();
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw failure();
    value.forEach((item) => assertBoundedJson(item, failure, depth + 1, budget));
    return;
  }
  const object = objectValue(value);
  if (object === null) return;
  const entries = Object.entries(object);
  if (entries.length > 1_000) throw failure();
  entries.forEach(([key, item]) => {
    if (key.length > 500) throw failure();
    assertBoundedJson(item, failure, depth + 1, budget);
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = objectValue(value);
  if (object !== null) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function structuredObject(
  value: unknown,
  code: string,
  message: string,
  classification: "product_failed" | "test_failed",
): Readonly<Record<string, unknown>> {
  const failure = (): ExecutorFailure => new ExecutorFailure({ code, message, classification });
  let parsed = value;
  if (typeof value === "string") {
    if (value.length > 20_000) throw failure();
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new ExecutorFailure({ code, message, classification }, error);
    }
  }
  const object = objectValue(parsed);
  if (object === null) throw failure();
  assertBoundedJson(object, failure);
  return object;
}

function expectedJsonObject(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const value = requiredString(params, name, variables, 20_000);
  return structuredObject(
    value,
    "SPARK_X_AGENT_PARAMETER_INVALID",
    `星火 Agent 适配器参数 ${name} 必须是受限 JSON 对象。`,
    "test_failed",
  );
}

function requiredSha256(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
): string {
  const value = requiredString(params, name, variables, 64);
  if (!sha256Pattern.test(value)) {
    throw assertionFailure(
      "SPARK_X_AGENT_PARAMETER_INVALID",
      `星火 Agent 适配器参数 ${name} 必须是 64 位小写 SHA-256。`,
    );
  }
  return value;
}

function requiredUuid(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
): string {
  const value = requiredString(params, name, variables, 100);
  if (!uuidPattern.test(value)) {
    throw assertionFailure(
      "SPARK_X_AGENT_PARAMETER_INVALID",
      `星火 Agent 适配器参数 ${name} 必须是有效 UUID。`,
    );
  }
  return value;
}

function requiredSafeToolName(
  params: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
): string {
  const value = requiredString(params, "expectedToolName", variables, 200);
  if (!safeQualifiedToolNames.has(value)) {
    throw assertionFailure(
      "SPARK_X_AGENT_TOOL_NOT_ALLOWED",
      "当前星火 Agent 工具回归动作只允许 builtin-demo 只读工具。",
    );
  }
  return value;
}

function requiredString(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
  maxLength: number,
): string {
  const value = params[name];
  if (typeof value !== "string") {
    throw new ExecutorFailure({
      code: "SPARK_X_AGENT_PARAMETER_INVALID",
      message: `星火 Agent 适配器缺少字符串参数 ${name}。`,
      classification: "test_failed",
    });
  }
  const interpolated = interpolateString(value, variables);
  if (interpolated.trim() === "" || interpolated.length > maxLength) {
    throw new ExecutorFailure({
      code: "SPARK_X_AGENT_PARAMETER_INVALID",
      message: `星火 Agent 适配器参数 ${name} 为空或超过安全长度。`,
      classification: "test_failed",
    });
  }
  return interpolated;
}

function optionalBoundedInteger(
  params: Readonly<Record<string, unknown>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ExecutorFailure({
      code: "SPARK_X_AGENT_PARAMETER_INVALID",
      message: `星火 Agent 适配器参数 ${name} 必须是 ${minimum} 到 ${maximum} 的整数。`,
      classification: "test_failed",
    });
  }
  return value;
}

function apiFailure(code: string, message: string, status?: number): ExecutorFailure {
  return new ExecutorFailure({
    code,
    message,
    classification:
      status === 401 || status === 403 || status === 429 || (status !== undefined && status >= 502)
        ? "environment_failed"
        : "product_failed",
  });
}

function assertionFailure(code: string, message: string): ExecutorFailure {
  return new ExecutorFailure({ code, message, classification: "test_failed" });
}

function environmentFailure(code: string, message: string): ExecutorFailure {
  return new ExecutorFailure({ code, message, classification: "environment_failed" });
}

function dataEnvelope(body: unknown, code: string): Readonly<Record<string, unknown>> {
  const envelope = objectValue(body);
  const data = envelope === null ? null : objectValue(envelope.data);
  if (envelope?.success !== true || data === null) {
    throw apiFailure(code, "星火 Agent 返回了不完整的结构化响应。");
  }
  return data;
}

function successfulData(body: unknown, code: string): unknown {
  const envelope = objectValue(body);
  if (envelope?.success !== true || !Object.hasOwn(envelope, "data")) {
    throw apiFailure(code, "星火 Agent 返回了不完整的结构化响应。");
  }
  return envelope.data;
}

function accepted(response: HttpExecutionResult, code: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw apiFailure(code, `星火 Agent 接口返回 HTTP ${response.status}。`, response.status);
  }
}

function acceptedKnowledgeRuntime(response: HttpExecutionResult, code: string): void {
  if (response.status >= 500) {
    throw environmentFailure(code, `星火 Agent 知识库运行时返回 HTTP ${response.status}。`);
  }
  accepted(response, code);
}

interface KnowledgeScopeProjection {
  readonly conversationId: string;
  readonly retrievalPolicy: string;
  readonly status: string;
  readonly revision: number;
  readonly scopeHash: string | null;
  readonly knowledgeBaseIds: readonly string[];
  readonly knowledgeBases: readonly Readonly<Record<string, unknown>>[];
}

function knowledgeScopeProjection(
  body: unknown,
  conversationId: string,
  code: string,
): KnowledgeScopeProjection {
  const data = dataEnvelope(body, code);
  const knowledgeBaseIds = Array.isArray(data.knowledge_base_ids) ? data.knowledge_base_ids : null;
  const knowledgeBases = Array.isArray(data.knowledge_bases)
    ? data.knowledge_bases
        .map(objectValue)
        .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
    : null;
  if (
    data.conversation_id !== conversationId ||
    typeof data.retrieval_policy !== "string" ||
    typeof data.status !== "string" ||
    !Number.isInteger(data.revision) ||
    (data.scope_hash !== null &&
      (typeof data.scope_hash !== "string" || !sha256Pattern.test(data.scope_hash))) ||
    knowledgeBaseIds === null ||
    knowledgeBaseIds.some((id) => typeof id !== "string" || !uuidPattern.test(id)) ||
    knowledgeBases === null ||
    knowledgeBases.length !==
      (Array.isArray(data.knowledge_bases) ? data.knowledge_bases.length : -1)
  ) {
    throw apiFailure(code, "会话知识范围响应结构不完整或标识不一致。");
  }
  return {
    conversationId,
    retrievalPolicy: data.retrieval_policy,
    status: data.status,
    revision: data.revision as number,
    scopeHash: data.scope_hash,
    knowledgeBaseIds: knowledgeBaseIds as string[],
    knowledgeBases,
  };
}

interface KnowledgeSnapshotProjection {
  readonly id: string;
  readonly scopeId: string;
  readonly scopeRevision: number;
  readonly scopeHash: string;
  readonly snapshotHash: string;
  readonly status: string;
  readonly knowledgeBaseCount: number;
  readonly readyDocumentCount: number;
  readonly excludedDocumentCount: number;
  readonly knowledgeBaseId: string;
  readonly knowledgeDocumentId: string;
  readonly knowledgeVersionId: string;
  readonly rustDocumentId: string;
  readonly parserDocumentId: string;
  readonly parserVersionId: string;
  readonly versionNumber: number;
  readonly contentHash: string;
  readonly idempotentReplay: boolean;
}

function knowledgeSnapshotProjection(
  body: unknown,
  expected: {
    readonly conversationId: string;
    readonly clientRequestId: string;
  },
  code: string,
): KnowledgeSnapshotProjection {
  const data = dataEnvelope(body, code);
  const documents = Array.isArray(data.documents)
    ? data.documents
        .map(objectValue)
        .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
    : null;
  const document = documents?.[0];
  if (
    typeof data.id !== "string" ||
    !uuidPattern.test(data.id) ||
    data.conversation_id !== expected.conversationId ||
    typeof data.scope_id !== "string" ||
    !uuidPattern.test(data.scope_id) ||
    !Number.isInteger(data.scope_revision) ||
    typeof data.scope_hash !== "string" ||
    !sha256Pattern.test(data.scope_hash) ||
    data.client_request_id !== expected.clientRequestId ||
    typeof data.retrieval_policy !== "string" ||
    typeof data.status !== "string" ||
    typeof data.snapshot_hash !== "string" ||
    !sha256Pattern.test(data.snapshot_hash) ||
    !Number.isInteger(data.knowledge_base_count) ||
    !Number.isInteger(data.ready_document_count) ||
    !Number.isInteger(data.excluded_document_count) ||
    typeof data.idempotent_replay !== "boolean" ||
    documents === null ||
    documents.length !== (Array.isArray(data.documents) ? data.documents.length : -1) ||
    documents.length !== 1 ||
    document === undefined ||
    typeof document.knowledge_base_id !== "string" ||
    !uuidPattern.test(document.knowledge_base_id) ||
    typeof document.knowledge_document_id !== "string" ||
    !uuidPattern.test(document.knowledge_document_id) ||
    typeof document.knowledge_version_id !== "string" ||
    !uuidPattern.test(document.knowledge_version_id) ||
    typeof document.rust_document_id !== "string" ||
    !uuidPattern.test(document.rust_document_id) ||
    typeof document.parser_document_id !== "string" ||
    document.parser_document_id.length === 0 ||
    document.parser_document_id.length > 200 ||
    typeof document.parser_version_id !== "string" ||
    document.parser_version_id.length === 0 ||
    document.parser_version_id.length > 200 ||
    !Number.isInteger(document.version_number) ||
    typeof document.content_hash !== "string" ||
    !sha256Pattern.test(document.content_hash)
  ) {
    throw apiFailure(code, "知识范围快照响应结构不完整或标识不一致。");
  }
  return {
    id: data.id,
    scopeId: data.scope_id,
    scopeRevision: data.scope_revision as number,
    scopeHash: data.scope_hash,
    snapshotHash: data.snapshot_hash,
    status: data.status,
    knowledgeBaseCount: data.knowledge_base_count as number,
    readyDocumentCount: data.ready_document_count as number,
    excludedDocumentCount: data.excluded_document_count as number,
    knowledgeBaseId: document.knowledge_base_id,
    knowledgeDocumentId: document.knowledge_document_id,
    knowledgeVersionId: document.knowledge_version_id,
    rustDocumentId: document.rust_document_id,
    parserDocumentId: document.parser_document_id,
    parserVersionId: document.parser_version_id,
    versionNumber: document.version_number as number,
    contentHash: document.content_hash,
    idempotentReplay: data.idempotent_replay,
  };
}

function acceptedSkillRuntime(response: HttpExecutionResult, code: string): void {
  if (response.status >= 500) {
    throw environmentFailure(code, `星火 Agent Skill 运行时返回 HTTP ${response.status}。`);
  }
  accepted(response, code);
}

function acceptedAutomationRuntime(response: HttpExecutionResult, code: string): void {
  if (response.status >= 500) {
    throw environmentFailure(code, `星火 Agent 自动任务运行时返回 HTTP ${response.status}。`);
  }
  accepted(response, code);
}

interface AutomationDefinitionProjection {
  readonly automationId: string;
  readonly conversationId: string;
  readonly name: string;
  readonly goal: string;
  readonly intervalSeconds: number;
  readonly status: string;
  readonly stateVersion: number;
  readonly nextFireAt: string;
  readonly lastFireAt: string | null;
  readonly selectedSkillId: string | null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && Number.isFinite(Date.parse(value));
}

function automationDefinitionProjection(
  value: unknown,
  code: string,
): AutomationDefinitionProjection {
  const definition = objectValue(value);
  if (
    definition === null ||
    typeof definition.definition_id !== "string" ||
    !uuidPattern.test(definition.definition_id) ||
    typeof definition.conversation_id !== "string" ||
    !uuidPattern.test(definition.conversation_id) ||
    typeof definition.name !== "string" ||
    definition.name.length === 0 ||
    definition.name.length > 160 ||
    typeof definition.goal !== "string" ||
    definition.goal.length === 0 ||
    definition.goal.length > 65_536 ||
    !Number.isInteger(definition.interval_seconds) ||
    typeof definition.status !== "string" ||
    !Number.isInteger(definition.state_version) ||
    Number(definition.state_version) < 1 ||
    !validTimestamp(definition.next_fire_at) ||
    (definition.last_fire_at !== null && !validTimestamp(definition.last_fire_at)) ||
    (definition.selected_skill_id !== null && typeof definition.selected_skill_id !== "string")
  ) {
    throw apiFailure(code, "星火 Agent 自动任务定义响应缺少受限公开字段。");
  }
  return {
    automationId: definition.definition_id,
    conversationId: definition.conversation_id,
    name: definition.name,
    goal: definition.goal,
    intervalSeconds: Number(definition.interval_seconds),
    status: definition.status,
    stateVersion: Number(definition.state_version),
    nextFireAt: definition.next_fire_at,
    lastFireAt: typeof definition.last_fire_at === "string" ? definition.last_fire_at : null,
    selectedSkillId:
      typeof definition.selected_skill_id === "string" ? definition.selected_skill_id : null,
  };
}

function listedAutomation(
  response: HttpExecutionResult,
  automationId: string,
  code: string,
): AutomationDefinitionProjection | null {
  acceptedAutomationRuntime(response, code);
  const body = objectValue(response.body);
  if (body === null || !Array.isArray(body.items) || body.items.length > 100) {
    throw apiFailure(code, "星火 Agent 自动任务列表响应不完整或超过安全边界。");
  }
  const matches = body.items
    .map((item) => objectValue(item))
    .filter((item) => item?.definition_id === automationId);
  if (matches.length > 1) {
    throw apiFailure(code, "星火 Agent 自动任务列表返回了重复定义标识。");
  }
  return matches[0] === undefined ? null : automationDefinitionProjection(matches[0], code);
}

interface AutomationHistoryEvidence {
  readonly userMessageCount: 1;
  readonly assistantMessageCount: 1;
  readonly toolMessageCount: 0;
  readonly toolCallCount: 0;
  readonly toolTraceEventCount: 0;
  readonly userContentSha256: string;
  readonly assistantContentSha256: string;
  readonly assistantContentLength: number;
}

function automationHistoryEvidence(
  body: unknown,
  expectedGoal: string,
  expectedAssistantText: string,
): AutomationHistoryEvidence | null {
  const data = dataEnvelope(body, "SPARK_X_AGENT_AUTOMATION_HISTORY_RESPONSE_INVALID");
  if (!Array.isArray(data.items) || data.items.length > 100) {
    throw apiFailure(
      "SPARK_X_AGENT_AUTOMATION_HISTORY_RESPONSE_INVALID",
      "自动任务目标会话历史不完整或超过安全边界。",
    );
  }
  const items = data.items.map((item) => objectValue(item));
  if (items.some((item) => item === null)) {
    throw apiFailure(
      "SPARK_X_AGENT_AUTOMATION_HISTORY_RESPONSE_INVALID",
      "自动任务目标会话历史包含无效消息。",
    );
  }
  const messages = items as readonly Readonly<Record<string, unknown>>[];
  if (messages.some((item) => item.payload_truncated === true)) {
    throw apiFailure(
      "SPARK_X_AGENT_AUTOMATION_HISTORY_TRUNCATED",
      "自动任务目标会话历史包含已截断的公开消息。",
    );
  }
  const userMessages = messages.filter((item) => item.role === "user");
  const assistantMessages = messages.filter((item) => item.role === "assistant");
  const toolMessages = messages.filter((item) => item.role === "tool");
  const toolCallCount = assistantMessages.reduce(
    (count, item) => count + (Array.isArray(item.tool_calls) ? item.tool_calls.length : 0),
    0,
  );
  const toolTraceEventCount = messages.reduce((count, item) => {
    if (!Array.isArray(item.public_execution_trace)) return count;
    return (
      count +
      item.public_execution_trace.filter((event) => {
        const trace = objectValue(event);
        return trace?.kind === "tool_call" || trace?.kind === "tool_result";
      }).length
    );
  }, 0);
  if (
    userMessages.length > 1 ||
    assistantMessages.length > 1 ||
    toolMessages.length > 0 ||
    toolCallCount > 0 ||
    toolTraceEventCount > 0
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_AUTOMATION_SINGLE_FIRE_FAILED",
      "立即触发自动任务产生了重复消息或不允许的工具执行。",
    );
  }
  const user = userMessages[0];
  const assistant = assistantMessages[0];
  if (user === undefined || assistant === undefined) return null;
  if (user.content !== expectedGoal) {
    throw apiFailure(
      "SPARK_X_AGENT_AUTOMATION_GOAL_MISMATCH",
      "自动任务持久化的用户目标与已创建定义不一致。",
    );
  }
  if (assistant.finish_reason === null || assistant.finish_reason === undefined) return null;
  if (assistant.finish_reason !== "stop") {
    throw assertionFailure(
      "SPARK_X_AGENT_AUTOMATION_FINISH_REASON_FAILED",
      "自动任务助手回复没有以 stop 正常结束。",
    );
  }
  if (
    typeof assistant.content !== "string" ||
    assistant.content.length === 0 ||
    !assistant.content.includes(expectedAssistantText)
  ) {
    throw assertionFailure(
      "SPARK_X_AGENT_AUTOMATION_ASSISTANT_ASSERTION_FAILED",
      "自动任务助手回复未包含预期运行标识。",
    );
  }
  return {
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolMessageCount: 0,
    toolCallCount: 0,
    toolTraceEventCount: 0,
    userContentSha256: sha256(expectedGoal),
    assistantContentSha256: sha256(assistant.content),
    assistantContentLength: assistant.content.length,
  };
}

function actionPath(suffix: string): string {
  return `/trade/api${suffix}`;
}

function domainActionPath(suffix: string): string {
  return `/trade-domain-api${suffix}`;
}

interface KnowledgeFixture {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly sha256: string;
}

function buildKnowledgeFixture(knowledgeBaseId: string): KnowledgeFixture {
  if (!uuidPattern.test(knowledgeBaseId)) {
    throw assertionFailure(
      "SPARK_X_AGENT_PARAMETER_INVALID",
      "知识库测试资源标识必须是有效 UUID。",
    );
  }
  const lines = [
    "SPARK_X_KB_FIXTURE",
    `RUN_RESOURCE_ID: ${knowledgeBaseId}`,
    "ORDER_ID: B2C-KB-001",
    "CUSTOMER_CODE: SPARK-REGRESSION",
    "AMOUNT_CNY: 4200",
    "STATUS: PAID",
  ];
  const content = ["BT", "/F1 12 Tf", "72 720 Td"];
  lines.forEach((line, index) => {
    if (index > 0) content.push("0 -18 Td");
    content.push(`(${line}) Tj`);
  });
  content.push("ET");
  const stream = `${content.join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${new TextEncoder().encode(stream).byteLength} >>\nstream\n${stream}endstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).byteLength);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(source).byteLength;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const bytes = new TextEncoder().encode(source);
  return {
    bytes,
    fileName: `spark-x-kb-${knowledgeBaseId}.pdf`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function boundedJsonResponse(
  response: Response,
  code: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (response.body === null) {
    if (response.status >= 500) {
      throw environmentFailure(code, "星火 Agent 知识库运行时返回了空响应。");
    }
    throw apiFailure(code, "星火 Agent 返回了空的结构化响应。", response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        if (response.status >= 500) {
          throw environmentFailure(code, "星火 Agent 知识库运行时响应超过安全上限。");
        }
        throw apiFailure(code, "星火 Agent 结构化响应超过 1000000 字节安全上限。", 502);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const object = objectValue(parsed);
    if (object === null) throw new Error("response is not an object");
    assertBoundedJson(object, () => apiFailure(code, "星火 Agent 结构化响应超过安全边界。"));
    return object;
  } catch (error) {
    if (error instanceof ExecutorFailure) throw error;
    if (response.status >= 500) {
      throw new ExecutorFailure(
        {
          code,
          message: "星火 Agent 知识库运行时返回了无法解析的响应。",
          classification: "environment_failed",
        },
        error,
      );
    }
    throw new ExecutorFailure(
      {
        code,
        message: "星火 Agent 返回了无法解析的结构化响应。",
        classification: "product_failed",
      },
      error,
    );
  }
}

async function uploadKnowledgeFixture(
  environment: HttpExecutionEnvironment,
  token: string,
  knowledgeBaseId: string,
  fixture: KnowledgeFixture,
  options: SparkXAgentExecutionOptions,
): Promise<Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>> {
  let target = new URL(actionPath("/documents/upload"), environment.baseUrl);
  assertHttpTargetAllowed(target, environment.allowlist);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Spark X Agent fixture upload timed out")),
    options.timeoutMs,
  );
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const form = new FormData();
      form.append(
        "metadata",
        JSON.stringify({
          filename: fixture.fileName,
          mime_type: "application/pdf",
          size_bytes: fixture.bytes.byteLength,
          sha256: fixture.sha256,
          conversation_id: null,
          folder_id: null,
        }),
      );
      form.append(
        "file",
        new Blob(
          [
            fixture.bytes.buffer.slice(
              fixture.bytes.byteOffset,
              fixture.bytes.byteOffset + fixture.bytes.byteLength,
            ) as ArrayBuffer,
          ],
          { type: "application/pdf" },
        ),
        fixture.fileName,
      );
      const response = await (options.fetcher ?? fetch)(target, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": knowledgeBaseId,
        },
        body: form,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null || ![307, 308].includes(response.status) || redirect === 5) {
          throw new ExecutorFailure({
            code: "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_REDIRECT_INVALID",
            message: "知识库固定夹具上传返回了不安全的重定向。",
            classification: "environment_failed",
          });
        }
        target = new URL(location, target);
        assertHttpTargetAllowed(target, environment.allowlist);
        continue;
      }
      return {
        status: response.status,
        body: await boundedJsonResponse(
          response,
          "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_RESPONSE_INVALID",
        ),
      };
    }
    throw environmentFailure(
      "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_REDIRECT_INVALID",
      "知识库固定夹具上传重定向未收敛。",
    );
  } catch (error) {
    if (error instanceof ExecutorFailure) throw error;
    if (controller.signal.aborted) {
      const externallyCancelled = options.signal?.aborted === true;
      throw new ExecutorFailure(
        {
          code: externallyCancelled
            ? "EXECUTION_CANCELLED"
            : "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_TIMEOUT",
          message: externallyCancelled ? "运行已取消。" : "知识库固定夹具上传超时。",
          classification: "environment_failed",
        },
        error,
      );
    }
    throw new ExecutorFailure(
      {
        code: "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_NETWORK_ERROR",
        message: "知识库固定夹具上传目标无法访问。",
        classification: "environment_failed",
      },
      error,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function boundedDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    throw environmentFailure("EXECUTION_CANCELLED", "运行已取消。");
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(environmentFailure("EXECUTION_CANCELLED", "运行已取消。"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function executeSparkXAgentRequest(
  environment: HttpExecutionEnvironment,
  parameters: Parameters<typeof executeHttpRequest>[1],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fetcher: typeof fetch | undefined,
): Promise<HttpExecutionResult> {
  return executeHttpRequest(
    environment,
    parameters,
    {},
    {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      ...(fetcher === undefined ? {} : { fetcher }),
    },
  );
}

async function login(
  environment: HttpExecutionEnvironment,
  username: string,
  password: string,
  options: SparkXAgentExecutionOptions,
): Promise<string> {
  const response = await executeSparkXAgentRequest(
    environment,
    {
      method: "POST",
      path: actionPath("/auth/login"),
      headers: { "Content-Type": "application/json" },
      body: { username, password },
    },
    options.timeoutMs,
    options.signal,
    options.fetcher,
  );
  accepted(response, "SPARK_X_AGENT_AUTH_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_AUTH_RESPONSE_INVALID");
  if (typeof data.token !== "string" || data.token.length < 16) {
    throw apiFailure(
      "SPARK_X_AGENT_AUTH_RESPONSE_INVALID",
      "星火 Agent 登录响应未提供有效的内存访问令牌。",
    );
  }
  return data.token;
}

async function authenticatedRequest(
  environment: HttpExecutionEnvironment,
  token: string,
  parameters: Parameters<typeof executeHttpRequest>[1],
  options: SparkXAgentExecutionOptions,
): Promise<HttpExecutionResult> {
  return executeSparkXAgentRequest(
    environment,
    {
      ...parameters,
      headers: { ...parameters.headers, Authorization: `Bearer ${token}` },
    },
    options.timeoutMs,
    options.signal,
    options.fetcher,
  );
}

interface UploadedFixtureProjection {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentSha256: string;
}

function uploadedFixtureProjection(
  body: unknown,
  expected?: KnowledgeFixture,
): UploadedFixtureProjection {
  const data = dataEnvelope(body, "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_RESPONSE_INVALID");
  const name = typeof data.name === "string" ? data.name : data.title;
  const sizeBytes = data.size_bytes;
  const contentSha256 = data.content_sha256;
  if (
    typeof data.id !== "string" ||
    !uuidPattern.test(data.id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    typeof contentSha256 !== "string" ||
    !sha256Pattern.test(contentSha256)
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_RESPONSE_INVALID",
      "知识库固定夹具上传响应缺少受限公开字段。",
    );
  }
  if (
    expected !== undefined &&
    (name !== expected.fileName ||
      sizeBytes !== expected.bytes.byteLength ||
      contentSha256 !== expected.sha256)
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_INTEGRITY_FAILED",
      "知识库固定夹具上传后的名称、大小或 SHA-256 与本地固定资产不一致。",
    );
  }
  return { id: data.id, name, sizeBytes, contentSha256 };
}

async function recoverUploadedFixture(
  environment: HttpExecutionEnvironment,
  token: string,
  knowledgeBaseId: string,
  expected: KnowledgeFixture | undefined,
  allowMissing: boolean,
  remainingOptions: () => SparkXAgentExecutionOptions,
): Promise<UploadedFixtureProjection | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/documents/upload-status/${encodeURIComponent(knowledgeBaseId)}`),
      },
      remainingOptions(),
    );
    if (response.status === 200) return uploadedFixtureProjection(response.body, expected);
    if (response.status === 404) {
      if (allowMissing) return null;
      if (attempt >= 3) {
        throw environmentFailure(
          "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_OUTCOME_UNKNOWN",
          "知识库固定夹具上传结果无法通过幂等键确认。",
        );
      }
    } else if (response.status !== 202) {
      acceptedKnowledgeRuntime(response, "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_STATUS_FAILED");
    }
    await boundedDelay(500, remainingOptions().signal);
  }
  throw environmentFailure(
    "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_PENDING",
    "知识库固定夹具上传状态未在有界时间内收敛。",
  );
}

interface SparkXAgentToolCallTrace {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface SparkXAgentToolResultTrace {
  readonly id: string;
  readonly name: string;
  readonly result: Readonly<Record<string, unknown>>;
  readonly success: boolean;
}

interface SparkXAgentChatResult {
  readonly conversationId: string;
  readonly contentEventCount: number;
  readonly statusEventCount: number;
  readonly assistantPreviewEventCount: number;
  readonly toolEventCount: number;
  readonly skillEventCount: number;
  readonly reviewEventCount: number;
  readonly toolCalls: readonly SparkXAgentToolCallTrace[];
  readonly toolResults: readonly SparkXAgentToolResultTrace[];
  readonly streamBytes: number;
  readonly streamedContent: string;
  readonly finalContent: string;
  readonly truncated: boolean;
  readonly stopReason?: string;
  readonly durationMs?: number;
}

function parseChatStream(text: string, streamBytes: number): SparkXAgentChatResult {
  let conversationId: string | undefined;
  let streamedContent = "";
  let finalContent: string | undefined;
  let truncated = false;
  let doneEventCount = 0;
  let contentEventCount = 0;
  let statusEventCount = 0;
  let assistantPreviewEventCount = 0;
  let toolEventCount = 0;
  let skillEventCount = 0;
  let reviewEventCount = 0;
  const toolCalls: SparkXAgentToolCallTrace[] = [];
  const toolResults: SparkXAgentToolResultTrace[] = [];
  let stopReason: string | undefined;
  let durationMs: number | undefined;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("data:")) continue;
    const rawData = line.slice(5).trimStart();
    if (rawData === "") continue;
    let payload: Readonly<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(rawData) as unknown;
      const record = objectValue(parsed);
      if (record === null) throw new Error("SSE payload is not an object");
      payload = record;
    } catch (error) {
      throw new ExecutorFailure(
        {
          code: "SPARK_X_AGENT_CHAT_STREAM_INVALID",
          message: "星火 Agent 对话流包含无法解析的结构化事件。",
          classification: "product_failed",
        },
        error,
      );
    }
    const event = payload.event;
    const data = objectValue(payload.data) ?? {};
    if (event === "conversation_id") {
      if (typeof data.conversation_id === "string") conversationId = data.conversation_id;
    } else if (event === "content") {
      if (typeof data.content !== "string") {
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_STREAM_INVALID",
          "星火 Agent 内容事件缺少字符串增量。",
        );
      }
      contentEventCount += 1;
      streamedContent += data.content;
    } else if (event === "status" || event === "progress" || event === "heartbeat") {
      statusEventCount += 1;
    } else if (event === "assistant_preview") {
      assistantPreviewEventCount += 1;
    } else if (event === "tool_call") {
      toolEventCount += 1;
      if (
        typeof data.id !== "string" ||
        data.id.trim() === "" ||
        data.id.length > 512 ||
        typeof data.name !== "string" ||
        data.name.trim() === "" ||
        data.name.length > 200
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具调用事件缺少受限标识或工具名称。",
        );
      }
      toolCalls.push({
        id: data.id,
        name: data.name,
        arguments: structuredObject(
          data.arguments,
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具调用事件缺少受限结构化参数。",
          "product_failed",
        ),
      });
    } else if (event === "tool_result") {
      toolEventCount += 1;
      if (
        typeof data.id !== "string" ||
        data.id.trim() === "" ||
        data.id.length > 512 ||
        typeof data.name !== "string" ||
        data.name.trim() === "" ||
        data.name.length > 200 ||
        typeof data.success !== "boolean"
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具结果事件缺少受限标识、名称或成功状态。",
        );
      }
      toolResults.push({
        id: data.id,
        name: data.name,
        result: structuredObject(
          data.result,
          "SPARK_X_AGENT_TOOL_TRACE_INVALID",
          "星火 Agent 工具结果事件缺少受限结构化结果。",
          "product_failed",
        ),
        success: data.success,
      });
    } else if (event === "skill") {
      skillEventCount += 1;
    } else if (event === "review_required") {
      reviewEventCount += 1;
    } else if (event === "done") {
      doneEventCount += 1;
      truncated = data.truncated === true;
      if (typeof data.final_content === "string") finalContent = data.final_content;
      if (typeof data.stop_reason === "string") stopReason = data.stop_reason;
      if (typeof data.duration_ms === "number" && Number.isFinite(data.duration_ms)) {
        durationMs = Math.max(0, data.duration_ms);
      }
    } else if (event === "error") {
      throw apiFailure("SPARK_X_AGENT_CHAT_STREAM_ERROR", "星火 Agent 对话流返回了终止错误事件。");
    }
  }

  if (doneEventCount === 0) {
    throw apiFailure("SPARK_X_AGENT_CHAT_STREAM_INCOMPLETE", "星火 Agent 对话流在完整结果前中断。");
  }
  if (doneEventCount !== 1) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_TERMINAL_DUPLICATED",
      "星火 Agent 对话流返回了重复的终态事件。",
    );
  }
  if (conversationId === undefined || !uuidPattern.test(conversationId)) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_CONVERSATION_INVALID",
      "星火 Agent 对话流未返回有效会话标识。",
    );
  }
  if (truncated) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_TRUNCATED",
      "星火 Agent 对话结果已截断，不能作为回归证据。",
    );
  }
  if (
    contentEventCount === 0 ||
    streamedContent === "" ||
    finalContent === undefined ||
    finalContent === ""
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_CHAT_CONTENT_INCOMPLETE",
      "星火 Agent 对话流未返回完整的非空助手回复。",
    );
  }
  return {
    conversationId,
    contentEventCount,
    statusEventCount,
    assistantPreviewEventCount,
    toolEventCount,
    skillEventCount,
    reviewEventCount,
    toolCalls,
    toolResults,
    streamBytes,
    streamedContent,
    finalContent,
    truncated,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

async function readBoundedChatStream(
  response: Response,
): Promise<Readonly<{ text: string; bytes: number }>> {
  if (response.body === null) {
    throw apiFailure("SPARK_X_AGENT_CHAT_STREAM_MISSING", "星火 Agent 没有返回可读取的对话流。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxChatStreamBytes) {
        await reader.cancel();
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_STREAM_TOO_LARGE",
          "星火 Agent 对话流超过 1000000 字节安全上限。",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } finally {
    reader.releaseLock();
  }
}

async function streamChat(
  environment: HttpExecutionEnvironment,
  token: string,
  expectedConversationId: string,
  message: string,
  options: SparkXAgentExecutionOptions,
): Promise<SparkXAgentChatResult> {
  let target = new URL(actionPath("/chat"), environment.baseUrl);
  assertHttpTargetAllowed(target, environment.allowlist);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Spark X Agent chat timed out")),
    options.timeoutMs,
  );
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const response = await (options.fetcher ?? fetch)(target, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message, conversation_id: expectedConversationId }),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new ExecutorFailure({
            code: "INVALID_REDIRECT",
            message: "星火 Agent 对话重定向缺少目标地址。",
            classification: "environment_failed",
          });
        }
        if (redirect === 5) {
          throw new ExecutorFailure({
            code: "TOO_MANY_REDIRECTS",
            message: "星火 Agent 对话重定向次数超过上限。",
            classification: "environment_failed",
          });
        }
        target = new URL(location, target);
        assertHttpTargetAllowed(target, environment.allowlist);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_REQUEST_FAILED",
          `星火 Agent 对话接口返回 HTTP ${response.status}。`,
          response.status,
        );
      }
      const stream = await readBoundedChatStream(response);
      const result = parseChatStream(stream.text, stream.bytes);
      if (result.conversationId !== expectedConversationId) {
        throw apiFailure(
          "SPARK_X_AGENT_CHAT_CONVERSATION_MISMATCH",
          "星火 Agent 对话流返回了非预期的会话标识。",
        );
      }
      return result;
    }
    throw new ExecutorFailure({
      code: "INVALID_REDIRECT",
      message: "星火 Agent 对话重定向无有效结果。",
      classification: "environment_failed",
    });
  } catch (error) {
    if (error instanceof ExecutorFailure) throw error;
    if (controller.signal.aborted) {
      const externallyCancelled =
        options.signal?.aborted === true &&
        options.signal.reason instanceof Error &&
        ["Run cancellation requested", "Cancellation state unavailable"].includes(
          options.signal.reason.message,
        );
      throw new ExecutorFailure(
        {
          code: externallyCancelled ? "EXECUTION_CANCELLED" : "SPARK_X_AGENT_CHAT_TIMEOUT",
          message: externallyCancelled ? "运行已取消。" : "星火 Agent 对话请求超时。",
          classification: "environment_failed",
        },
        error,
      );
    }
    throw new ExecutorFailure(
      {
        code: "SPARK_X_AGENT_CHAT_NETWORK_ERROR",
        message: "星火 Agent 对话目标无法访问。",
        classification: "environment_failed",
      },
      error,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function executeSparkXAgentAction(
  action: string,
  environment: HttpExecutionEnvironment,
  params: Readonly<Record<string, unknown>>,
  variables: Readonly<Record<string, unknown>>,
  options: SparkXAgentExecutionOptions,
): Promise<Readonly<Record<string, unknown>>> {
  if (!sparkXAgentActions.includes(action as SparkXAgentAction)) {
    throw new ExecutorFailure({
      code: "SPARK_X_AGENT_ACTION_NOT_AVAILABLE",
      message: `星火 Agent 适配器动作 ${action} 未注册。`,
      classification: "test_failed",
    });
  }
  const startedAt = performance.now();
  const remainingOptions = (): SparkXAgentExecutionOptions => {
    const timeoutMs = Math.floor(options.timeoutMs - (performance.now() - startedAt));
    if (timeoutMs <= 0) {
      throw new ExecutorFailure({
        code: "SPARK_X_AGENT_ACTION_TIMEOUT",
        message: "星火 Agent 适配器动作超过步骤超时预算。",
        classification: "environment_failed",
      });
    }
    return {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    };
  };
  const username = requiredString(params, "username", variables, 200);
  const password = requiredString(params, "password", variables, 4_096);
  const token = await login(environment, username, password, remainingOptions());

  if (action === "adapter:spark-x-agent/automation.create") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const name = requiredString(params, "name", variables, 160);
    const goal = requiredString(params, "goal", variables, 65_536);
    if (
      name.trim() !== name ||
      goal.includes("\u0000") ||
      goal.includes("\r") ||
      new TextEncoder().encode(goal).byteLength > 65_536
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "自动任务名称或目标违反受控文本边界。",
      );
    }
    const firstFireAt = new Date().toISOString();
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/v5/automations"),
        headers: { "Content-Type": "application/json" },
        body: {
          conversation_id: conversationId,
          name,
          goal,
          selected_skill_id: null,
          interval_seconds: 300,
          first_fire_at: firstFireAt,
        },
      },
      remainingOptions(),
    );
    acceptedAutomationRuntime(response, "SPARK_X_AGENT_AUTOMATION_CREATE_FAILED");
    const receipt = objectValue(response.body);
    if (
      receipt === null ||
      typeof receipt.definition_id !== "string" ||
      !uuidPattern.test(receipt.definition_id) ||
      !Number.isInteger(receipt.state_version) ||
      Number(receipt.state_version) < 1 ||
      receipt.status !== "enabled" ||
      !validTimestamp(receipt.next_fire_at) ||
      Math.abs(Date.parse(receipt.next_fire_at) - Date.parse(firstFireAt)) > 1_000
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_CREATE_RESPONSE_INVALID",
        "星火 Agent 自动任务创建响应与立即触发请求不一致。",
      );
    }
    return {
      automationId: receipt.definition_id,
      conversationId,
      created: true,
      enabled: true,
      stateVersion: Number(receipt.state_version),
      intervalSeconds: 300,
      selectedSkillAbsent: true,
      nextFireAt: receipt.next_fire_at,
      nameSha256: sha256(name),
      goalSha256: sha256(goal),
    };
  }

  if (action === "adapter:spark-x-agent/automation.wait-fired") {
    const automationId = requiredUuid(params, "automationId", variables);
    const conversationId = requiredUuid(params, "conversationId", variables);
    const expectedName = requiredString(params, "expectedName", variables, 160);
    const expectedGoal = requiredString(params, "expectedGoal", variables, 65_536);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      const listResponse = await authenticatedRequest(
        environment,
        token,
        { method: "GET", path: actionPath("/v5/automations?limit=100") },
        remainingOptions(),
      );
      const definition = listedAutomation(
        listResponse,
        automationId,
        "SPARK_X_AGENT_AUTOMATION_LIST_FAILED",
      );
      if (definition === null) {
        throw apiFailure(
          "SPARK_X_AGENT_AUTOMATION_MISSING",
          "本次运行创建的自动任务未出现在所有者任务列表。",
        );
      }
      if (
        definition.conversationId !== conversationId ||
        definition.name !== expectedName ||
        definition.goal !== expectedGoal ||
        definition.intervalSeconds !== 300 ||
        definition.selectedSkillId !== null
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_AUTOMATION_DEFINITION_MISMATCH",
          "自动任务定义、会话绑定、固定周期或无 Skill 约束发生漂移。",
        );
      }
      if (definition.status === "suspended") {
        throw environmentFailure(
          "SPARK_X_AGENT_AUTOMATION_SUSPENDED",
          "自动任务在调度前置检查中被暂停。",
        );
      }
      if (definition.status !== "enabled") {
        throw apiFailure(
          "SPARK_X_AGENT_AUTOMATION_STATUS_INVALID",
          "自动任务在单次执行完成前进入了非启用状态。",
        );
      }
      if (definition.lastFireAt !== null) {
        const scheduleAdvancedBySeconds =
          (Date.parse(definition.nextFireAt) - Date.parse(definition.lastFireAt)) / 1_000;
        if (scheduleAdvancedBySeconds !== 300 || definition.stateVersion < 2) {
          throw apiFailure(
            "SPARK_X_AGENT_AUTOMATION_SCHEDULE_INVALID",
            "自动任务触发后没有按固定周期推进唯一下一次计划。",
          );
        }
        const historyResponse = await authenticatedRequest(
          environment,
          token,
          {
            method: "GET",
            path: actionPath(
              `/conversations/${encodeURIComponent(conversationId)}/messages?page=1&per_page=100`,
            ),
          },
          remainingOptions(),
        );
        acceptedAutomationRuntime(historyResponse, "SPARK_X_AGENT_AUTOMATION_HISTORY_FAILED");
        const history = automationHistoryEvidence(
          historyResponse.body,
          expectedGoal,
          expectedAssistantText,
        );
        if (history !== null) {
          return {
            automationId,
            conversationId,
            fired: true,
            singleFireObserved: true,
            enabled: true,
            stateVersion: definition.stateVersion,
            lastFireAt: definition.lastFireAt,
            nextFireAt: definition.nextFireAt,
            scheduleAdvancedBySeconds,
            ...history,
            selectedSkillAbsent: true,
            expectedAssistantTextMatched: true,
            assistantFinishReason: "stop",
            pollAttempts: attempt,
          };
        }
      }
      await boundedDelay(1_000, remainingOptions().signal);
    }
    throw environmentFailure(
      "SPARK_X_AGENT_AUTOMATION_EXECUTION_TIMEOUT",
      "自动任务调度或模型回复未在有界时间内完成。",
    );
  }

  if (action === "adapter:spark-x-agent/automation.cleanup") {
    const automationId = requiredUuid(params, "automationId", variables);
    let conflictCount = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listResponse = await authenticatedRequest(
        environment,
        token,
        { method: "GET", path: actionPath("/v5/automations?limit=100") },
        remainingOptions(),
      );
      const definition = listedAutomation(
        listResponse,
        automationId,
        "SPARK_X_AGENT_AUTOMATION_CLEANUP_LIST_FAILED",
      );
      if (definition === null) {
        return {
          automationId,
          cleaned: true,
          deleted: false,
          conflictCount,
          alreadyMissing: true,
        };
      }
      const response = await authenticatedRequest(
        environment,
        token,
        {
          method: "DELETE",
          path: actionPath(`/v5/automations/${encodeURIComponent(automationId)}`),
          headers: { "Content-Type": "application/json" },
          body: { expected_version: definition.stateVersion },
        },
        remainingOptions(),
      );
      if (response.status === 404) {
        return {
          automationId,
          cleaned: true,
          deleted: false,
          conflictCount,
          alreadyMissing: true,
        };
      }
      if (response.status === 409) {
        conflictCount += 1;
        if (attempt < 2) {
          await boundedDelay(50, remainingOptions().signal);
          continue;
        }
        break;
      }
      acceptedAutomationRuntime(response, "SPARK_X_AGENT_AUTOMATION_CLEANUP_FAILED");
      const receipt = objectValue(response.body);
      if (
        receipt === null ||
        receipt.definition_id !== automationId ||
        receipt.status !== "disabled" ||
        receipt.next_fire_at !== null ||
        receipt.state_version !== definition.stateVersion + 1
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_AUTOMATION_CLEANUP_RESPONSE_INVALID",
          "自动任务删除回执与最新状态版本不一致。",
        );
      }
      return {
        automationId,
        cleaned: true,
        deleted: true,
        conflictCount,
        deletedStateVersion: receipt.state_version,
      };
    }
    throw environmentFailure(
      "SPARK_X_AGENT_AUTOMATION_CLEANUP_CONFLICT",
      "自动任务状态持续并发变化，无法在有界版本协调内完成清理。",
    );
  }

  if (action === "adapter:spark-x-agent/skill.assert-trusted-publication") {
    const expectedPublicationSha256 = requiredSha256(
      params,
      "expectedPublicationSha256",
      variables,
    );
    const availableResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath("/skills") },
      remainingOptions(),
    );
    acceptedSkillRuntime(availableResponse, "SPARK_X_AGENT_SKILL_LIST_FAILED");
    const availableData = successfulData(
      availableResponse.body,
      "SPARK_X_AGENT_SKILL_LIST_RESPONSE_INVALID",
    );
    if (!Array.isArray(availableData)) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIST_RESPONSE_INVALID",
        "星火 Agent 用户 Skill 清单不是结构化数组。",
      );
    }
    const availableMatches = availableData
      .map(objectValue)
      .filter(
        (item): item is Readonly<Record<string, unknown>> =>
          item !== null && item.name === trustedSkillName,
      );
    if (availableMatches.length === 0) {
      throw environmentFailure(
        "SPARK_X_AGENT_TRUSTED_SKILL_UNAVAILABLE",
        "受信任 Skill 未向当前测试用户开放，无法执行发布清单回归。",
      );
    }
    if (availableMatches.length !== 1) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_PROJECTION_INVALID",
        "星火 Agent 用户 Skill 清单包含重复的受信任发布投影。",
      );
    }

    const detailResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/skills/${encodeURIComponent(trustedSkillName)}`) },
      remainingOptions(),
    );
    acceptedSkillRuntime(detailResponse, "SPARK_X_AGENT_SKILL_DETAIL_FAILED");
    const detail = objectValue(
      successfulData(detailResponse.body, "SPARK_X_AGENT_SKILL_DETAIL_RESPONSE_INVALID"),
    );
    if (detail === null) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_DETAIL_RESPONSE_INVALID",
        "星火 Agent 用户 Skill 详情不是结构化对象。",
      );
    }

    const adminResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath("/admin/skills?page=1&per_page=100") },
      remainingOptions(),
    );
    acceptedSkillRuntime(adminResponse, "SPARK_X_AGENT_SKILL_ADMIN_LIST_FAILED");
    const adminData = dataEnvelope(
      adminResponse.body,
      "SPARK_X_AGENT_SKILL_ADMIN_LIST_RESPONSE_INVALID",
    );
    const adminItems = Array.isArray(adminData.items)
      ? adminData.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : null;
    if (adminItems === null) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_ADMIN_LIST_RESPONSE_INVALID",
        "星火 Agent 管理员 Skill 清单缺少结构化项目数组。",
      );
    }
    const adminMatches = adminItems.filter((item) => item.name === trustedSkillName);
    if (adminMatches.length !== 1) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_PROJECTION_INVALID",
        "星火 Agent 管理员 Skill 清单未形成唯一的受信任发布投影。",
      );
    }

    const available = availableMatches[0];
    const admin = adminMatches[0];
    if (available === undefined || admin === undefined) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_PROJECTION_INVALID",
        "星火 Agent 受信任 Skill 发布投影不完整。",
      );
    }
    const projections = [available, detail, admin];
    const skillId = available.id;
    if (
      typeof skillId !== "string" ||
      !uuidPattern.test(skillId) ||
      projections.some(
        (item) =>
          item.id !== skillId ||
          item.name !== trustedSkillName ||
          item.display_name !== trustedSkillDisplayName ||
          item.category !== trustedSkillCategory ||
          item.is_enabled !== true ||
          item.is_builtin !== false,
      )
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_PROJECTION_MISMATCH",
        "受信任 Skill 的用户与管理员身份、状态或分类投影不一致。",
      );
    }

    const availableConfig = objectValue(available.config);
    const detailConfig = objectValue(detail.config);
    const adminConfig = objectValue(admin.config);
    const availableAssets = objectValue(available.assets);
    const detailAssets = objectValue(detail.assets);
    const adminAssets = objectValue(admin.assets);
    if (
      availableConfig === null ||
      detailConfig === null ||
      adminConfig === null ||
      availableAssets === null ||
      detailAssets === null ||
      adminAssets === null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_PROJECTION_INVALID",
        "受信任 Skill 的能力配置或资产摘要不完整。",
      );
    }
    const prompt = adminConfig.prompt_template;
    const promptSizeBytes =
      typeof prompt === "string" ? new TextEncoder().encode(prompt).byteLength : 0;
    const configs = [availableConfig, detailConfig, adminConfig];
    const assets = [availableAssets, detailAssets, adminAssets];
    if (
      typeof prompt !== "string" ||
      promptSizeBytes < 1 ||
      promptSizeBytes > 65_536 ||
      prompt.includes("\u0000") ||
      availableConfig.durable_agent_task_v17 !== true ||
      detailConfig.durable_agent_task_v17 !== true ||
      configs.some(
        (config) =>
          config.prompt_template !== prompt ||
          config.source !== "upload" ||
          config.main_file !== trustedSkillMainFile ||
          config.type !== trustedSkillBusinessType,
      ) ||
      assets.some(
        (summary) =>
          typeof summary.root_exists !== "boolean" ||
          typeof summary.has_skill_md !== "boolean" ||
          !Number.isInteger(summary.asset_count) ||
          Number(summary.asset_count) < 0 ||
          (summary.has_skill_md === true && summary.main_file !== trustedSkillMainFile) ||
          (summary.has_skill_md === false && summary.main_file !== null) ||
          (summary.root_exists === false &&
            (summary.has_skill_md !== false || Number(summary.asset_count) !== 0)),
      ) ||
      canonicalJson(availableAssets) !== canonicalJson(detailAssets) ||
      canonicalJson(availableAssets) !== canonicalJson(adminAssets)
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_PROJECTION_MISMATCH",
        "受信任 Skill 的有效能力、发布来源或主资产投影与基线不一致。",
      );
    }
    const promptSha256 = sha256(prompt);
    if (promptSha256 !== expectedPublicationSha256) {
      throw assertionFailure(
        "SPARK_X_AGENT_SKILL_PUBLICATION_HASH_MISMATCH",
        "受信任 Skill 的精确发布内容哈希与测试基线不一致。",
      );
    }
    return {
      skillId,
      skillName: trustedSkillName,
      available: true,
      enabled: true,
      builtin: false,
      durableAgentTask: true,
      userAdminProjectionMatched: true,
      publicationHashMatched: true,
      promptSha256,
      promptSizeBytes,
      assetRootPresent: availableAssets.root_exists,
      mainAssetPresent: availableAssets.has_skill_md,
      mainFileSha256: promptSha256,
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.create") {
    const name = requiredString(params, "name", variables, 256);
    const description = requiredString(params, "description", variables, 4_000);
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId) || !name.includes(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_TRACEABILITY_REQUIRED",
        "知识库测试资源名称必须包含当前 run_id。",
      );
    }
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: domainActionPath("/knowledge-bases"),
        headers: { "Content-Type": "application/json" },
        body: {
          name,
          description,
          metadata: { fixture: "spark-x-test-platform", run_id: runId },
        },
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(response, "SPARK_X_AGENT_KNOWLEDGE_BASE_CREATE_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_KNOWLEDGE_BASE_RESPONSE_INVALID");
    const createdId =
      typeof data.id === "string" && uuidPattern.test(data.id) ? data.id : undefined;
    if (
      createdId === undefined ||
      data.name !== name ||
      data.status !== "active" ||
      data.visibility !== "private"
    ) {
      const firstFailure = apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_BASE_RESPONSE_INVALID",
        "星火 Agent 创建知识库响应缺少可追踪的私有活动资源。",
      );
      if (createdId !== undefined && data.name === name) {
        try {
          await authenticatedRequest(
            environment,
            token,
            {
              method: "DELETE",
              path: domainActionPath(`/knowledge-bases/${encodeURIComponent(createdId)}`),
            },
            remainingOptions(),
          );
        } catch {
          // Preserve the first product failure; the malformed response cannot be safely registered.
        }
      }
      throw firstFailure;
    }
    return {
      knowledgeBaseId: createdId,
      created: true,
      active: true,
      nameSha256: sha256(name),
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.upload-fixture") {
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    const fixture = buildKnowledgeFixture(knowledgeBaseId);
    let upload: UploadedFixtureProjection;
    try {
      const response = await uploadKnowledgeFixture(
        environment,
        token,
        knowledgeBaseId,
        fixture,
        remainingOptions(),
      );
      if (response.status === 200) {
        upload = uploadedFixtureProjection(response.body, fixture);
      } else if (response.status === 202) {
        const recovered = await recoverUploadedFixture(
          environment,
          token,
          knowledgeBaseId,
          fixture,
          false,
          remainingOptions,
        );
        if (recovered === null) {
          throw environmentFailure(
            "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_OUTCOME_UNKNOWN",
            "知识库固定夹具上传结果无法确认。",
          );
        }
        upload = recovered;
      } else {
        if (response.status >= 500) {
          throw environmentFailure(
            "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_RUNTIME_FAILED",
            `知识库固定夹具上传运行时返回 HTTP ${response.status}。`,
          );
        }
        throw apiFailure(
          "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_FAILED",
          `知识库固定夹具上传返回 HTTP ${response.status}。`,
          response.status,
        );
      }
    } catch (firstError) {
      if (
        !(firstError instanceof ExecutorFailure) ||
        ![
          "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_NETWORK_ERROR",
          "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_TIMEOUT",
          "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_OUTCOME_UNKNOWN",
          "SPARK_X_AGENT_KNOWLEDGE_UPLOAD_RUNTIME_FAILED",
        ].includes(firstError.failure.code)
      ) {
        throw firstError;
      }
      try {
        const recovered = await recoverUploadedFixture(
          environment,
          token,
          knowledgeBaseId,
          fixture,
          false,
          remainingOptions,
        );
        if (recovered === null) throw firstError;
        upload = recovered;
      } catch {
        throw firstError;
      }
    }
    return {
      knowledgeBaseId,
      uploadedDocumentId: upload.id,
      uploaded: true,
      fixtureSizeBytes: fixture.bytes.byteLength,
      fixtureSha256: fixture.sha256,
      fileNameSha256: sha256(fixture.fileName),
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.attach-upload") {
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    const uploadedDocumentId = requiredUuid(params, "uploadedDocumentId", variables);
    const title = requiredString(params, "title", variables, 512);
    const sourceResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/documents/${encodeURIComponent(uploadedDocumentId)}/parser-source`),
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(sourceResponse, "SPARK_X_AGENT_KNOWLEDGE_SOURCE_FAILED");
    const source = dataEnvelope(
      sourceResponse.body,
      "SPARK_X_AGENT_KNOWLEDGE_SOURCE_RESPONSE_INVALID",
    );
    if (source.document_id !== uploadedDocumentId || typeof source.url !== "string") {
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SOURCE_RESPONSE_INVALID",
        "固定夹具解析源与已上传文档标识不一致。",
      );
    }
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(source.url);
    } catch (error) {
      throw new ExecutorFailure(
        {
          code: "SPARK_X_AGENT_KNOWLEDGE_SOURCE_RESPONSE_INVALID",
          message: "固定夹具解析源地址格式无效。",
          classification: "product_failed",
        },
        error,
      );
    }
    if (
      !["http:", "https:"].includes(sourceUrl.protocol) ||
      sourceUrl.username !== "" ||
      sourceUrl.password !== "" ||
      source.url.length > 10_000
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SOURCE_RESPONSE_INVALID",
        "固定夹具解析源地址违反安全边界。",
      );
    }
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: domainActionPath(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents`),
        headers: { "Content-Type": "application/json" },
        body: {
          rust_document_id: uploadedDocumentId,
          source_url: source.url,
          title,
          metadata: { fixture: "spark-x-test-platform" },
        },
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(response, "SPARK_X_AGENT_KNOWLEDGE_ATTACH_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID");
    const status = data.status;
    if (
      typeof data.id !== "string" ||
      !uuidPattern.test(data.id) ||
      data.knowledge_base_id !== knowledgeBaseId ||
      data.rust_document_id !== uploadedDocumentId ||
      data.title !== title ||
      typeof status !== "string" ||
      !["pending", "processing", "completed", "failed"].includes(status)
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID",
        "知识文档绑定响应与本次固定夹具不一致。",
      );
    }
    if (status === "failed") {
      throw environmentFailure(
        "SPARK_X_AGENT_KNOWLEDGE_PARSE_CREATE_FAILED",
        "固定夹具解析任务创建失败。",
      );
    }
    return {
      knowledgeBaseId,
      knowledgeDocumentId: data.id,
      uploadedDocumentId,
      attached: true,
      parseJobPresent: typeof data.parse_job_id === "string",
      documentStatus: status,
      titleSha256: sha256(title),
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.wait-ready") {
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    const knowledgeDocumentId = requiredUuid(params, "knowledgeDocumentId", variables);
    const expectedFixtureSha256 = requiredSha256(params, "expectedFixtureSha256", variables);
    const expectedTitle = requiredString(params, "expectedTitle", variables, 512);
    let document: Readonly<Record<string, unknown>> | undefined;
    let pollAttempts = 0;
    for (let attempt = 1; attempt <= 120; attempt += 1) {
      pollAttempts = attempt;
      const response = await authenticatedRequest(
        environment,
        token,
        {
          method: "POST",
          path: domainActionPath(
            `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(knowledgeDocumentId)}/refresh`,
          ),
        },
        remainingOptions(),
      );
      acceptedKnowledgeRuntime(response, "SPARK_X_AGENT_KNOWLEDGE_REFRESH_FAILED");
      document = dataEnvelope(response.body, "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID");
      if (document.id !== knowledgeDocumentId || document.knowledge_base_id !== knowledgeBaseId) {
        throw apiFailure(
          "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID",
          "知识文档刷新响应与本次测试资源不一致。",
        );
      }
      if (document.status === "failed") {
        throw environmentFailure("SPARK_X_AGENT_KNOWLEDGE_PARSE_FAILED", "固定夹具解析任务失败。");
      }
      if (document.status === "completed" && typeof document.current_version_id === "string") {
        break;
      }
      if (!["pending", "processing"].includes(String(document.status))) {
        throw apiFailure(
          "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID",
          "知识文档返回了未知解析状态。",
        );
      }
      document = undefined;
      await boundedDelay(1_000, remainingOptions().signal);
    }
    if (document === undefined) {
      throw environmentFailure(
        "SPARK_X_AGENT_KNOWLEDGE_PARSE_TIMEOUT",
        "固定夹具解析未在有界时间内完成。",
      );
    }
    const baseResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: domainActionPath(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`),
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(baseResponse, "SPARK_X_AGENT_KNOWLEDGE_BASE_ASSERT_FAILED");
    const base = dataEnvelope(baseResponse.body, "SPARK_X_AGENT_KNOWLEDGE_BASE_RESPONSE_INVALID");
    const versionsResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: domainActionPath(
          `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(knowledgeDocumentId)}/versions`,
        ),
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(versionsResponse, "SPARK_X_AGENT_KNOWLEDGE_VERSION_ASSERT_FAILED");
    const versionsData = dataEnvelope(
      versionsResponse.body,
      "SPARK_X_AGENT_KNOWLEDGE_VERSION_RESPONSE_INVALID",
    );
    const versions = Array.isArray(versionsData.items)
      ? versionsData.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const version = versions[0];
    if (
      base.id !== knowledgeBaseId ||
      base.status !== "active" ||
      base.document_count !== 1 ||
      base.ready_document_count !== 1 ||
      document.title !== expectedTitle ||
      document.status !== "completed" ||
      document.current_version_number !== 1 ||
      versions.length !== 1 ||
      version?.knowledge_document_id !== knowledgeDocumentId ||
      version.version_number !== 1 ||
      version.status !== "completed" ||
      version.content_hash !== expectedFixtureSha256 ||
      typeof version.parser_version_id !== "string" ||
      version.parser_version_id.length === 0
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_READY_ASSERTION_FAILED",
        "知识库计数、当前版本、解析状态或固定夹具哈希不一致。",
      );
    }
    return {
      knowledgeBaseId,
      knowledgeDocumentId,
      ready: true,
      documentStatus: "completed",
      documentCount: 1,
      readyDocumentCount: 1,
      currentVersionNumber: 1,
      versionCount: 1,
      parserVersionPresent: true,
      contentHashMatched: true,
      titleMatched: true,
      fixtureSha256: expectedFixtureSha256,
      pollAttempts,
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.assert-conversation-scope") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    const knowledgeDocumentId = requiredUuid(params, "knowledgeDocumentId", variables);
    const expectedFixtureSha256 = requiredSha256(params, "expectedFixtureSha256", variables);
    const clientRequestId = requiredUuid(params, "clientRequestId", variables);
    const scopePath = domainActionPath(
      `/conversations/${encodeURIComponent(conversationId)}/knowledge-scope`,
    );
    const snapshotPath = domainActionPath(
      `/conversations/${encodeURIComponent(conversationId)}/document-context-snapshots`,
    );

    const initialResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: scopePath },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(initialResponse, "SPARK_X_AGENT_KNOWLEDGE_SCOPE_INITIAL_READ_FAILED");
    const initial = knowledgeScopeProjection(
      initialResponse.body,
      conversationId,
      "SPARK_X_AGENT_KNOWLEDGE_SCOPE_INITIAL_RESPONSE_INVALID",
    );
    if (
      initial.retrievalPolicy !== "auto" ||
      initial.status !== "active" ||
      initial.revision !== 0 ||
      initial.scopeHash !== null ||
      initial.knowledgeBaseIds.length !== 0 ||
      initial.knowledgeBases.length !== 0
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SCOPE_INITIAL_ASSERTION_FAILED",
        "新建会话的初始知识范围不是空范围或修订号不是 0。",
      );
    }

    const updateResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "PUT",
        path: scopePath,
        headers: { "Content-Type": "application/json" },
        body: {
          knowledge_base_ids: [knowledgeBaseId],
          retrieval_policy: "required",
          expected_revision: 0,
        },
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(updateResponse, "SPARK_X_AGENT_KNOWLEDGE_SCOPE_UPDATE_FAILED");
    const saved = knowledgeScopeProjection(
      updateResponse.body,
      conversationId,
      "SPARK_X_AGENT_KNOWLEDGE_SCOPE_UPDATE_RESPONSE_INVALID",
    );
    const savedBase = saved.knowledgeBases[0];
    if (
      saved.retrievalPolicy !== "required" ||
      saved.status !== "active" ||
      saved.revision !== 1 ||
      saved.scopeHash === null ||
      saved.knowledgeBaseIds.length !== 1 ||
      saved.knowledgeBaseIds[0] !== knowledgeBaseId ||
      saved.knowledgeBases.length !== 1 ||
      savedBase?.id !== knowledgeBaseId ||
      savedBase.status !== "active" ||
      savedBase.document_count !== 1 ||
      savedBase.ready_document_count !== 1
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SCOPE_UPDATE_ASSERTION_FAILED",
        "会话知识范围、修订号或可检索文档计数与本次测试资源不一致。",
      );
    }

    const snapshotBody = {
      client_request_id: clientRequestId,
      expected_scope_revision: saved.revision,
      expected_scope_hash: saved.scopeHash,
    };
    const snapshotHeaders = {
      "Content-Type": "application/json",
      "Idempotency-Key": clientRequestId,
    };
    const firstResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: snapshotPath,
        headers: snapshotHeaders,
        body: snapshotBody,
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(firstResponse, "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_CREATE_FAILED");
    if (firstResponse.status !== 201) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_CREATE_STATUS_FAILED",
        "首次创建知识范围快照没有返回 HTTP 201。",
      );
    }
    const first = knowledgeSnapshotProjection(
      firstResponse.body,
      { conversationId, clientRequestId },
      "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_CREATE_RESPONSE_INVALID",
    );
    if (
      first.scopeRevision !== saved.revision ||
      first.scopeHash !== saved.scopeHash ||
      first.status !== "prepared" ||
      first.knowledgeBaseCount !== 1 ||
      first.readyDocumentCount !== 1 ||
      first.excludedDocumentCount !== 0 ||
      first.knowledgeBaseId !== knowledgeBaseId ||
      first.knowledgeDocumentId !== knowledgeDocumentId ||
      first.versionNumber !== 1 ||
      first.contentHash !== expectedFixtureSha256 ||
      first.idempotentReplay
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_CREATE_ASSERTION_FAILED",
        "首次知识范围快照没有固定本次文档版本或返回了错误计数。",
      );
    }

    const replayResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: snapshotPath,
        headers: snapshotHeaders,
        body: snapshotBody,
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(replayResponse, "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_REPLAY_FAILED");
    if (replayResponse.status !== 200) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_REPLAY_STATUS_FAILED",
        "知识范围快照幂等重放没有返回 HTTP 200。",
      );
    }
    const replay = knowledgeSnapshotProjection(
      replayResponse.body,
      { conversationId, clientRequestId },
      "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_REPLAY_RESPONSE_INVALID",
    );
    const snapshotIdentityMatched =
      replay.id === first.id &&
      replay.scopeId === first.scopeId &&
      replay.scopeRevision === first.scopeRevision &&
      replay.scopeHash === first.scopeHash &&
      replay.snapshotHash === first.snapshotHash &&
      replay.status === first.status &&
      replay.knowledgeBaseCount === first.knowledgeBaseCount &&
      replay.readyDocumentCount === first.readyDocumentCount &&
      replay.excludedDocumentCount === first.excludedDocumentCount &&
      replay.knowledgeBaseId === first.knowledgeBaseId &&
      replay.knowledgeDocumentId === first.knowledgeDocumentId &&
      replay.knowledgeVersionId === first.knowledgeVersionId &&
      replay.rustDocumentId === first.rustDocumentId &&
      replay.parserDocumentId === first.parserDocumentId &&
      replay.parserVersionId === first.parserVersionId &&
      replay.versionNumber === first.versionNumber &&
      replay.contentHash === first.contentHash;
    if (!replay.idempotentReplay || !snapshotIdentityMatched) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_REPLAY_ASSERTION_FAILED",
        "知识范围快照幂等重放生成了不同快照或不同固定文档版本。",
      );
    }

    const finalResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: scopePath },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(finalResponse, "SPARK_X_AGENT_KNOWLEDGE_SCOPE_FINAL_READ_FAILED");
    const finalScope = knowledgeScopeProjection(
      finalResponse.body,
      conversationId,
      "SPARK_X_AGENT_KNOWLEDGE_SCOPE_FINAL_RESPONSE_INVALID",
    );
    const finalBase = finalScope.knowledgeBases[0];
    const scopeStable =
      finalScope.retrievalPolicy === saved.retrievalPolicy &&
      finalScope.status === saved.status &&
      finalScope.revision === saved.revision &&
      finalScope.scopeHash === saved.scopeHash &&
      finalScope.knowledgeBaseIds.length === 1 &&
      finalScope.knowledgeBaseIds[0] === knowledgeBaseId &&
      finalScope.knowledgeBases.length === 1 &&
      finalBase?.id === knowledgeBaseId &&
      finalBase.status === "active" &&
      finalBase.document_count === 1 &&
      finalBase.ready_document_count === 1;
    if (!scopeStable) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_SCOPE_FINAL_ASSERTION_FAILED",
        "创建和重放快照后，会话知识范围发生了非预期变化。",
      );
    }

    return {
      conversationId,
      knowledgeBaseId,
      knowledgeDocumentId,
      retrievalPolicy: "required",
      scopeRevision: saved.revision,
      scopeHash: saved.scopeHash,
      scopeKnowledgeBaseCount: saved.knowledgeBaseIds.length,
      scopeDocumentCount: savedBase.document_count,
      scopeReadyDocumentCount: savedBase.ready_document_count,
      snapshotId: first.id,
      snapshotStatus: first.status,
      snapshotHash: first.snapshotHash,
      snapshotKnowledgeBaseCount: first.knowledgeBaseCount,
      snapshotReadyDocumentCount: first.readyDocumentCount,
      snapshotExcludedDocumentCount: first.excludedDocumentCount,
      snapshotDocumentCount: 1,
      scopeMatched: true,
      documentMatched: true,
      contentHashMatched: true,
      firstCreated: true,
      idempotentReplay: replay.idempotentReplay,
      snapshotIdentityMatched,
      scopeStable,
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.cleanup") {
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    let knowledgeDocumentDeleteCount = 0;
    let knowledgeBaseArchived = false;
    let alreadyMissing = false;
    const documentsResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: domainActionPath(
          `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents?include_archived=true`,
        ),
      },
      remainingOptions(),
    );
    if (documentsResponse.status === 404) {
      alreadyMissing = true;
    } else {
      acceptedKnowledgeRuntime(documentsResponse, "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_LIST_FAILED");
      const documentsData = dataEnvelope(
        documentsResponse.body,
        "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID",
      );
      const documents = Array.isArray(documentsData.items)
        ? documentsData.items
            .map(objectValue)
            .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
        : [];
      if (documents.length > 10) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_SCOPE_INVALID",
          "本次运行创建的知识库包含超出安全上限的文档，拒绝扩大清理范围。",
        );
      }
      for (const item of documents) {
        if (typeof item.id !== "string" || !uuidPattern.test(item.id)) {
          throw apiFailure(
            "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID",
            "知识库清理列表包含无效文档标识。",
          );
        }
        let status = item.status;
        for (let attempt = 0; ["pending", "processing"].includes(String(status)); attempt += 1) {
          if (attempt >= 120) {
            throw environmentFailure(
              "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_PENDING",
              "知识文档未在清理时间窗内进入可删除状态。",
            );
          }
          const refresh = await authenticatedRequest(
            environment,
            token,
            {
              method: "POST",
              path: domainActionPath(
                `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(item.id)}/refresh`,
              ),
            },
            remainingOptions(),
          );
          acceptedKnowledgeRuntime(refresh, "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_REFRESH_FAILED");
          status = dataEnvelope(refresh.body, "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_INVALID").status;
          if (["pending", "processing"].includes(String(status))) {
            await boundedDelay(1_000, remainingOptions().signal);
          }
        }
        const deleted = await authenticatedRequest(
          environment,
          token,
          {
            method: "DELETE",
            path: domainActionPath(
              `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(item.id)}`,
            ),
          },
          remainingOptions(),
        );
        if (deleted.status !== 404) {
          acceptedKnowledgeRuntime(deleted, "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_DELETE_FAILED");
        }
        knowledgeDocumentDeleteCount += 1;
      }
    }
    const upload = await recoverUploadedFixture(
      environment,
      token,
      knowledgeBaseId,
      undefined,
      true,
      remainingOptions,
    );
    let rawDocumentDeleted = upload === null;
    if (upload !== null) {
      const deleted = await authenticatedRequest(
        environment,
        token,
        {
          method: "DELETE",
          path: actionPath(`/documents/${encodeURIComponent(upload.id)}`),
        },
        remainingOptions(),
      );
      if (deleted.status !== 404) {
        acceptedKnowledgeRuntime(deleted, "SPARK_X_AGENT_KNOWLEDGE_RAW_DOCUMENT_DELETE_FAILED");
      }
      rawDocumentDeleted = true;
    }
    if (!alreadyMissing) {
      const archived = await authenticatedRequest(
        environment,
        token,
        {
          method: "DELETE",
          path: domainActionPath(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`),
        },
        remainingOptions(),
      );
      if (archived.status >= 200 && archived.status < 300) {
        knowledgeBaseArchived = true;
      } else if ([404, 409].includes(archived.status)) {
        const verify = await authenticatedRequest(
          environment,
          token,
          {
            method: "GET",
            path: domainActionPath(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`),
          },
          remainingOptions(),
        );
        if (verify.status === 404) {
          knowledgeBaseArchived = true;
          alreadyMissing = true;
        } else if (verify.status >= 200 && verify.status < 300) {
          const verified = dataEnvelope(
            verify.body,
            "SPARK_X_AGENT_KNOWLEDGE_BASE_RESPONSE_INVALID",
          );
          if (
            verified.id === knowledgeBaseId &&
            ["archived", "deleted"].includes(String(verified.status))
          ) {
            knowledgeBaseArchived = true;
            alreadyMissing = true;
          } else {
            acceptedKnowledgeRuntime(archived, "SPARK_X_AGENT_KNOWLEDGE_BASE_ARCHIVE_FAILED");
          }
        } else {
          acceptedKnowledgeRuntime(verify, "SPARK_X_AGENT_KNOWLEDGE_BASE_ARCHIVE_FAILED");
        }
      } else {
        acceptedKnowledgeRuntime(archived, "SPARK_X_AGENT_KNOWLEDGE_BASE_ARCHIVE_FAILED");
      }
    } else {
      knowledgeBaseArchived = true;
    }
    return {
      knowledgeBaseId,
      cleaned: true,
      knowledgeDocumentDeleteCount,
      rawDocumentDeleted,
      knowledgeBaseArchived,
      ...(alreadyMissing ? { alreadyMissing: true } : {}),
    };
  }

  if (action === "adapter:spark-x-agent/tool.assert-safe-catalog") {
    const visibleResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath("/mcp/servers") },
      remainingOptions(),
    );
    accepted(visibleResponse, "SPARK_X_AGENT_TOOL_CATALOG_FAILED");
    const visibleData = dataEnvelope(
      visibleResponse.body,
      "SPARK_X_AGENT_TOOL_CATALOG_RESPONSE_INVALID",
    );
    const visibleItems = Array.isArray(visibleData.items)
      ? visibleData.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const visibleServer = visibleItems.find((item) => item.name === safeToolServerName);
    if (
      visibleServer === undefined ||
      typeof visibleServer.id !== "string" ||
      !uuidPattern.test(visibleServer.id) ||
      visibleServer.is_enabled !== true ||
      visibleServer.status !== "running" ||
      visibleServer.tools_count !== safeToolCatalog.length
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_SAFE_TOOL_CATALOG_UNAVAILABLE",
        "builtin-demo 安全工具目录未以运行中状态完整暴露给当前用户。",
      );
    }
    if (privateCatalogFields.some((field) => Object.hasOwn(visibleServer, field))) {
      throw apiFailure(
        "SPARK_X_AGENT_TOOL_CATALOG_LEAKED_PRIVATE_FIELDS",
        "星火 Agent 用户工具目录暴露了管理员连接配置字段。",
      );
    }
    const adminResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/admin/mcp/servers/${encodeURIComponent(visibleServer.id)}/tools`),
      },
      remainingOptions(),
    );
    accepted(adminResponse, "SPARK_X_AGENT_TOOL_CATALOG_FAILED");
    const adminData = dataEnvelope(
      adminResponse.body,
      "SPARK_X_AGENT_TOOL_CATALOG_RESPONSE_INVALID",
    );
    const enabledTools = Array.isArray(adminData.items)
      ? adminData.items
          .map(objectValue)
          .filter(
            (item): item is Readonly<Record<string, unknown>> =>
              item !== null && item.is_enabled === true && item.is_discovered === true,
          )
      : [];
    const names = enabledTools
      .map((item) => item.name)
      .filter((name): name is string => typeof name === "string")
      .sort();
    const expectedNames = [...safeToolCatalog].sort();
    if (
      names.length !== enabledTools.length ||
      canonicalJson(names) !== canonicalJson(expectedNames) ||
      enabledTools.some(
        (item) =>
          item.is_write === true ||
          item.requires_review === true ||
          !["low", "read"].includes(String(item.risk_level)),
      )
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_SAFE_TOOL_CATALOG_MISMATCH",
        "builtin-demo 当前启用工具、风险等级或复核策略与只读基线不一致。",
      );
    }
    return {
      serverName: safeToolServerName,
      visible: true,
      running: true,
      credentialFieldsAbsent: true,
      advertisedToolCount: visibleServer.tools_count,
      enabledDiscoveredToolCount: enabledTools.length,
      expectedToolsMatched: true,
      catalogSha256: sha256(canonicalJson(names)),
    };
  }

  if (action === "adapter:spark-x-agent/tool.invoke-safe") {
    const conversationId = requiredString(params, "conversationId", variables, 100);
    const message = requiredString(params, "message", variables, 20_000);
    const expectedText = requiredString(params, "expectedText", variables, 5_000);
    const expectedToolName = requiredSafeToolName(params, variables);
    const expectedArguments = expectedJsonObject(params, "expectedArgumentsJson", variables);
    const expectedResult = expectedJsonObject(params, "expectedResultJson", variables);
    if (message.includes("\u0000")) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "星火 Agent 工具对话消息不能包含空字符。",
      );
    }
    const result = await streamChat(
      environment,
      token,
      conversationId,
      message,
      remainingOptions(),
    );
    if (!result.finalContent.includes(expectedText)) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_FINAL_RESPONSE_FAILED",
        "星火 Agent 工具调用后的最终回复未包含预期运行标识或结果。",
      );
    }
    if (
      result.toolCalls.length !== 1 ||
      result.toolResults.length !== 1 ||
      result.reviewEventCount !== 0
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_CARDINALITY_FAILED",
        "安全工具回归必须且只能产生一组无需人工复核的工具调用与结果。",
      );
    }
    const call = result.toolCalls[0];
    const toolResult = result.toolResults[0];
    if (
      call === undefined ||
      toolResult === undefined ||
      call.name !== expectedToolName ||
      toolResult.name !== expectedToolName ||
      call.id !== toolResult.id ||
      toolResult.success !== true
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_IDENTITY_FAILED",
        "安全工具调用与结果的名称、调用标识或成功状态不一致。",
      );
    }
    const argumentsCanonical = canonicalJson(call.arguments);
    const resultCanonical = canonicalJson(toolResult.result);
    if (argumentsCanonical !== canonicalJson(expectedArguments)) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_ARGUMENTS_FAILED",
        "模型提交给安全工具的参数与预期绑定不一致。",
      );
    }
    if (resultCanonical !== canonicalJson(expectedResult)) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RESULT_FAILED",
        "安全工具的结构化结果与预期结果不一致。",
      );
    }
    return {
      conversationId: result.conversationId,
      done: true,
      expectedTextMatched: true,
      expectedToolNameMatched: true,
      argumentsMatched: true,
      resultMatched: true,
      toolCallCount: result.toolCalls.length,
      toolResultCount: result.toolResults.length,
      reviewEventCount: result.reviewEventCount,
      toolCallIdSha256: sha256(call.id),
      argumentsSha256: sha256(argumentsCanonical),
      resultSha256: sha256(resultCanonical),
      finalContentLength: result.finalContent.length,
      finalContentSha256: sha256(result.finalContent),
      streamBytes: result.streamBytes,
      truncated: false,
    };
  }

  if (action === "adapter:spark-x-agent/chat.ask") {
    const conversationId = requiredString(params, "conversationId", variables, 100);
    const message = requiredString(params, "message", variables, 20_000);
    const expectedText = requiredString(params, "expectedText", variables, 5_000);
    if (message.includes("\u0000")) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "星火 Agent 对话消息不能包含空字符。",
      );
    }
    const result = await streamChat(
      environment,
      token,
      conversationId,
      message,
      remainingOptions(),
    );
    if (!result.finalContent.includes(expectedText)) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_EXPECTATION_FAILED",
        "星火 Agent 完整回复未包含预期运行标识。",
      );
    }
    const finalContentSha256 = createHash("sha256").update(result.finalContent).digest("hex");
    return {
      conversationId: result.conversationId,
      done: true,
      expectedTextMatched: true,
      contentEventCount: result.contentEventCount,
      statusEventCount: result.statusEventCount,
      assistantPreviewEventCount: result.assistantPreviewEventCount,
      toolEventCount: result.toolEventCount,
      skillEventCount: result.skillEventCount,
      reviewEventCount: result.reviewEventCount,
      streamBytes: result.streamBytes,
      streamedContentLength: result.streamedContent.length,
      finalContentLength: result.finalContent.length,
      finalContentSha256,
      truncated: false,
      ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
      ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    };
  }

  if (action === "adapter:spark-x-agent/conversation.create") {
    const title = requiredString(params, "title", variables, 200);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/conversations"),
        headers: { "Content-Type": "application/json" },
        body: { title },
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CONVERSATION_CREATE_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_CONVERSATION_RESPONSE_INVALID");
    if (typeof data.id !== "string" || typeof data.title !== "string") {
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_RESPONSE_INVALID",
        "星火 Agent 创建会话响应缺少会话标识或标题。",
      );
    }
    return { conversationId: data.id, title: data.title };
  }

  const conversationId = requiredString(params, "conversationId", variables, 100);
  if (action === "adapter:spark-x-agent/tool.assert-history") {
    const expectedUserText = requiredString(params, "expectedUserText", variables, 20_000);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    const expectedAssistantSha256 = requiredSha256(params, "expectedAssistantSha256", variables);
    const expectedToolName = requiredSafeToolName(params, variables);
    const expectedArgumentsSha256 = requiredSha256(params, "expectedArgumentsSha256", variables);
    const expectedResultSha256 = requiredSha256(params, "expectedResultSha256", variables);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(
          `/conversations/${encodeURIComponent(conversationId)}/messages?page=1&per_page=100`,
        ),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_TOOL_HISTORY_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID");
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    if (items.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_TRUNCATED",
        "星火 Agent 工具调用历史包含已截断的公开消息。",
      );
    }
    const userMessages = items.filter((item) => item.role === "user");
    const assistantMessages = items.filter((item) => item.role === "assistant");
    const toolMessages = items.filter((item) => item.role === "tool");
    const calls = assistantMessages.flatMap((item) =>
      Array.isArray(item.tool_calls)
        ? item.tool_calls
            .map(objectValue)
            .filter((call): call is Readonly<Record<string, unknown>> => call !== null)
        : [],
    );
    const finalAssistants = assistantMessages.filter(
      (item) =>
        item.finish_reason === "stop" &&
        typeof item.content === "string" &&
        (!Array.isArray(item.tool_calls) || item.tool_calls.length === 0),
    );
    if (
      userMessages.length !== 1 ||
      assistantMessages.length !== 2 ||
      toolMessages.length !== 1 ||
      calls.length !== 1 ||
      finalAssistants.length !== 1
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_CARDINALITY_FAILED",
        "工具回归历史必须包含一条用户消息、一次工具调用、一条工具结果和一条最终回复。",
      );
    }
    const userContent = userMessages[0]?.content;
    const call = calls[0];
    const toolMessage = toolMessages[0];
    const finalAssistant = finalAssistants[0];
    const functionValue = call === undefined ? null : objectValue(call.function);
    if (
      typeof userContent !== "string" ||
      userContent !== expectedUserText ||
      call === undefined ||
      typeof call.id !== "string" ||
      functionValue === null ||
      functionValue.name !== expectedToolName ||
      toolMessage === undefined ||
      toolMessage.tool_call_id !== call.id ||
      typeof toolMessage.content !== "string" ||
      finalAssistant === undefined ||
      typeof finalAssistant.content !== "string" ||
      !finalAssistant.content.includes(expectedAssistantText)
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_IDENTITY_FAILED",
        "工具回归历史的用户消息、工具身份、结果关联或最终回复不一致。",
      );
    }
    const argumentsObject = structuredObject(
      functionValue.arguments,
      "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
      "星火 Agent 工具调用历史缺少受限结构化参数。",
      "product_failed",
    );
    const resultObject = structuredObject(
      toolMessage.content,
      "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
      "星火 Agent 工具结果历史缺少受限结构化结果。",
      "product_failed",
    );
    const argumentsSha256 = sha256(canonicalJson(argumentsObject));
    const resultSha256 = sha256(canonicalJson(resultObject));
    const assistantContentSha256 = sha256(finalAssistant.content);
    if (
      argumentsSha256 !== expectedArgumentsSha256 ||
      resultSha256 !== expectedResultSha256 ||
      assistantContentSha256 !== expectedAssistantSha256
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_HASH_MISMATCH",
        "工具参数、结果或最终回复的持久化哈希与流式证据不一致。",
      );
    }
    const traceEvents = items.flatMap((item) =>
      Array.isArray(item.public_execution_trace)
        ? item.public_execution_trace
            .map(objectValue)
            .filter((event): event is Readonly<Record<string, unknown>> => event !== null)
        : [],
    );
    const traceCalls = traceEvents.filter((event) => event.kind === "tool_call");
    const traceResults = traceEvents.filter((event) => event.kind === "tool_result");
    if (
      traceCalls.length !== 1 ||
      traceResults.length !== 1 ||
      traceCalls[0]?.id !== call.id ||
      traceCalls[0]?.name !== expectedToolName ||
      traceResults[0]?.id !== call.id ||
      traceResults[0]?.name !== expectedToolName ||
      traceResults[0]?.success !== true ||
      sha256(
        canonicalJson(
          structuredObject(
            traceCalls[0]?.arguments,
            "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
            "星火 Agent 公开执行轨迹缺少结构化工具参数。",
            "product_failed",
          ),
        ),
      ) !== expectedArgumentsSha256 ||
      sha256(
        canonicalJson(
          structuredObject(
            traceResults[0]?.result,
            "SPARK_X_AGENT_TOOL_HISTORY_RESPONSE_INVALID",
            "星火 Agent 公开执行轨迹缺少结构化工具结果。",
            "product_failed",
          ),
        ),
      ) !== expectedResultSha256
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_HISTORY_TRACE_FAILED",
        "工具调用公开执行轨迹与消息历史不一致。",
      );
    }
    return {
      conversationId,
      messageCount: items.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolMessageCount: toolMessages.length,
      toolCallCount: calls.length,
      toolResultCount: toolMessages.length,
      traceToolCallCount: traceCalls.length,
      traceToolResultCount: traceResults.length,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      expectedToolNameMatched: true,
      argumentsSha256,
      resultSha256,
      assistantContentLength: finalAssistant.content.length,
      assistantContentSha256,
      assistantFinishReason: "stop",
    };
  }
  if (action === "adapter:spark-x-agent/chat.assert-context-history") {
    const firstUserText = requiredString(params, "firstUserText", variables, 20_000);
    const firstAssistantSha256 = requiredSha256(params, "firstAssistantSha256", variables);
    const secondUserText = requiredString(params, "secondUserText", variables, 20_000);
    const secondExpectedText = requiredString(params, "secondExpectedText", variables, 5_000);
    const secondAssistantSha256 = requiredSha256(params, "secondAssistantSha256", variables);
    const forbiddenText = requiredString(params, "forbiddenText", variables, 5_000);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(
          `/conversations/${encodeURIComponent(conversationId)}/messages?page=1&per_page=100`,
        ),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CONTEXT_HISTORY_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_CONTEXT_HISTORY_RESPONSE_INVALID");
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    if (items.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_HISTORY_TRUNCATED",
        "星火 Agent 两轮对话历史包含已截断消息。",
      );
    }
    const publicMessages = items.filter(
      (item) => item.role === "user" || item.role === "assistant",
    );
    const userMessages = publicMessages.filter((item) => item.role === "user");
    const assistantMessages = publicMessages.filter((item) => item.role === "assistant");
    const toolMessages = items.filter((item) => item.role === "tool");
    if (
      publicMessages.length !== 4 ||
      userMessages.length !== 2 ||
      assistantMessages.length !== 2 ||
      toolMessages.length !== 0
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_HISTORY_CARDINALITY_FAILED",
        "两轮上下文回归必须且只能持久化两条用户消息和两条助手回复，且不能产生工具消息。",
      );
    }
    const expectedRoles = "user,assistant,user,assistant";
    const roles = publicMessages.map((item) => item.role).join(",");
    const reversedRoles = [...publicMessages]
      .reverse()
      .map((item) => item.role)
      .join(",");
    const chronological =
      roles === expectedRoles
        ? publicMessages
        : reversedRoles === expectedRoles
          ? [...publicMessages].reverse()
          : null;
    if (chronological === null) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_HISTORY_ORDER_FAILED",
        "两轮上下文回归消息没有按用户、助手、用户、助手的顺序持久化。",
      );
    }
    const firstUser = chronological[0];
    const firstAssistant = chronological[1];
    const secondUser = chronological[2];
    const secondAssistant = chronological[3];
    if (
      firstUser?.role !== "user" ||
      firstUser.content !== firstUserText ||
      firstAssistant?.role !== "assistant" ||
      typeof firstAssistant.content !== "string" ||
      secondUser?.role !== "user" ||
      secondUser.content !== secondUserText ||
      secondAssistant?.role !== "assistant" ||
      typeof secondAssistant.content !== "string" ||
      !secondAssistant.content.includes(secondExpectedText)
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_HISTORY_IDENTITY_FAILED",
        "两轮上下文回归的用户消息、助手回复或上下文标识不一致。",
      );
    }
    if (
      publicMessages.some(
        (item) => typeof item.content === "string" && item.content.includes(forbiddenText),
      )
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_CROSS_TALK_FAILED",
        "主会话历史包含独立干扰会话标识。",
      );
    }
    const firstContentSha256 = sha256(firstAssistant.content);
    const secondContentSha256 = sha256(secondAssistant.content);
    if (
      firstContentSha256 !== firstAssistantSha256 ||
      secondContentSha256 !== secondAssistantSha256
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_HISTORY_HASH_MISMATCH",
        "两轮持久化助手回复与各自流式最终回复哈希不一致。",
      );
    }
    if (firstAssistant.finish_reason !== "stop" || secondAssistant.finish_reason !== "stop") {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_FINISH_REASON_FAILED",
        "两轮助手回复没有全部以 stop 正常结束。",
      );
    }
    return {
      conversationId,
      messageCount: publicMessages.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolMessageCount: toolMessages.length,
      expectedOrderMatched: true,
      firstAssistantHashMatched: true,
      secondAssistantHashMatched: true,
      secondExpectedTextMatched: true,
      forbiddenTextAbsent: true,
      firstAssistantContentSha256: firstContentSha256,
      secondAssistantContentSha256: secondContentSha256,
      assistantFinishReasonsMatched: true,
    };
  }
  if (action === "adapter:spark-x-agent/chat.assert-history") {
    const expectedUserText = requiredString(params, "expectedUserText", variables, 20_000);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    const expectedAssistantSha256 = requiredString(
      params,
      "expectedAssistantSha256",
      variables,
      64,
    );
    if (!sha256Pattern.test(expectedAssistantSha256)) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "星火 Agent 助手回复哈希必须是 64 位小写 SHA-256。",
      );
    }
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(
          `/conversations/${encodeURIComponent(conversationId)}/messages?page=1&per_page=100`,
        ),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CHAT_HISTORY_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_CHAT_HISTORY_RESPONSE_INVALID");
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const publicMessages = items.filter(
      (item) => item.role === "user" || item.role === "assistant",
    );
    if (publicMessages.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_CHAT_HISTORY_TRUNCATED",
        "星火 Agent 对话历史包含已截断的公开消息。",
      );
    }
    const userMessages = publicMessages.filter((item) => item.role === "user");
    const assistantMessages = publicMessages.filter((item) => item.role === "assistant");
    const assistant = assistantMessages[0];
    if (userMessages.length !== 1 || assistantMessages.length !== 1 || assistant === undefined) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_HISTORY_CARDINALITY_FAILED",
        "新建对话必须且只能持久化一条用户消息和一条助手回复。",
      );
    }
    const userContent = userMessages[0]?.content;
    const assistantContent = assistant.content;
    if (typeof userContent !== "string" || userContent !== expectedUserText) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_USER_HISTORY_ASSERTION_FAILED",
        "星火 Agent 持久化的用户消息与发送内容不一致。",
      );
    }
    if (typeof assistantContent !== "string" || !assistantContent.includes(expectedAssistantText)) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_ASSISTANT_HISTORY_ASSERTION_FAILED",
        "星火 Agent 持久化的助手回复未包含预期运行标识。",
      );
    }
    const assistantContentSha256 = createHash("sha256").update(assistantContent).digest("hex");
    if (assistantContentSha256 !== expectedAssistantSha256) {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_HISTORY_HASH_MISMATCH",
        "星火 Agent 持久化的助手回复与流式最终回复不一致。",
      );
    }
    if (assistant.finish_reason !== "stop") {
      throw assertionFailure(
        "SPARK_X_AGENT_CHAT_FINISH_REASON_FAILED",
        "星火 Agent 助手回复没有以 stop 正常结束。",
      );
    }
    return {
      conversationId,
      messageCount: publicMessages.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      assistantContentLength: assistantContent.length,
      assistantContentSha256,
      assistantFinishReason: "stop",
      ...(typeof assistant.turn_status === "string"
        ? { assistantTurnStatus: assistant.turn_status }
        : {}),
    };
  }
  if (action === "adapter:spark-x-agent/conversation.assert-recent") {
    const expectedTitle = requiredString(params, "title", variables, 200);
    const expectedMessageCount = optionalBoundedInteger(params, "expectedMessageCount", 0, 99);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath("/conversations?page=1&per_page=100&status=active"),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CONVERSATION_LIST_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_CONVERSATION_RESPONSE_INVALID");
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const position = items.findIndex((item) => item?.id === conversationId);
    const firstUnpinned = items.findIndex((item) => item?.is_pinned !== true);
    const found = position < 0 ? null : items[position];
    if (
      position < 0 ||
      firstUnpinned < 0 ||
      position !== firstUnpinned ||
      found?.title !== expectedTitle
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_RECENT_CONVERSATION_ASSERTION_FAILED",
        "新建会话未出现在最近会话列表的首个非置顶位置，或标题不一致。",
      );
    }
    const historyResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(
          `/conversations/${encodeURIComponent(conversationId)}/messages?page=1&per_page=100`,
        ),
      },
      remainingOptions(),
    );
    accepted(historyResponse, "SPARK_X_AGENT_RECENT_CONVERSATION_HISTORY_FAILED");
    const historyData = dataEnvelope(
      historyResponse.body,
      "SPARK_X_AGENT_RECENT_CONVERSATION_HISTORY_RESPONSE_INVALID",
    );
    if (!Array.isArray(historyData.items)) {
      throw apiFailure(
        "SPARK_X_AGENT_RECENT_CONVERSATION_HISTORY_RESPONSE_INVALID",
        "星火 Agent 会话历史缺少消息列表。",
      );
    }
    if (historyData.items.length >= 100) {
      throw apiFailure(
        "SPARK_X_AGENT_RECENT_CONVERSATION_HISTORY_LIMIT_EXCEEDED",
        "最近会话的持久化消息数超出受控回归边界。",
      );
    }
    const messageCount = historyData.items.length;
    if (expectedMessageCount !== undefined && messageCount !== expectedMessageCount) {
      throw apiFailure(
        "SPARK_X_AGENT_RECENT_CONVERSATION_MESSAGE_COUNT_FAILED",
        "最近会话的持久化消息数与预期不一致。",
      );
    }
    return {
      conversationId,
      listed: true,
      recentPosition: position,
      messageCount,
      messageCountSource: "conversation-history",
    };
  }

  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "DELETE",
      path: actionPath(`/conversations/${encodeURIComponent(conversationId)}`),
    },
    remainingOptions(),
  );
  if (response.status === 404) {
    return { conversationId, deleted: true, alreadyMissing: true };
  }
  accepted(response, "SPARK_X_AGENT_CONVERSATION_DELETE_FAILED");
  return { conversationId, deleted: true };
}
