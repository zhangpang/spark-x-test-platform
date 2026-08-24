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
  "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
  "adapter:spark-x-agent/conversation.assert-deleted-state",
  "adapter:spark-x-agent/conversation.delete",
  "adapter:spark-x-agent/provider.create-transient-failure-fixture",
  "adapter:spark-x-agent/provider.create-context-compaction-fixture",
  "adapter:spark-x-agent/provider.create-skill-injection-fixture",
  "adapter:spark-x-agent/provider.cleanup-transient-failure-fixture",
  "adapter:spark-x-agent/chat.ask",
  "adapter:spark-x-agent/chat.cancel-and-resume",
  "adapter:spark-x-agent/chat.assert-provider-failure-retry",
  "adapter:spark-x-agent/chat.assert-context-compaction-continuity",
  "adapter:spark-x-agent/chat.assert-history",
  "adapter:spark-x-agent/chat.assert-context-history",
  "adapter:spark-x-agent/tool.assert-safe-catalog",
  "adapter:spark-x-agent/tool.invoke-safe",
  "adapter:spark-x-agent/tool.invoke-failure-recovery",
  "adapter:spark-x-agent/tool.assert-history",
  "adapter:spark-x-agent/tool.assert-failure-recovery-history",
  "adapter:spark-x-agent/knowledge-base.create",
  "adapter:spark-x-agent/knowledge-base.upload-fixture",
  "adapter:spark-x-agent/knowledge-base.attach-upload",
  "adapter:spark-x-agent/knowledge-base.wait-ready",
  "adapter:spark-x-agent/knowledge-base.assert-large-table-continuation",
  "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
  "adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
  "adapter:spark-x-agent/knowledge-base.assert-cleaned-state",
  "adapter:spark-x-agent/knowledge-base.cleanup",
  "adapter:spark-x-agent/skill.assert-trusted-publication",
  "adapter:spark-x-agent/skill.assert-selected-injection",
  "adapter:spark-x-agent/skill.create-lifecycle-fixture",
  "adapter:spark-x-agent/skill.assert-disabled-and-deleted",
  "adapter:spark-x-agent/skill.cleanup-lifecycle-fixture",
  "adapter:spark-x-agent/mcp.create-fixture",
  "adapter:spark-x-agent/mcp.assert-invocation",
  "adapter:spark-x-agent/mcp.assert-reconnect",
  "adapter:spark-x-agent/mcp.assert-disconnect-disable-delete",
  "adapter:spark-x-agent/mcp.cleanup-fixture",
  "adapter:spark-x-agent/automation.create",
  "adapter:spark-x-agent/automation.wait-fired",
  "adapter:spark-x-agent/automation.assert-no-duplicate-delivery",
  "adapter:spark-x-agent/automation.assert-lifecycle",
  "adapter:spark-x-agent/automation.cleanup",
] as const;

export type SparkXAgentAction = (typeof sparkXAgentActions)[number];

export interface SparkXAgentExecutionOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

export const sparkXAgentActionCapabilities = [
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
        "occurrenceCount",
        "recentPosition",
        "messageCount",
        "messageCountSource",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        listed: { const: true },
        occurrenceCount: { const: 1 },
        recentPosition: { type: "integer", minimum: 0 },
        messageCount: { type: "integer", minimum: 0 },
        messageCountSource: { const: "conversation-history" },
      },
    },
  },
  {
    key: "conversation.rename-and-assert-pagination",
    name: "重命名并校验会话分页",
    description:
      "重命名一个已登记会话，并以每页两条连续扫描两次最近会话，验证跨页无重复、遗漏和顺序漂移。",
    actionLevel: "write",
    defaultTimeoutMs: 30_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "title", "expectedOrder"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        title: { type: "string", minLength: 1, maxLength: 200 },
        expectedOrder: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          uniqueItems: true,
          items: { type: "string", format: "uuid" },
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "renamed",
        "titleSource",
        "titleSha256",
        "pageSize",
        "expectedConversationCount",
        "firstSweepPages",
        "secondSweepPages",
        "distinctExpectedPages",
        "duplicateCount",
        "missingCount",
        "crossPage",
        "orderStable",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        renamed: { const: true },
        titleSource: { const: "manual" },
        titleSha256: { type: "string", minLength: 64, maxLength: 64 },
        pageSize: { const: 2 },
        expectedConversationCount: { const: 3 },
        firstSweepPages: { type: "integer", minimum: 2, maximum: 100 },
        secondSweepPages: { type: "integer", minimum: 2, maximum: 100 },
        distinctExpectedPages: { type: "integer", minimum: 2, maximum: 3 },
        duplicateCount: { const: 0 },
        missingCount: { const: 0 },
        crossPage: { const: true },
        orderStable: { const: true },
      },
    },
  },
  {
    key: "conversation.assert-deleted-state",
    name: "校验会话删除状态",
    description:
      "验证已删除会话不再出现在活动列表、删除列表中恰好保留一条，并只暴露删除态结构化证据。",
    actionLevel: "read",
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
      required: [
        "conversationId",
        "detailState",
        "activeOccurrences",
        "deletedOccurrences",
        "activePagesScanned",
        "deletedPagesScanned",
        "uniqueDeletedRecord",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        detailState: { enum: ["deleted", "missing"] },
        activeOccurrences: { const: 0 },
        deletedOccurrences: { const: 1 },
        activePagesScanned: { type: "integer", minimum: 1, maximum: 10 },
        deletedPagesScanned: { type: "integer", minimum: 1, maximum: 10 },
        uniqueDeletedRecord: { const: true },
      },
    },
  },
  {
    key: "provider.create-transient-failure-fixture",
    name: "创建短暂 Provider 故障夹具",
    description:
      "准备一个固定不可达且不具备真实凭据的显式测试 Provider；可复用已回收池资源，并冻结原活跃 Provider 标识供中断补偿。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "provider.cleanup-transient-failure-fixture",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "name"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        name: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "providerFixtureResourceId",
        "fixtureProviderId",
        "originalProviderId",
        "fixtureCreated",
        "fixtureReused",
        "originalProviderActive",
        "faultTargetAllowed",
        "faultBaseUrlSha256",
        "nameSha256",
      ],
      properties: {
        providerFixtureResourceId: { type: "string", minLength: 73, maxLength: 73 },
        fixtureProviderId: { type: "string", format: "uuid" },
        originalProviderId: { type: "string", format: "uuid" },
        fixtureCreated: { type: "boolean" },
        fixtureReused: { type: "boolean" },
        originalProviderActive: { const: true },
        faultTargetAllowed: { const: true },
        faultBaseUrlSha256: { type: "string", minLength: 64, maxLength: 64 },
        nameSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "provider.cleanup-transient-failure-fixture",
    name: "清理短暂 Provider 故障夹具",
    description:
      "重新激活夹具前 Provider；将已被不可变 Turn 引用的故障、上下文压缩和 Skill 注入夹具回收到各自显式测试池，并验证活跃 Provider 唯一。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "providerFixtureResourceId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        providerFixtureResourceId: { type: "string", minLength: 73, maxLength: 73 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "providerFixtureResourceIdSha256",
        "originalProviderActive",
        "fixtureDeleted",
        "fixtureReturnedToPool",
        "activeProviderCount",
      ],
      properties: {
        providerFixtureResourceIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        originalProviderActive: { const: true },
        fixtureDeleted: { type: "boolean" },
        fixtureReturnedToPool: { type: "boolean" },
        activeProviderCount: { const: 1 },
      },
    },
  },
  {
    key: "provider.create-context-compaction-fixture",
    name: "创建上下文压缩 Provider 夹具",
    description:
      "准备固定、受限且不转发请求的 OpenAI 兼容 Provider 夹具；可复用已回收池资源，并冻结原活跃 Provider 标识供 finally 与中断补偿。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "provider.cleanup-transient-failure-fixture",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "name"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        name: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "providerFixtureResourceId",
        "fixtureProviderId",
        "originalProviderId",
        "fixtureCreated",
        "fixtureReused",
        "originalProviderActive",
        "contextFixtureTargetAllowed",
        "contextBaseUrlSha256",
        "nameSha256",
      ],
      properties: {
        providerFixtureResourceId: { type: "string", minLength: 73, maxLength: 73 },
        fixtureProviderId: { type: "string", format: "uuid" },
        originalProviderId: { type: "string", format: "uuid" },
        fixtureCreated: { type: "boolean" },
        fixtureReused: { type: "boolean" },
        originalProviderActive: { const: true },
        contextFixtureTargetAllowed: { const: true },
        contextBaseUrlSha256: { type: "string", minLength: 64, maxLength: 64 },
        nameSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "provider.create-skill-injection-fixture",
    name: "创建 Skill 注入 Provider 夹具",
    description:
      "准备固定、受限且不转发请求的 Skill 注入 Provider 夹具；可复用已回收池资源，并冻结原活跃 Provider 标识供 finally 与中断补偿。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "provider.cleanup-transient-failure-fixture",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "name"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        name: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "providerFixtureResourceId",
        "fixtureProviderId",
        "originalProviderId",
        "fixtureCreated",
        "fixtureReused",
        "originalProviderActive",
        "skillFixtureTargetAllowed",
        "skillBaseUrlSha256",
        "nameSha256",
      ],
      properties: {
        providerFixtureResourceId: { type: "string", minLength: 73, maxLength: 73 },
        fixtureProviderId: { type: "string", format: "uuid" },
        originalProviderId: { type: "string", format: "uuid" },
        fixtureCreated: { type: "boolean" },
        fixtureReused: { type: "boolean" },
        originalProviderActive: { const: true },
        skillFixtureTargetAllowed: { const: true },
        skillBaseUrlSha256: { type: "string", minLength: 64, maxLength: 64 },
        nameSha256: { type: "string", minLength: 64, maxLength: 64 },
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
    key: "chat.assert-provider-failure-retry",
    name: "校验 Provider 短暂失败后的明确重试",
    description:
      "用已登记的固定故障 Provider 产生可见失败，恢复原 Provider 后提交独立重试 Turn，并校验消息无额外重复。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 180_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "providerFixtureResourceId",
        "requestId",
        "failureMessage",
        "retryMessage",
        "expectedText",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        providerFixtureResourceId: { type: "string", minLength: 73, maxLength: 73 },
        requestId: { type: "string", format: "uuid" },
        failureMessage: { type: "string", minLength: 1, maxLength: 20_000 },
        retryMessage: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedText: { type: "string", minLength: 1, maxLength: 5_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "failedTurnId",
        "retryTurnId",
        "firstFailureVisible",
        "failureCode",
        "failureRetryable",
        "failedAssistantAbsent",
        "retryCompleted",
        "independentAttempts",
        "messageCardinalityMatched",
        "messageCount",
        "failedUserMessageCount",
        "retryUserMessageCount",
        "retryAssistantMessageCount",
        "toolMessageCount",
        "expectedTextMatched",
        "failureInputSha256",
        "retryInputSha256",
        "retryAssistantSha256",
        "retryAssistantContentLength",
        "failurePollAttempts",
        "retryPollAttempts",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        failedTurnId: { type: "string", format: "uuid" },
        retryTurnId: { type: "string", format: "uuid" },
        firstFailureVisible: { const: true },
        failureCode: { const: "provider_unavailable" },
        failureRetryable: { const: true },
        failedAssistantAbsent: { const: true },
        retryCompleted: { const: true },
        independentAttempts: { const: true },
        messageCardinalityMatched: { const: true },
        messageCount: { const: 3 },
        failedUserMessageCount: { const: 1 },
        retryUserMessageCount: { const: 1 },
        retryAssistantMessageCount: { const: 1 },
        toolMessageCount: { const: 0 },
        expectedTextMatched: { const: true },
        failureInputSha256: { type: "string", minLength: 64, maxLength: 64 },
        retryInputSha256: { type: "string", minLength: 64, maxLength: 64 },
        retryAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
        retryAssistantContentLength: { type: "integer", minimum: 1 },
        failurePollAttempts: { type: "integer", minimum: 1, maximum: 300 },
        retryPollAttempts: { type: "integer", minimum: 1, maximum: 600 },
      },
    },
  },
  {
    key: "chat.assert-context-compaction-continuity",
    name: "校验长上下文压缩续接",
    description:
      "通过受限 Provider 夹具和内置只读 document_search 产生真实工具历史，触发语义压缩后以独立请求验证关键事实、工具状态与持久化游标连续。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 240_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "providerFixtureResourceId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        providerFixtureResourceId: { type: "string", minLength: 73, maxLength: 73 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "compactionObserved",
        "contextCompactingCount",
        "contextReadyCount",
        "phaseOrderMatched",
        "durableContinuation",
        "durableCursorContinued",
        "toolStatePreserved",
        "toolCallCount",
        "toolResultCount",
        "toolCallIdSha256",
        "toolArgumentsSha256",
        "toolResultSha256",
        "triggerRound",
        "continuationRecompactionCount",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "toolMessageCount",
        "traceToolCallCount",
        "traceToolResultCount",
        "continuationContentSha256",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        compactionObserved: { const: true },
        contextCompactingCount: { const: 1 },
        contextReadyCount: { const: 1 },
        phaseOrderMatched: { const: true },
        durableContinuation: { const: true },
        durableCursorContinued: { const: true },
        toolStatePreserved: { const: true },
        toolCallCount: { const: 1 },
        toolResultCount: { const: 1 },
        toolCallIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        toolArgumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        toolResultSha256: { type: "string", minLength: 64, maxLength: 64 },
        triggerRound: { type: "integer", minimum: 1, maximum: 24 },
        continuationRecompactionCount: { const: 0 },
        messageCount: { type: "integer", minimum: 8, maximum: 60 },
        userMessageCount: { type: "integer", minimum: 3, maximum: 26 },
        assistantMessageCount: { type: "integer", minimum: 4, maximum: 27 },
        toolMessageCount: { const: 1 },
        traceToolCallCount: { const: 1 },
        traceToolResultCount: { const: 1 },
        continuationContentSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "chat.cancel-and-resume",
    name: "取消生成并续接会话",
    description:
      "通过受控 Turn 队列启动长回答，在 active 状态请求取消，确认无幽灵助手消息后用同一会话完成下一轮。",
    actionLevel: "write",
    defaultTimeoutMs: 180_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "requestId",
        "cancelMessage",
        "resumeMessage",
        "expectedText",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        requestId: { type: "string", format: "uuid" },
        cancelMessage: { type: "string", minLength: 1, maxLength: 20_000 },
        resumeMessage: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedText: { type: "string", minLength: 1, maxLength: 5_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "cancelledTurnId",
        "resumedTurnId",
        "cancelRequested",
        "cancelActionBoundary",
        "cancelledStatus",
        "cancelledAssistantAbsent",
        "resumeCompleted",
        "messageCount",
        "cancelledUserMessageCount",
        "resumedUserMessageCount",
        "resumedAssistantMessageCount",
        "toolMessageCount",
        "ghostAssistantCount",
        "expectedTextMatched",
        "cancelInputSha256",
        "resumeInputSha256",
        "resumeAssistantSha256",
        "resumeAssistantContentLength",
        "activePollAttempts",
        "cancelPollAttempts",
        "resumePollAttempts",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        cancelledTurnId: { type: "string", format: "uuid" },
        resumedTurnId: { type: "string", format: "uuid" },
        cancelRequested: { const: true },
        cancelActionBoundary: { const: "none" },
        cancelledStatus: { const: "cancelled" },
        cancelledAssistantAbsent: { const: true },
        resumeCompleted: { const: true },
        messageCount: { const: 3 },
        cancelledUserMessageCount: { const: 1 },
        resumedUserMessageCount: { const: 1 },
        resumedAssistantMessageCount: { const: 1 },
        toolMessageCount: { const: 0 },
        ghostAssistantCount: { const: 0 },
        expectedTextMatched: { const: true },
        cancelInputSha256: { type: "string", minLength: 64, maxLength: 64 },
        resumeInputSha256: { type: "string", minLength: 64, maxLength: 64 },
        resumeAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
        resumeAssistantContentLength: { type: "integer", minimum: 1 },
        activePollAttempts: { type: "integer", minimum: 1, maximum: 200 },
        cancelPollAttempts: { type: "integer", minimum: 1, maximum: 300 },
        resumePollAttempts: { type: "integer", minimum: 1, maximum: 600 },
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
        "writeToolsAbsent",
        "reviewRequiredToolsAbsent",
        "unsafeRiskToolsAbsent",
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
        writeToolsAbsent: { const: true },
        reviewRequiredToolsAbsent: { const: true },
        unsafeRiskToolsAbsent: { const: true },
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
    key: "tool.invoke-failure-recovery",
    name: "调用失败工具并校验恢复循环",
    description:
      "通过受控对话先触发 calculator 除零失败，再调用 echo 恢复，精确校验两次调用、结果顺序和最终回复。",
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
        "failureArgumentsJson",
        "failureResultJson",
        "recoveryArgumentsJson",
        "recoveryResultJson",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        message: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedText: { type: "string", minLength: 1, maxLength: 5_000 },
        failureArgumentsJson: { type: "string", minLength: 2, maxLength: 20_000 },
        failureResultJson: { type: "string", minLength: 2, maxLength: 20_000 },
        recoveryArgumentsJson: { type: "string", minLength: 2, maxLength: 20_000 },
        recoveryResultJson: { type: "string", minLength: 2, maxLength: 20_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "done",
        "failureObserved",
        "recoveryObserved",
        "sequenceMatched",
        "expectedTextMatched",
        "toolCallCount",
        "toolResultCount",
        "failedToolResultCount",
        "successfulToolResultCount",
        "reviewEventCount",
        "failureCallIdSha256",
        "recoveryCallIdSha256",
        "failureArgumentsSha256",
        "failureResultSha256",
        "recoveryArgumentsSha256",
        "recoveryResultSha256",
        "finalContentLength",
        "finalContentSha256",
        "streamBytes",
        "truncated",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        done: { const: true },
        failureObserved: { const: true },
        recoveryObserved: { const: true },
        sequenceMatched: { const: true },
        expectedTextMatched: { const: true },
        toolCallCount: { const: 2 },
        toolResultCount: { const: 2 },
        failedToolResultCount: { const: 1 },
        successfulToolResultCount: { const: 1 },
        reviewEventCount: { const: 0 },
        failureCallIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        recoveryCallIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        failureArgumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        failureResultSha256: { type: "string", minLength: 64, maxLength: 64 },
        recoveryArgumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        recoveryResultSha256: { type: "string", minLength: 64, maxLength: 64 },
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
    key: "tool.assert-failure-recovery-history",
    name: "校验失败与恢复工具历史",
    description:
      "重新登录并校验 calculator 失败、echo 恢复、两组公开轨迹和最终助手回复已按顺序一致持久化。",
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
        "failureArgumentsSha256",
        "failureResultSha256",
        "recoveryArgumentsSha256",
        "recoveryResultSha256",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        expectedUserText: { type: "string", minLength: 1, maxLength: 20_000 },
        expectedAssistantText: { type: "string", minLength: 1, maxLength: 5_000 },
        expectedAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
        failureArgumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        failureResultSha256: { type: "string", minLength: 64, maxLength: 64 },
        recoveryArgumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        recoveryResultSha256: { type: "string", minLength: 64, maxLength: 64 },
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
        "failureObserved",
        "recoveryObserved",
        "sequenceMatched",
        "expectedUserTextMatched",
        "expectedAssistantTextMatched",
        "assistantContentLength",
        "assistantContentSha256",
        "assistantFinishReason",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        messageCount: { const: 6 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 3 },
        toolMessageCount: { const: 2 },
        toolCallCount: { const: 2 },
        toolResultCount: { const: 2 },
        traceToolCallCount: { const: 2 },
        traceToolResultCount: { const: 2 },
        failureObserved: { const: true },
        recoveryObserved: { const: true },
        sequenceMatched: { const: true },
        expectedUserTextMatched: { const: true },
        expectedAssistantTextMatched: { const: true },
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
        fixtureKind: { type: "string", enum: ["order", "account-chart", "large-table"] },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "knowledgeBaseId",
        "uploadedDocumentId",
        "uploaded",
        "fixtureKind",
        "fixtureSizeBytes",
        "fixtureSha256",
        "fileNameSha256",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        uploadedDocumentId: { type: "string", format: "uuid" },
        uploaded: { const: true },
        fixtureKind: { type: "string", enum: ["order", "account-chart", "large-table"] },
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
    key: "knowledge-base.assert-large-table-continuation",
    name: "校验大表分段与续查游标",
    description:
      "在已授权知识文档的精确解析版本上执行完整表格遍历，校验表头、签名游标、分段连续性、行基数和文档边界。",
    actionLevel: "write",
    defaultTimeoutMs: 120_000,
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
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        expectedFixtureSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "fixtureSha256",
        "parserDocumentIdSha256",
        "parserVersionIdSha256",
        "pageCount",
        "cursorCount",
        "tableUnitCount",
        "expectedRowCount",
        "recoveredRowCount",
        "headerDetected",
        "segmentsContiguous",
        "cursorChainUnique",
        "sourceComplete",
        "documentBindingMatched",
        "versionBindingMatched",
        "fixtureMarkerMatched",
        "cursorChainSha256",
        "reconstructedTableSha256",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        fixtureSha256: { type: "string", minLength: 64, maxLength: 64 },
        parserDocumentIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        parserVersionIdSha256: { type: "string", minLength: 64, maxLength: 64 },
        pageCount: { type: "integer", minimum: 2, maximum: 64 },
        cursorCount: { type: "integer", minimum: 1, maximum: 63 },
        tableUnitCount: { const: 1 },
        expectedRowCount: { const: 96 },
        recoveredRowCount: { const: 96 },
        headerDetected: { const: true },
        segmentsContiguous: { const: true },
        cursorChainUnique: { const: true },
        sourceComplete: { const: true },
        documentBindingMatched: { const: true },
        versionBindingMatched: { const: true },
        fixtureMarkerMatched: { const: true },
        cursorChainSha256: { type: "string", minLength: 64, maxLength: 64 },
        reconstructedTableSha256: { type: "string", minLength: 64, maxLength: 64 },
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
    key: "knowledge-base.query-and-assert-evidence",
    name: "查询知识并校验答案与引用证据",
    description:
      "使用不可变知识快照执行真实 V5 Turn，校验 B2C 订单事实、资源标识、引用回执和证据文档均来自允许的订单文件。",
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
        "requestId",
        "snapshotId",
        "snapshotHash",
        "knowledgeDocumentId",
        "forbiddenKnowledgeDocumentId",
        "expectedFixtureSha256",
        "expectedTitle",
        "message",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        requestId: { type: "string", format: "uuid" },
        snapshotId: { type: "string", format: "uuid" },
        snapshotHash: { type: "string", minLength: 64, maxLength: 64 },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        forbiddenKnowledgeDocumentId: { type: "string", format: "uuid" },
        expectedFixtureSha256: { type: "string", minLength: 64, maxLength: 64 },
        expectedTitle: { type: "string", minLength: 1, maxLength: 512 },
        expectedResourceMarker: { type: "string", format: "uuid" },
        forbiddenResourceMarker: { type: "string", format: "uuid" },
        message: { type: "string", minLength: 1, maxLength: 20_000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "turnId",
        "knowledgeDocumentId",
        "snapshotId",
        "snapshotHash",
        "retrievalId",
        "packetHash",
        "completed",
        "expectedFactsMatched",
        "resourceMarkerChecked",
        "resourceMarkerMatched",
        "citationSetMatched",
        "forbiddenEvidenceAbsent",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "toolMessageCount",
        "evidenceCount",
        "citedRefCount",
        "retrievalMode",
        "answerLength",
        "answerSha256",
        "evidenceSetSha256",
        "pollAttempts",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        turnId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        snapshotId: { type: "string", format: "uuid" },
        snapshotHash: { type: "string", minLength: 64, maxLength: 64 },
        retrievalId: { type: "string", format: "uuid" },
        packetHash: { type: "string", minLength: 64, maxLength: 64 },
        completed: { const: true },
        expectedFactsMatched: { const: true },
        resourceMarkerChecked: { type: "boolean" },
        resourceMarkerMatched: { const: true },
        citationSetMatched: { const: true },
        forbiddenEvidenceAbsent: { const: true },
        messageCount: { const: 2 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 1 },
        toolMessageCount: { const: 0 },
        evidenceCount: { type: "integer", minimum: 1, maximum: 20 },
        citedRefCount: { type: "integer", minimum: 1, maximum: 20 },
        retrievalMode: { type: "string", enum: ["keyword", "semantic", "hybrid"] },
        answerLength: { type: "integer", minimum: 1 },
        answerSha256: { type: "string", minLength: 64, maxLength: 64 },
        evidenceSetSha256: { type: "string", minLength: 64, maxLength: 64 },
        pollAttempts: { type: "integer", minimum: 1, maximum: 600 },
      },
    },
  },
  {
    key: "knowledge-base.assert-cleaned-state",
    name: "校验知识库清理无残留",
    description:
      "在显式清理后只读校验知识库、活动列表、领域文档、版本、检索范围和原始上传均不可访问。",
    actionLevel: "read",
    defaultTimeoutMs: 30_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "uploadedDocumentId",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        uploadedDocumentId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "knowledgeBaseId",
        "knowledgeDocumentId",
        "uploadedDocumentId",
        "baseDetailAbsent",
        "activeListAbsent",
        "domainDocumentAbsent",
        "domainVersionsAbsent",
        "retrievalRejected",
        "uploadStatusAbsent",
        "rawDocumentAbsent",
        "cleanupClosureMatched",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        knowledgeDocumentId: { type: "string", format: "uuid" },
        uploadedDocumentId: { type: "string", format: "uuid" },
        baseDetailAbsent: { const: true },
        activeListAbsent: { const: true },
        domainDocumentAbsent: { const: true },
        domainVersionsAbsent: { const: true },
        retrievalRejected: { const: true },
        uploadStatusAbsent: { const: true },
        rawDocumentAbsent: { const: true },
        cleanupClosureMatched: { const: true },
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
        "knowledgeDocumentAlreadyAbsentCount",
        "parserDeleteReceiptCount",
        "parserDeletedCount",
        "parserAlreadyAbsentCount",
        "parserVersionDeleteCount",
        "parserJobDeleteCount",
        "parserCleanupConfirmed",
        "rawDocumentDeleted",
        "knowledgeBaseArchived",
      ],
      properties: {
        knowledgeBaseId: { type: "string", format: "uuid" },
        cleaned: { const: true },
        knowledgeDocumentDeleteCount: { type: "integer", minimum: 0 },
        knowledgeDocumentAlreadyAbsentCount: { type: "integer", minimum: 0 },
        parserDeleteReceiptCount: { type: "integer", minimum: 0 },
        parserDeletedCount: { type: "integer", minimum: 0 },
        parserAlreadyAbsentCount: { type: "integer", minimum: 0 },
        parserVersionDeleteCount: { type: "integer", minimum: 0 },
        parserJobDeleteCount: { type: "integer", minimum: 0 },
        parserCleanupConfirmed: { const: true },
        rawDocumentDeleted: { type: "boolean" },
        knowledgeBaseArchived: { type: "boolean" },
        alreadyMissing: { type: "boolean" },
      },
    },
  },
  {
    key: "automation.create",
    name: "创建受控自动任务",
    description:
      "为已登记测试会话创建固定五分钟周期、无 Skill 的任务；默认立即触发，也可在受限延迟内用于生命周期回归。",
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
        firstFireDelaySeconds: { type: "integer", minimum: 0, maximum: 900 },
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
        firstFireDelaySeconds: { type: "integer", minimum: 0, maximum: 900 },
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
        expectedFirstFireAt: { type: "string", minLength: 20, maxLength: 100 },
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
        timezone: { const: "Asia/Shanghai" },
        utcOffsetMinutes: { const: 480 },
        scheduledFirstFireAt: { type: "string", format: "date-time" },
        observedFirstFireAt: { type: "string", format: "date-time" },
        observedFirstFireLocal: { type: "string", format: "date-time" },
        nextFireLocal: { type: "string", format: "date-time" },
        firstFireScheduleMatched: { const: true },
        firstFireDriftSeconds: { type: "number", minimum: 0, maximum: 60 },
        localScheduleAdvancedBySeconds: { const: 300 },
      },
    },
  },
  {
    key: "automation.assert-no-duplicate-delivery",
    name: "校验自动任务无重复投递",
    description:
      "在一次真实调度完成后连续三次核对任务游标与会话历史，任何状态推进或第二组消息均立即失败。",
    actionLevel: "write",
    defaultTimeoutMs: 15_000,
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
        "expectedLastFireAt",
        "expectedNextFireAt",
        "expectedAssistantSha256",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        automationId: { type: "string", format: "uuid" },
        conversationId: { type: "string", format: "uuid" },
        expectedName: { type: "string", minLength: 1, maxLength: 160 },
        expectedGoal: { type: "string", minLength: 1, maxLength: 65_536 },
        expectedAssistantText: { type: "string", minLength: 1, maxLength: 5_000 },
        expectedLastFireAt: { type: "string", minLength: 20, maxLength: 100 },
        expectedNextFireAt: { type: "string", minLength: 20, maxLength: 100 },
        expectedAssistantSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "automationId",
        "conversationId",
        "duplicateDeliveryAbsent",
        "stableScheduleObserved",
        "observationCount",
        "stateVersion",
        "lastFireAt",
        "nextFireAt",
        "userMessageCount",
        "assistantMessageCount",
        "toolMessageCount",
        "toolCallCount",
        "toolTraceEventCount",
        "expectedAssistantHashMatched",
        "userContentSha256",
        "assistantContentSha256",
      ],
      properties: {
        automationId: { type: "string", format: "uuid" },
        conversationId: { type: "string", format: "uuid" },
        duplicateDeliveryAbsent: { const: true },
        stableScheduleObserved: { const: true },
        observationCount: { const: 3 },
        stateVersion: { type: "integer", minimum: 2 },
        lastFireAt: { type: "string", format: "date-time" },
        nextFireAt: { type: "string", format: "date-time" },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 1 },
        toolMessageCount: { const: 0 },
        toolCallCount: { const: 0 },
        toolTraceEventCount: { const: 0 },
        expectedAssistantHashMatched: { const: true },
        userContentSha256: { type: "string", minLength: 64, maxLength: 64 },
        assistantContentSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "automation.assert-lifecycle",
    name: "校验自动任务修改、停用与删除",
    description:
      "仅操作本次运行登记且尚未触发的自动任务，按乐观版本修改、停用、启用、删除，并确认目标会话无调度消息。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 60_000,
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
        "updatedName",
        "updatedGoal",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        automationId: { type: "string", format: "uuid" },
        conversationId: { type: "string", format: "uuid" },
        expectedName: { type: "string", minLength: 1, maxLength: 160 },
        expectedGoal: { type: "string", minLength: 1, maxLength: 65_536 },
        updatedName: { type: "string", minLength: 1, maxLength: 160 },
        updatedGoal: { type: "string", minLength: 1, maxLength: 65_536 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "automationId",
        "conversationId",
        "updated",
        "disabled",
        "enabledAgain",
        "deleted",
        "absentAfterDelete",
        "noTriggerMessages",
        "initialStateVersion",
        "updatedStateVersion",
        "disabledStateVersion",
        "enabledStateVersion",
        "deletedStateVersion",
        "updatedIntervalSeconds",
        "selectedSkillAbsent",
        "updatedNameSha256",
        "updatedGoalSha256",
      ],
      properties: {
        automationId: { type: "string", format: "uuid" },
        conversationId: { type: "string", format: "uuid" },
        updated: { const: true },
        disabled: { const: true },
        enabledAgain: { const: true },
        deleted: { const: true },
        absentAfterDelete: { const: true },
        noTriggerMessages: { const: true },
        initialStateVersion: { type: "integer", minimum: 1 },
        updatedStateVersion: { type: "integer", minimum: 2 },
        disabledStateVersion: { type: "integer", minimum: 3 },
        enabledStateVersion: { type: "integer", minimum: 4 },
        deletedStateVersion: { type: "integer", minimum: 5 },
        updatedIntervalSeconds: { const: 600 },
        selectedSkillAbsent: { const: true },
        updatedNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        updatedGoalSha256: { type: "string", minLength: 64, maxLength: 64 },
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
    key: "skill.assert-selected-injection",
    name: "校验 Skill 选择注入与实际使用",
    description:
      "以固定 Provider 验证唯一选中 Skill 的正文与会话上下文真实进入模型请求，并关联流式事件、持久化 active Skill 与公开历史轨迹。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 120_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "username",
        "password",
        "conversationId",
        "providerFixtureResourceId",
        "expectedPublicationSha256",
      ],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        providerFixtureResourceId: { type: "string", minLength: 73, maxLength: 73 },
        expectedPublicationSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "skillId",
        "skillName",
        "selected",
        "publicationHashMatched",
        "providerInjectionMatched",
        "unselectedSkillBodyAbsent",
        "activeSkillPersisted",
        "skillActivatedAtPresent",
        "skillEventCount",
        "historySkillEventCount",
        "toolCallCount",
        "toolResultCount",
        "reviewEventCount",
        "messageCount",
        "userMessageCount",
        "assistantMessageCount",
        "skillNameSha256",
        "skillArgsSha256",
        "promptSha256",
        "finalContentSha256",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        skillId: { type: "string", format: "uuid" },
        skillName: { const: "trade-port-daily-brief" },
        selected: { const: true },
        publicationHashMatched: { const: true },
        providerInjectionMatched: { const: true },
        unselectedSkillBodyAbsent: { const: true },
        activeSkillPersisted: { const: true },
        skillActivatedAtPresent: { const: true },
        skillEventCount: { const: 1 },
        historySkillEventCount: { const: 1 },
        toolCallCount: { const: 0 },
        toolResultCount: { const: 0 },
        reviewEventCount: { const: 0 },
        messageCount: { const: 2 },
        userMessageCount: { const: 1 },
        assistantMessageCount: { const: 1 },
        skillNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        skillArgsSha256: { type: "string", minLength: 64, maxLength: 64 },
        promptSha256: { type: "string", minLength: 64, maxLength: 64 },
        finalContentSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "skill.create-lifecycle-fixture",
    name: "创建 Skill 生命周期夹具",
    description:
      "只创建可完整删除的 Skill 元数据夹具，不上传文件、不发布不可变版本且不写入对象存储。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: true,
    cleanupAction: "skill.cleanup-lifecycle-fixture",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "name"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        name: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "skillFixtureResourceId",
        "skillId",
        "skillNameSha256",
        "promptSha256",
        "created",
        "enabled",
        "builtin",
        "userCatalogOccurrences",
        "userDetailMatched",
        "assetRootAbsent",
        "mainAssetAbsent",
      ],
      properties: {
        skillFixtureResourceId: { type: "string", format: "uuid" },
        skillId: { type: "string", format: "uuid" },
        skillNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        promptSha256: { type: "string", minLength: 64, maxLength: 64 },
        created: { const: true },
        enabled: { const: true },
        builtin: { const: false },
        userCatalogOccurrences: { const: 1 },
        userDetailMatched: { const: true },
        assetRootAbsent: { const: true },
        mainAssetAbsent: { const: true },
      },
    },
  },
  {
    key: "skill.assert-disabled-and-deleted",
    name: "校验 Skill 停用、删除与无副作用",
    description:
      "停用已登记夹具后验证用户投影和会话选择被拒绝，删除后再验证管理/用户投影无残留且会话零消息。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 30_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "conversationId", "skillId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        conversationId: { type: "string", format: "uuid" },
        skillId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "conversationId",
        "skillId",
        "skillNameSha256",
        "disabled",
        "disabledAdminStateMatched",
        "disabledUserCatalogOccurrences",
        "disabledUserDetailDenied",
        "disabledSelectionDenied",
        "deleted",
        "deletedAdminDetailAbsent",
        "deletedAdminCatalogOccurrences",
        "deletedUserCatalogOccurrences",
        "deletedUserDetailDenied",
        "deletedSelectionDenied",
        "activeSkillAbsentBeforeDelete",
        "activeSkillAbsentAfterDelete",
        "messageCountBeforeDelete",
        "messageCountAfterDelete",
        "disabledErrorSha256",
        "deletedErrorSha256",
      ],
      properties: {
        conversationId: { type: "string", format: "uuid" },
        skillId: { type: "string", format: "uuid" },
        skillNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        disabled: { const: true },
        disabledAdminStateMatched: { const: true },
        disabledUserCatalogOccurrences: { const: 0 },
        disabledUserDetailDenied: { const: true },
        disabledSelectionDenied: { const: true },
        deleted: { const: true },
        deletedAdminDetailAbsent: { const: true },
        deletedAdminCatalogOccurrences: { const: 0 },
        deletedUserCatalogOccurrences: { const: 0 },
        deletedUserDetailDenied: { const: true },
        deletedSelectionDenied: { const: true },
        activeSkillAbsentBeforeDelete: { const: true },
        activeSkillAbsentAfterDelete: { const: true },
        messageCountBeforeDelete: { const: 0 },
        messageCountAfterDelete: { const: 0 },
        disabledErrorSha256: { type: "string", minLength: 64, maxLength: 64 },
        deletedErrorSha256: { type: "string", minLength: 64, maxLength: 64 },
      },
    },
  },
  {
    key: "skill.cleanup-lifecycle-fixture",
    name: "清理 Skill 生命周期夹具",
    description:
      "只删除名称严格绑定当前 run_id 的 Skill 元数据夹具，并验证管理投影已缺失；删除后重放幂等成功。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 20_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "skillId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        skillId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "skillId",
        "skillNameSha256",
        "deleted",
        "alreadyMissing",
        "adminDetailAbsent",
        "adminCatalogOccurrences",
      ],
      properties: {
        skillId: { type: "string", format: "uuid" },
        skillNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        deleted: { const: true },
        alreadyMissing: { type: "boolean" },
        adminDetailAbsent: { const: true },
        adminCatalogOccurrences: { const: 0 },
      },
    },
  },
  {
    key: "mcp.create-fixture",
    name: "创建 MCP 确定性夹具连接器",
    description:
      "只创建名称绑定当前 run_id、固定同主机 Streamable HTTP 地址且可完整删除的只读连接器。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 30_000,
    producesResource: true,
    cleanupAction: "mcp.cleanup-fixture",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "name"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        name: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "mcpFixtureResourceId",
        "serverId",
        "serverNameSha256",
        "addressSha256",
        "created",
        "enabled",
        "builtin",
        "stopped",
        "fixedTargetAllowed",
        "credentialProjectionMasked",
        "adminCatalogOccurrences",
      ],
      properties: {
        mcpFixtureResourceId: { type: "string", format: "uuid" },
        serverId: { type: "string", format: "uuid" },
        serverNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        addressSha256: { type: "string", minLength: 64, maxLength: 64 },
        created: { const: true },
        enabled: { const: true },
        builtin: { const: false },
        stopped: { const: true },
        fixedTargetAllowed: { const: true },
        credentialProjectionMasked: { const: true },
        adminCatalogOccurrences: { const: 1 },
      },
    },
  },
  {
    key: "mcp.assert-invocation",
    name: "校验 MCP 参数与实际调用",
    description:
      "启动已登记只读夹具，核对用户/管理员目录和正式治理后，通过管理诊断入口执行一次固定参数调用。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 90_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "serverId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        serverId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "serverId",
        "toolId",
        "serverNameSha256",
        "qualifiedNameSha256",
        "inputSchemaSha256",
        "argumentsSha256",
        "resultSha256",
        "running",
        "userProjectionMatched",
        "credentialFieldsAbsent",
        "toolGovernanceMatched",
        "invoked",
        "recordCount",
        "revision",
      ],
      properties: {
        serverId: { type: "string", format: "uuid" },
        toolId: { type: "string", format: "uuid" },
        serverNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        qualifiedNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        inputSchemaSha256: { type: "string", minLength: 64, maxLength: 64 },
        argumentsSha256: { type: "string", minLength: 64, maxLength: 64 },
        resultSha256: { type: "string", minLength: 64, maxLength: 64 },
        running: { const: true },
        userProjectionMatched: { const: true },
        credentialFieldsAbsent: { const: true },
        toolGovernanceMatched: { const: true },
        invoked: { const: true },
        recordCount: { const: 1 },
        revision: { const: 1 },
      },
    },
  },
  {
    key: "mcp.assert-reconnect",
    name: "校验 MCP 配置修改、重连与缓存刷新",
    description:
      "证明运行中配置修改在重启前仍使用旧连接，重启后切换固定 v2 地址并刷新同一工具的描述符与结果。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 120_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "serverId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        serverId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "serverId",
        "toolId",
        "serverNameSha256",
        "v1AddressSha256",
        "v2AddressSha256",
        "v1SchemaSha256",
        "v2SchemaSha256",
        "v1ResultSha256",
        "v2ResultSha256",
        "needsRestart",
        "oldConnectionUsedBeforeRestart",
        "restarted",
        "startedAtChanged",
        "toolIdentityStable",
        "descriptorChanged",
        "cacheRefreshed",
      ],
      properties: {
        serverId: { type: "string", format: "uuid" },
        toolId: { type: "string", format: "uuid" },
        serverNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        v1AddressSha256: { type: "string", minLength: 64, maxLength: 64 },
        v2AddressSha256: { type: "string", minLength: 64, maxLength: 64 },
        v1SchemaSha256: { type: "string", minLength: 64, maxLength: 64 },
        v2SchemaSha256: { type: "string", minLength: 64, maxLength: 64 },
        v1ResultSha256: { type: "string", minLength: 64, maxLength: 64 },
        v2ResultSha256: { type: "string", minLength: 64, maxLength: 64 },
        needsRestart: { const: true },
        oldConnectionUsedBeforeRestart: { const: true },
        restarted: { const: true },
        startedAtChanged: { const: true },
        toolIdentityStable: { const: true },
        descriptorChanged: { const: true },
        cacheRefreshed: { const: true },
      },
    },
  },
  {
    key: "mcp.assert-disconnect-disable-delete",
    name: "校验 MCP 断线、停用与删除",
    description:
      "切换到固定同主机不可达目标，保留首次断线错误，再停用并证明不可见、不可调用，最后删除且无残留。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 120_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "serverId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        serverId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "serverId",
        "toolId",
        "serverNameSha256",
        "disconnectErrorSha256",
        "disabledInvocationErrorSha256",
        "disconnectFailureVisible",
        "errorStateMatched",
        "runtimeToolsUnavailable",
        "disabled",
        "disabledUserCatalogOccurrences",
        "disabledInvocationDenied",
        "deleted",
        "deletedAdminDetailAbsent",
        "deletedAdminCatalogOccurrences",
        "deletedUserCatalogOccurrences",
      ],
      properties: {
        serverId: { type: "string", format: "uuid" },
        toolId: { type: "string", format: "uuid" },
        serverNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        disconnectErrorSha256: { type: "string", minLength: 64, maxLength: 64 },
        disabledInvocationErrorSha256: { type: "string", minLength: 64, maxLength: 64 },
        disconnectFailureVisible: { const: true },
        errorStateMatched: { const: true },
        runtimeToolsUnavailable: { const: true },
        disabled: { const: true },
        disabledUserCatalogOccurrences: { const: 0 },
        disabledInvocationDenied: { const: true },
        deleted: { const: true },
        deletedAdminDetailAbsent: { const: true },
        deletedAdminCatalogOccurrences: { const: 0 },
        deletedUserCatalogOccurrences: { const: 0 },
      },
    },
  },
  {
    key: "mcp.cleanup-fixture",
    name: "清理 MCP 确定性夹具",
    description:
      "只停止并删除名称严格绑定当前 run_id、地址属于固定 v1/v2/不可达集合的非内置连接器，重放幂等成功。",
    actionLevel: "dangerous",
    defaultTimeoutMs: 30_000,
    producesResource: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["username", "password", "serverId"],
      properties: {
        username: { type: "string", minLength: 1, maxLength: 200 },
        password: { type: "string", minLength: 1, maxLength: 4_096 },
        serverId: { type: "string", format: "uuid" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "serverId",
        "serverNameSha256",
        "stopped",
        "deleted",
        "alreadyMissing",
        "adminDetailAbsent",
        "adminCatalogOccurrences",
      ],
      properties: {
        serverId: { type: "string", format: "uuid" },
        serverNameSha256: { type: "string", minLength: 64, maxLength: 64 },
        stopped: { const: true },
        deleted: { const: true },
        alreadyMissing: { type: "boolean" },
        adminDetailAbsent: { const: true },
        adminCatalogOccurrences: { const: 0 },
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
  version: "0.26.1",
  protocolVersion: "1.0",
  platformRange: ">=0.1.0 <0.2.0",
  environmentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["baseUrl"],
    properties: { baseUrl: { type: "string", format: "uri" } },
  },
  capabilities: {
    actions: sparkXAgentActionCapabilities,
    assertions: [],
    fixtures: [],
    telemetry: [],
  },
};

export const sparkXAgentAdapterPhase = "full-regression-provider-explicit-retry" as const;

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
const lifecycleSkillNamePrefix = "spark-x-skill-lifecycle-";
const lifecycleSkillSource = "spark-x-test-platform-lifecycle-fixture";
const lifecycleSkillCategory = "testing";
const mcpFixtureNamePrefix = "spark-x-mcp-fixture-";
const mcpFixtureDescription = "Spark X Test Platform deterministic MCP lifecycle fixture";
const mcpFixtureToolName = "lookup_fixture";
const mcpFixtureAuthorization = "Bearer spark-x-test-platform-noncredential-mcp-fixture";
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

function derivedUuid(seed: string, purpose: string): string {
  const hex = sha256(`${seed}:${purpose}`).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  const value = hex.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join("-");
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

function requiredUuidArray(
  params: Readonly<Record<string, unknown>>,
  name: string,
  variables: Readonly<Record<string, unknown>>,
  expectedLength: number,
): readonly string[] {
  const value = params[name];
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw assertionFailure(
      "SPARK_X_AGENT_PARAMETER_INVALID",
      `星火 Agent 适配器参数 ${name} 必须恰好包含 ${expectedLength} 个 UUID。`,
    );
  }
  const ids = value.map((item) => {
    if (typeof item !== "string") {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        `星火 Agent 适配器参数 ${name} 只能包含 UUID 字符串。`,
      );
    }
    const id = interpolateString(item, variables);
    if (!uuidPattern.test(id)) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        `星火 Agent 适配器参数 ${name} 包含无效 UUID。`,
      );
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw assertionFailure(
      "SPARK_X_AGENT_PARAMETER_INVALID",
      `星火 Agent 适配器参数 ${name} 不能包含重复 UUID。`,
    );
  }
  return ids;
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

function requireKnowledgeStatus(
  response: HttpExecutionResult,
  expectedStatuses: readonly number[],
  environmentCode: string,
  assertionCode: string,
  message: string,
): void {
  if (expectedStatuses.includes(response.status)) return;
  if (response.status >= 500) {
    throw environmentFailure(
      environmentCode,
      `星火 Agent 知识库运行时返回 HTTP ${response.status}。`,
    );
  }
  throw assertionFailure(assertionCode, message);
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

function acceptedMcpRuntime(response: HttpExecutionResult, code: string): void {
  if (response.status >= 500) {
    throw environmentFailure(code, `星火 Agent MCP 运行时返回 HTTP ${response.status}。`);
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

function asiaShanghaiTimestamp(value: string): string {
  return `${new Date(Date.parse(value) + 8 * 60 * 60 * 1_000).toISOString().slice(0, -1)}+08:00`;
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
  readonly kind: KnowledgeFixtureKind;
  readonly mimeType: string;
  readonly sha256: string;
}

type KnowledgeFixtureKind = "order" | "account-chart" | "large-table";

const largeTableFixtureRowCount = 96;

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function littleEndian(values: readonly Readonly<{ value: number; bytes: 2 | 4 }>[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, item) => total + item.bytes, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const item of values) {
    if (item.bytes === 2) view.setUint16(offset, item.value, true);
    else view.setUint32(offset, item.value, true);
    offset += item.bytes;
  }
  return result;
}

function storedZip(files: readonly Readonly<{ name: string; content: string }>[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const localHeader = littleEndian([
      { value: 0x04034b50, bytes: 4 },
      { value: 20, bytes: 2 },
      { value: 0, bytes: 2 },
      { value: 0, bytes: 2 },
      { value: 0, bytes: 2 },
      { value: 33, bytes: 2 },
      { value: checksum, bytes: 4 },
      { value: content.byteLength, bytes: 4 },
      { value: content.byteLength, bytes: 4 },
      { value: name.byteLength, bytes: 2 },
      { value: 0, bytes: 2 },
    ]);
    const local = concatenateBytes([localHeader, name, content]);
    locals.push(local);
    central.push(
      concatenateBytes([
        littleEndian([
          { value: 0x02014b50, bytes: 4 },
          { value: 20, bytes: 2 },
          { value: 20, bytes: 2 },
          { value: 0, bytes: 2 },
          { value: 0, bytes: 2 },
          { value: 0, bytes: 2 },
          { value: 33, bytes: 2 },
          { value: checksum, bytes: 4 },
          { value: content.byteLength, bytes: 4 },
          { value: content.byteLength, bytes: 4 },
          { value: name.byteLength, bytes: 2 },
          { value: 0, bytes: 2 },
          { value: 0, bytes: 2 },
          { value: 0, bytes: 2 },
          { value: 0, bytes: 2 },
          { value: 0, bytes: 4 },
          { value: localOffset, bytes: 4 },
        ]),
        name,
      ]),
    );
    localOffset += local.byteLength;
  }
  const centralBytes = concatenateBytes(central);
  const end = littleEndian([
    { value: 0x06054b50, bytes: 4 },
    { value: 0, bytes: 2 },
    { value: 0, bytes: 2 },
    { value: files.length, bytes: 2 },
    { value: files.length, bytes: 2 },
    { value: centralBytes.byteLength, bytes: 4 },
    { value: localOffset, bytes: 4 },
    { value: 0, bytes: 2 },
  ]);
  return concatenateBytes([...locals, centralBytes, end]);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildLargeTableWorkbook(knowledgeBaseId: string): Uint8Array {
  const header = ["ROW_ID", "RUN_RESOURCE_ID", "ACCOUNT_CODE", "AMOUNT_CNY"];
  const rows = Array.from({ length: largeTableFixtureRowCount }, (_, index) => [
    `KB006-ROW-${String(index + 1).padStart(3, "0")}`,
    knowledgeBaseId,
    `ACCT-${String(1001 + index)}`,
    String(10_000 + index * 37),
  ]);
  const sheetRows = [header, ...rows]
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
          return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return storedZip([
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="KB006_LARGE_TABLE" sheetId="1" r:id="rId1"/></sheets>' +
        "</workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<dimension ref="A1:D${largeTableFixtureRowCount + 1}"/>` +
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
        '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/><col min="3" max="4" width="18" customWidth="1"/></cols>' +
        `<sheetData>${sheetRows}</sheetData>` +
        "</worksheet>",
    },
  ]);
}

function buildKnowledgeFixture(
  knowledgeBaseId: string,
  kind: KnowledgeFixtureKind = "order",
): KnowledgeFixture {
  if (!uuidPattern.test(knowledgeBaseId)) {
    throw assertionFailure(
      "SPARK_X_AGENT_PARAMETER_INVALID",
      "知识库测试资源标识必须是有效 UUID。",
    );
  }
  if (kind === "large-table") {
    const bytes = buildLargeTableWorkbook(knowledgeBaseId);
    return {
      bytes,
      fileName: `spark-x-large-table-${knowledgeBaseId}.xlsx`,
      kind,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const lines =
    kind === "order"
      ? [
          "SPARK_X_KB_FIXTURE",
          `RUN_RESOURCE_ID: ${knowledgeBaseId}`,
          "DOCUMENT_TYPE: B2C_ORDER",
          "ORDER_ID: B2C-KB-001",
          "CUSTOMER_CODE: SPARK-REGRESSION",
          "AMOUNT_CNY: 4200",
          "STATUS: PAID",
        ]
      : [
          "SPARK_X_ACCOUNT_CHART_FIXTURE",
          `RUN_RESOURCE_ID: ${knowledgeBaseId}`,
          "DOCUMENT_TYPE: ACCOUNT_CHART",
          "ACCOUNT_CODE: 1122",
          "ACCOUNT_NAME: ACCOUNTS_RECEIVABLE",
          "DECOY_AMOUNT_CNY: 9900",
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
    fileName:
      kind === "order"
        ? `spark-x-kb-${knowledgeBaseId}.pdf`
        : `spark-x-account-chart-${knowledgeBaseId}.pdf`,
    kind,
    mimeType: "application/pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

interface LargeTableParserBinding {
  readonly parserDocumentId: string;
  readonly parserVersionId: string;
}

interface LargeTableContinuationPage {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly totalUnits: number;
  readonly completedUnits: number;
  readonly deliveredChars: number;
  readonly usedChars: number;
  readonly sourceComplete: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

function boundedParserIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function parserContinuationPage(body: unknown, requestId: string): LargeTableContinuationPage {
  const envelope = objectValue(body);
  const result = objectValue(envelope?.result);
  const structured = objectValue(result?.structuredContent);
  const coverage = objectValue(structured?.coverage);
  const budget = objectValue(structured?.return_budget);
  const rawItems = structured?.items;
  const rawItemCount = Array.isArray(rawItems) ? rawItems.length : -1;
  const items = Array.isArray(rawItems)
    ? rawItems
        .map(objectValue)
        .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
    : null;
  if (
    envelope?.jsonrpc !== "2.0" ||
    envelope.id !== requestId ||
    envelope.error !== undefined ||
    result?.isError !== false ||
    structured === null ||
    coverage === null ||
    budget === null ||
    items === null ||
    items.length !== rawItemCount ||
    coverage.requested !== "complete" ||
    typeof coverage.source_complete !== "boolean" ||
    !Number.isInteger(coverage.total_units) ||
    !Number.isInteger(coverage.completed_units) ||
    !Number.isInteger(coverage.delivered_chars) ||
    !Number.isInteger(budget.used_chars) ||
    typeof structured.has_more !== "boolean" ||
    !(
      structured.next_cursor === null ||
      (typeof structured.next_cursor === "string" &&
        structured.next_cursor.length > 0 &&
        structured.next_cursor.length <= 100_000)
    )
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_KNOWLEDGE_TABLE_CONTINUATION_RESPONSE_INVALID",
      "大表完整遍历返回的 JSON-RPC、覆盖进度或游标结构无效。",
    );
  }
  return {
    items,
    totalUnits: coverage.total_units as number,
    completedUnits: coverage.completed_units as number,
    deliveredChars: coverage.delivered_chars as number,
    usedChars: budget.used_chars as number,
    sourceComplete: coverage.source_complete,
    hasMore: structured.has_more,
    nextCursor: structured.next_cursor,
  };
}

async function requestLargeTableContinuationPage(
  environment: HttpExecutionEnvironment,
  binding: LargeTableParserBinding,
  cursor: string | null,
  pageNumber: number,
  options: SparkXAgentExecutionOptions,
): Promise<LargeTableContinuationPage> {
  const requestId = `spark-x-kb006-page-${pageNumber}`;
  const parserTarget = new URL(environment.baseUrl);
  parserTarget.port = "18121";
  parserTarget.pathname = "/mcp/document";
  parserTarget.search = "";
  parserTarget.hash = "";
  const response = await executeSparkXAgentRequest(
    environment,
    {
      method: "POST",
      path: parserTarget.toString(),
      headers: { "Content-Type": "application/json" },
      body: {
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: {
          name: "retrieve_parsed_documents",
          arguments: {
            task: "Verify every row in the fixed KB-006 large table without omissions.",
            coverage: "complete",
            coverage_reason: "A full ordered traversal is required to prove row continuity.",
            max_return_chars: 1_000,
            max_units: 1,
            ...(cursor === null
              ? {
                  targets: ["tables"],
                  include_bbox: false,
                  filters: {
                    document_ids: [binding.parserDocumentId],
                    version_scope: "exact",
                    version_id: binding.parserVersionId,
                  },
                }
              : { cursor }),
          },
        },
      },
    },
    options.timeoutMs,
    options.signal,
    options.fetcher,
  );
  if (response.status >= 500) {
    throw environmentFailure(
      "SPARK_X_AGENT_KNOWLEDGE_TABLE_PARSER_UNAVAILABLE",
      `大表完整遍历运行时返回 HTTP ${response.status}。`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw apiFailure(
      "SPARK_X_AGENT_KNOWLEDGE_TABLE_PARSER_REJECTED",
      `大表完整遍历运行时返回 HTTP ${response.status}。`,
      response.status,
    );
  }
  const envelope = objectValue(response.body);
  const result = objectValue(envelope?.result);
  if (result?.isError === true) {
    throw apiFailure(
      "SPARK_X_AGENT_KNOWLEDGE_TABLE_PARSER_REJECTED",
      "解析服务拒绝了固定大表的精确版本完整遍历。",
    );
  }
  return parserContinuationPage(response.body, requestId);
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
          mime_type: fixture.mimeType,
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
          { type: fixture.mimeType },
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

interface ConversationPaginationSweep {
  readonly pagesScanned: number;
  readonly orderedExpectedIds: readonly string[];
  readonly expectedLocations: readonly string[];
  readonly distinctExpectedPages: number;
}

async function scanConversationPagination(
  environment: HttpExecutionEnvironment,
  token: string,
  expectedOrder: readonly string[],
  renamedConversationId: string,
  renamedTitle: string,
  remainingOptions: () => SparkXAgentExecutionOptions,
): Promise<ConversationPaginationSweep> {
  const pageSize = 2;
  const maxActiveConversations = 200;
  const expectedIds = new Set(expectedOrder);
  const seenIds = new Set<string>();
  const orderedExpectedIds: string[] = [];
  const expectedLocations: string[] = [];
  const expectedPages = new Set<number>();
  let page = 1;
  let pagesScanned = 0;
  let pageCount = 1;

  for (;;) {
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/conversations?page=${page}&per_page=${pageSize}&status=active`),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CONVERSATION_PAGINATION_LIST_FAILED");
    const data = dataEnvelope(
      response.body,
      "SPARK_X_AGENT_CONVERSATION_PAGINATION_RESPONSE_INVALID",
    );
    const items = Array.isArray(data.items) ? data.items.map(objectValue) : null;
    if (
      items === null ||
      items.some((item) => item === null) ||
      typeof data.total !== "number" ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      data.total > maxActiveConversations ||
      data.page !== page ||
      data.per_page !== pageSize ||
      items.length > pageSize
    ) {
      if (
        typeof data.total === "number" &&
        Number.isSafeInteger(data.total) &&
        data.total > maxActiveConversations
      ) {
        throw environmentFailure(
          "SPARK_X_AGENT_CONVERSATION_PAGINATION_BOUND_EXCEEDED",
          "星火 Agent 测试账号的活动会话超过分页回归安全上限，请先清理测试数据。",
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_PAGINATION_RESPONSE_INVALID",
        "星火 Agent 会话分页响应缺少受限分页字段。",
      );
    }
    pagesScanned += 1;
    if (page === 1) pageCount = Math.max(1, Math.ceil(data.total / pageSize));

    for (const [index, item] of (items as readonly Readonly<Record<string, unknown>>[]).entries()) {
      if (typeof item.id !== "string" || !uuidPattern.test(item.id)) {
        throw apiFailure(
          "SPARK_X_AGENT_CONVERSATION_PAGINATION_RESPONSE_INVALID",
          "星火 Agent 会话分页包含无效会话标识。",
        );
      }
      if (seenIds.has(item.id)) {
        throw apiFailure(
          "SPARK_X_AGENT_CONVERSATION_PAGINATION_DUPLICATE",
          "星火 Agent 会话分页扫描出现重复会话。",
        );
      }
      seenIds.add(item.id);
      if (!expectedIds.has(item.id)) continue;
      if (
        item.id === renamedConversationId &&
        (item.title !== renamedTitle || item.title_source !== "manual")
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_CONVERSATION_RENAME_NOT_PERSISTED",
          "星火 Agent 会话重命名结果未按手工标题持久化。",
        );
      }
      orderedExpectedIds.push(item.id);
      expectedLocations.push(`${page}:${index}`);
      expectedPages.add(page);
    }

    if (page >= pageCount || items.length < pageSize) break;
    page += 1;
    if (page > 100) {
      throw environmentFailure(
        "SPARK_X_AGENT_CONVERSATION_PAGINATION_BOUND_EXCEEDED",
        "星火 Agent 会话分页扫描超过安全页数上限。",
      );
    }
  }

  if (
    orderedExpectedIds.length !== expectedOrder.length ||
    expectedOrder.some((id) => !seenIds.has(id))
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_CONVERSATION_PAGINATION_MISSING",
      "星火 Agent 会话分页扫描遗漏了本次运行创建的会话。",
    );
  }
  if (orderedExpectedIds.some((id, index) => id !== expectedOrder[index])) {
    throw apiFailure(
      "SPARK_X_AGENT_CONVERSATION_PAGINATION_ORDER_FAILED",
      "星火 Agent 会话分页中的运行会话顺序与更新时间顺序不一致。",
    );
  }
  if (expectedPages.size < 2) {
    throw apiFailure(
      "SPARK_X_AGENT_CONVERSATION_PAGINATION_NOT_CROSSED",
      "星火 Agent 会话分页未让三个运行会话跨越至少两个分页。",
    );
  }
  return {
    pagesScanned,
    orderedExpectedIds,
    expectedLocations,
    distinctExpectedPages: expectedPages.size,
  };
}

interface ConversationOccurrenceScan {
  readonly occurrences: number;
  readonly pagesScanned: number;
}

async function scanConversationOccurrences(
  environment: HttpExecutionEnvironment,
  token: string,
  conversationId: string,
  status: "active" | "deleted",
  remainingOptions: () => SparkXAgentExecutionOptions,
): Promise<ConversationOccurrenceScan> {
  const pageSize = 100;
  const maxStatusConversations = 1_000;
  let occurrences = 0;
  let pagesScanned = 0;
  let page = 1;
  let pageCount = 1;

  for (;;) {
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(
          `/conversations?page=${page}&per_page=${pageSize}&status=${encodeURIComponent(status)}`,
        ),
      },
      remainingOptions(),
    );
    accepted(response, "SPARK_X_AGENT_CONVERSATION_DELETED_LIST_FAILED");
    const data = dataEnvelope(
      response.body,
      "SPARK_X_AGENT_CONVERSATION_DELETED_LIST_RESPONSE_INVALID",
    );
    const items = Array.isArray(data.items) ? data.items.map(objectValue) : null;
    if (
      items === null ||
      items.some((item) => item === null) ||
      typeof data.total !== "number" ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      data.total > maxStatusConversations ||
      data.page !== page ||
      data.per_page !== pageSize ||
      items.length > pageSize
    ) {
      if (
        typeof data.total === "number" &&
        Number.isSafeInteger(data.total) &&
        data.total > maxStatusConversations
      ) {
        throw environmentFailure(
          "SPARK_X_AGENT_CONVERSATION_STATUS_LIST_BOUND_EXCEEDED",
          "星火 Agent 测试账号的会话状态列表超过删除回归安全上限，请先归档测试数据。",
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_DELETED_LIST_RESPONSE_INVALID",
        "星火 Agent 会话状态列表缺少受限分页字段。",
      );
    }
    pagesScanned += 1;
    if (page === 1) pageCount = Math.max(1, Math.ceil(data.total / pageSize));
    for (const item of items as readonly Readonly<Record<string, unknown>>[]) {
      if (typeof item.id !== "string" || !uuidPattern.test(item.id)) {
        throw apiFailure(
          "SPARK_X_AGENT_CONVERSATION_DELETED_LIST_RESPONSE_INVALID",
          "星火 Agent 会话状态列表包含无效会话标识。",
        );
      }
      if (item.id === conversationId) occurrences += 1;
    }
    if (page >= pageCount || items.length < pageSize) break;
    page += 1;
    if (page > 10) {
      throw environmentFailure(
        "SPARK_X_AGENT_CONVERSATION_STATUS_LIST_BOUND_EXCEEDED",
        "星火 Agent 会话状态列表扫描超过安全页数上限。",
      );
    }
  }

  return { occurrences, pagesScanned };
}

const sparkXTurnStatuses = new Set([
  "queued",
  "claimed",
  "running",
  "waiting_user_input",
  "waiting_user_decision",
  "waiting_action_authorization",
  "waiting_action_reconciliation",
  "cancel_requested",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
]);
const terminalSparkXTurnStatuses = new Set(["completed", "cancelled", "failed", "interrupted"]);

interface SparkXTurnSnapshot {
  readonly turnId: string;
  readonly conversationId: string;
  readonly status: string;
  readonly stateVersion: number;
  readonly cancelRequestedAt: string | null;
  readonly finishedAt: string | null;
  readonly assistantMessageId: string | null;
  readonly finishReason: string | null;
  readonly failureCode: string | null;
  readonly failureRetryable: boolean | null;
}

function sparkXTurnSnapshot(
  body: unknown,
  expectedTurnId: string,
  expectedConversationId: string,
): SparkXTurnSnapshot {
  const snapshot = objectValue(body);
  if (
    snapshot === null ||
    snapshot.turn_id !== expectedTurnId ||
    snapshot.conversation_id !== expectedConversationId ||
    typeof snapshot.status !== "string" ||
    !sparkXTurnStatuses.has(snapshot.status) ||
    typeof snapshot.state_version !== "number" ||
    !Number.isSafeInteger(snapshot.state_version) ||
    snapshot.state_version < 1 ||
    !(snapshot.cancel_requested_at === null || typeof snapshot.cancel_requested_at === "string") ||
    !(snapshot.finished_at === null || typeof snapshot.finished_at === "string") ||
    !(
      snapshot.assistant_message_id === null ||
      (typeof snapshot.assistant_message_id === "string" &&
        uuidPattern.test(snapshot.assistant_message_id))
    ) ||
    !(
      snapshot.finish_reason === null ||
      (typeof snapshot.finish_reason === "string" &&
        ["stop", "max_tokens", "other"].includes(snapshot.finish_reason))
    ) ||
    !(snapshot.failure_code === null || typeof snapshot.failure_code === "string") ||
    !(snapshot.failure_retryable === null || typeof snapshot.failure_retryable === "boolean") ||
    terminalSparkXTurnStatuses.has(snapshot.status) !== (typeof snapshot.finished_at === "string")
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_TURN_SNAPSHOT_INVALID",
      "星火 Agent Turn 快照缺少受限状态或终态字段。",
    );
  }
  return {
    turnId: expectedTurnId,
    conversationId: expectedConversationId,
    status: snapshot.status,
    stateVersion: snapshot.state_version,
    cancelRequestedAt: snapshot.cancel_requested_at,
    finishedAt: snapshot.finished_at,
    assistantMessageId: snapshot.assistant_message_id,
    finishReason: snapshot.finish_reason,
    failureCode: snapshot.failure_code === null ? null : String(snapshot.failure_code),
    failureRetryable: snapshot.failure_retryable,
  };
}

interface EnqueuedSparkXTurn {
  readonly turnId: string;
  readonly messageId: string;
}

interface SparkXProviderProjection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly protocol: "openai" | "anthropic";
  readonly active: boolean;
  readonly hasApiKey: true;
}

interface SparkXProviderFixtureResource {
  readonly fixtureProviderId: string;
  readonly originalProviderId: string;
}

const transientProviderFixtureApiKey = "spark-x-test-platform-noncredential-fault-fixture";
const transientProviderFixtureModel = "spark-x-test-platform-fault-model";
const transientProviderFixturePoolName = "spark-x-test-platform-provider-fault-pool";
const contextCompactionFixtureApiKey =
  "spark-x-test-platform-noncredential-context-compaction-fixture";
const contextCompactionFixtureModel = "spark-x-test-platform-context-compaction-model";
const contextCompactionFixturePoolName = "spark-x-test-platform-provider-context-compaction-pool";
const skillInjectionFixtureApiKey = "spark-x-test-platform-noncredential-skill-injection-fixture";
const skillInjectionFixtureModel = "spark-x-test-platform-skill-injection-model";
const skillInjectionFixturePoolName = "spark-x-test-platform-provider-skill-injection-pool";
const providerFixtureResourcePattern =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;

interface SparkXProviderFixtureConfiguration {
  readonly poolName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

function transientProviderFixtureBaseUrl(environment: HttpExecutionEnvironment): string {
  const target = new URL(environment.baseUrl);
  target.port = "9";
  target.pathname = "/spark-x-test-platform-provider-fault";
  target.search = "";
  target.hash = "";
  assertHttpTargetAllowed(target, environment.allowlist);
  return target.toString().replace(/\/$/u, "");
}

function contextCompactionFixtureBaseUrl(environment: HttpExecutionEnvironment): string {
  const target = new URL(environment.baseUrl);
  target.protocol = "http:";
  target.port = "4173";
  target.pathname = "/api/v1/fixtures/openai/context-compaction";
  target.search = "";
  target.hash = "";
  assertHttpTargetAllowed(target, environment.allowlist);
  return target.toString().replace(/\/$/u, "");
}

function skillInjectionFixtureBaseUrl(environment: HttpExecutionEnvironment): string {
  const target = new URL(environment.baseUrl);
  target.protocol = "http:";
  target.port = "4173";
  target.pathname = "/api/v1/fixtures/openai/skill-injection";
  target.search = "";
  target.hash = "";
  assertHttpTargetAllowed(target, environment.allowlist);
  return target.toString().replace(/\/$/u, "");
}

type McpFixtureVariant = "v1" | "v2" | "fault";

function mcpFixtureAddress(
  environment: HttpExecutionEnvironment,
  variant: McpFixtureVariant,
): string {
  const target = new URL(environment.baseUrl);
  target.protocol = "http:";
  target.port = variant === "fault" ? "9" : "4173";
  target.pathname =
    variant === "fault"
      ? "/spark-x-test-platform-mcp-unavailable"
      : `/api/v1/fixtures/mcp/read-only/${variant}`;
  target.search = "";
  target.hash = "";
  assertHttpTargetAllowed(target, environment.allowlist);
  return target.toString().replace(/\/$/u, "");
}

function sparkXProviderProjection(
  value: unknown,
  code = "SPARK_X_AGENT_PROVIDER_RESPONSE_INVALID",
): SparkXProviderProjection {
  const provider = objectValue(value);
  if (
    provider === null ||
    typeof provider.id !== "string" ||
    !uuidPattern.test(provider.id) ||
    typeof provider.name !== "string" ||
    provider.name.length === 0 ||
    provider.name.length > 200 ||
    typeof provider.base_url !== "string" ||
    provider.base_url.length === 0 ||
    provider.base_url.length > 512 ||
    typeof provider.model !== "string" ||
    provider.model.length === 0 ||
    provider.model.length > 200 ||
    !["openai", "anthropic"].includes(String(provider.protocol)) ||
    typeof provider.is_active !== "boolean" ||
    provider.has_api_key !== true ||
    Object.hasOwn(provider, "api_key") ||
    Object.hasOwn(provider, "api_key_encrypted")
  ) {
    throw apiFailure(code, "星火 Agent Provider 投影缺少受限字段或暴露了凭据。");
  }
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.base_url,
    model: provider.model,
    protocol: provider.protocol as "openai" | "anthropic",
    active: provider.is_active,
    hasApiKey: true,
  };
}

async function listSparkXProviders(
  environment: HttpExecutionEnvironment,
  token: string,
  options: SparkXAgentExecutionOptions,
): Promise<readonly SparkXProviderProjection[]> {
  const response = await authenticatedRequest(
    environment,
    token,
    { method: "GET", path: actionPath("/providers") },
    options,
  );
  accepted(response, "SPARK_X_AGENT_PROVIDER_LIST_FAILED");
  const data = successfulData(response.body, "SPARK_X_AGENT_PROVIDER_LIST_RESPONSE_INVALID");
  if (!Array.isArray(data) || data.length === 0 || data.length > 50) {
    throw apiFailure(
      "SPARK_X_AGENT_PROVIDER_LIST_RESPONSE_INVALID",
      "星火 Agent Provider 列表为空或超过测试账号安全上限。",
    );
  }
  return data.map((provider) => sparkXProviderProjection(provider));
}

async function activateSparkXProvider(
  environment: HttpExecutionEnvironment,
  token: string,
  providerId: string,
  options: SparkXAgentExecutionOptions,
): Promise<void> {
  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "POST",
      path: actionPath(`/providers/${encodeURIComponent(providerId)}/activate`),
    },
    options,
  );
  accepted(response, "SPARK_X_AGENT_PROVIDER_ACTIVATION_FAILED");
}

async function updateSparkXProviderFixture(
  environment: HttpExecutionEnvironment,
  token: string,
  providerId: string,
  input: Readonly<{
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }>,
  options: SparkXAgentExecutionOptions,
): Promise<SparkXProviderProjection> {
  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "PUT",
      path: actionPath(`/providers/${encodeURIComponent(providerId)}`),
      headers: { "Content-Type": "application/json" },
      body: {
        name: input.name,
        base_url: input.baseUrl,
        api_key: input.apiKey,
        model: input.model,
        protocol: "openai",
      },
    },
    options,
  );
  accepted(response, "SPARK_X_AGENT_PROVIDER_FIXTURE_UPDATE_FAILED");
  return sparkXProviderProjection(
    successfulData(response.body, "SPARK_X_AGENT_PROVIDER_FIXTURE_UPDATE_RESPONSE_INVALID"),
    "SPARK_X_AGENT_PROVIDER_FIXTURE_UPDATE_RESPONSE_INVALID",
  );
}

function providerFixtureResource(value: string): SparkXProviderFixtureResource {
  const match = providerFixtureResourcePattern.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[1] === match[2]) {
    throw assertionFailure(
      "SPARK_X_AGENT_PROVIDER_FIXTURE_RESOURCE_INVALID",
      "短暂 Provider 故障夹具资源标识无效。",
    );
  }
  return { fixtureProviderId: match[1], originalProviderId: match[2] };
}

interface SparkXSkillLifecycleProjection {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
}

function lifecycleSkillName(runId: string): string {
  return `${lifecycleSkillNamePrefix}${runId}`;
}

function lifecycleSkillPrompt(runId: string): string {
  return `SKILL004_PROMPT:${runId}`;
}

function lifecycleSkillProjection(
  value: unknown,
  runId: string,
  code: string,
): SparkXSkillLifecycleProjection {
  const skill = objectValue(value);
  const config = objectValue(skill?.config);
  const assets = objectValue(skill?.assets);
  const expectedName = lifecycleSkillName(runId);
  const expectedPrompt = lifecycleSkillPrompt(runId);
  const allowedConfigKeys = new Set([
    "prompt_template",
    "source",
    "lifecycle_fixture",
    "durable_agent_task_v17",
  ]);
  if (
    skill === null ||
    typeof skill.id !== "string" ||
    !uuidPattern.test(skill.id) ||
    skill.name !== expectedName ||
    skill.display_name !== `Spark X Skill Lifecycle ${runId}` ||
    skill.description !== "Spark X Test Platform reversible Skill lifecycle fixture" ||
    skill.category !== lifecycleSkillCategory ||
    skill.is_builtin !== false ||
    typeof skill.is_enabled !== "boolean" ||
    config === null ||
    config.prompt_template !== expectedPrompt ||
    config.source !== lifecycleSkillSource ||
    config.lifecycle_fixture !== true ||
    Object.keys(config).some((key) => !allowedConfigKeys.has(key)) ||
    (Object.hasOwn(config, "durable_agent_task_v17") && config.durable_agent_task_v17 !== false) ||
    assets === null ||
    assets.root_exists !== false ||
    assets.has_skill_md !== false ||
    assets.main_file !== null ||
    assets.asset_count !== 0
  ) {
    throw apiFailure(code, "Skill 生命周期夹具投影超出可回收元数据边界。");
  }
  return { id: skill.id, name: expectedName, enabled: skill.is_enabled };
}

async function listAdminSkillOccurrences(
  environment: HttpExecutionEnvironment,
  token: string,
  expectedName: string,
  options: SparkXAgentExecutionOptions,
): Promise<number> {
  const response = await authenticatedRequest(
    environment,
    token,
    { method: "GET", path: actionPath("/admin/skills?page=1&per_page=100") },
    options,
  );
  acceptedSkillRuntime(response, "SPARK_X_AGENT_SKILL_ADMIN_LIST_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_SKILL_ADMIN_LIST_RESPONSE_INVALID");
  const items = Array.isArray(data.items) ? data.items.map(objectValue) : null;
  if (
    items === null ||
    items.some((item) => item === null || typeof item.name !== "string") ||
    typeof data.total !== "number" ||
    !Number.isSafeInteger(data.total) ||
    data.total < 0 ||
    data.total > 100 ||
    data.page !== 1 ||
    data.per_page !== 100 ||
    items.length !== data.total
  ) {
    if (typeof data.total === "number" && data.total > 100) {
      throw environmentFailure(
        "SPARK_X_AGENT_SKILL_CATALOG_BOUND_EXCEEDED",
        "Skill 管理清单超过 100 条，无法安全证明夹具无残留。",
      );
    }
    throw apiFailure(
      "SPARK_X_AGENT_SKILL_ADMIN_LIST_RESPONSE_INVALID",
      "Skill 管理清单缺少受限分页投影。",
    );
  }
  return items.filter((item) => item?.name === expectedName).length;
}

async function listUserSkillOccurrences(
  environment: HttpExecutionEnvironment,
  token: string,
  expectedName: string,
  options: SparkXAgentExecutionOptions,
): Promise<number> {
  const response = await authenticatedRequest(
    environment,
    token,
    { method: "GET", path: actionPath("/skills") },
    options,
  );
  acceptedSkillRuntime(response, "SPARK_X_AGENT_SKILL_LIST_FAILED");
  const data = successfulData(response.body, "SPARK_X_AGENT_SKILL_LIST_RESPONSE_INVALID");
  if (!Array.isArray(data) || data.length > 100) {
    throw environmentFailure(
      "SPARK_X_AGENT_SKILL_CATALOG_BOUND_EXCEEDED",
      "Skill 用户清单超出可控回归边界。",
    );
  }
  const items = data.map(objectValue);
  if (items.some((item) => item === null || typeof item.name !== "string")) {
    throw apiFailure("SPARK_X_AGENT_SKILL_LIST_RESPONSE_INVALID", "Skill 用户清单包含无效投影。");
  }
  return items.filter((item) => item?.name === expectedName).length;
}

function skillDenialErrorSha256(
  response: HttpExecutionResult,
  phase: "disabled" | "deleted",
): string {
  if (response.status >= 500 || response.status === 401 || response.status === 429) {
    throw environmentFailure(
      "SPARK_X_AGENT_SKILL_LIFECYCLE_DEPENDENCY_UNAVAILABLE",
      `Skill ${phase} 阶段依赖返回 HTTP ${response.status}。`,
    );
  }
  const body = objectValue(response.body);
  if (
    response.status !== 403 ||
    body?.success !== false ||
    typeof body.error !== "string" ||
    body.error !== "该技能已禁用、删除或当前用户无权激活"
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_SKILL_LIFECYCLE_DENIAL_FAILED",
      `Skill ${phase} 后未以稳定 403 拒绝选择。`,
      response.status,
    );
  }
  return sha256(body.error);
}

function assertUserSkillDetailDenied(
  response: HttpExecutionResult,
  phase: "disabled" | "deleted",
): void {
  if (response.status >= 500 || response.status === 401 || response.status === 429) {
    throw environmentFailure(
      "SPARK_X_AGENT_SKILL_LIFECYCLE_DEPENDENCY_UNAVAILABLE",
      `Skill ${phase} 详情依赖返回 HTTP ${response.status}。`,
    );
  }
  if (response.status !== 403 || response.body !== "无权访问此技能") {
    throw apiFailure(
      "SPARK_X_AGENT_SKILL_LIFECYCLE_DETAIL_DENIAL_FAILED",
      `Skill ${phase} 后用户详情未以稳定 403 拒绝。`,
      response.status,
    );
  }
}

async function assertEmptySkillLifecycleConversation(
  environment: HttpExecutionEnvironment,
  token: string,
  conversationId: string,
  options: SparkXAgentExecutionOptions,
): Promise<void> {
  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "GET",
      path: actionPath(`/conversations/${encodeURIComponent(conversationId)}`),
    },
    options,
  );
  accepted(response, "SPARK_X_AGENT_SKILL_LIFECYCLE_CONVERSATION_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_SKILL_LIFECYCLE_CONVERSATION_INVALID");
  const conversation = objectValue(data.conversation);
  if (
    conversation?.id !== conversationId ||
    conversation.active_skill_name !== null ||
    conversation.active_skill_activated_at !== null ||
    data.message_count !== 0
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_SKILL_LIFECYCLE_SIDE_EFFECT_DETECTED",
      "被拒绝的 Skill 选择产生了 active 状态或消息副作用。",
    );
  }
}

interface SparkXMcpFixtureServerProjection {
  readonly id: string;
  readonly name: string;
  readonly variant: McpFixtureVariant;
  readonly enabled: boolean;
  readonly status: "running" | "stopped" | "error" | "starting";
  readonly toolsCount: number;
  readonly startedAt: string | null;
}

interface SparkXMcpFixtureToolProjection {
  readonly id: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

interface SparkXMcpInvocationEvidence {
  readonly argumentsSha256: string;
  readonly resultSha256: string;
  readonly recordCount: 1;
  readonly revision: 1 | 2;
}

function mcpFixtureName(runId: string): string {
  return `${mcpFixtureNamePrefix}${runId}`;
}

function mcpFixtureDisplayName(runId: string): string {
  return `Spark X MCP Fixture ${runId}`;
}

function mcpFixtureInput(
  environment: HttpExecutionEnvironment,
  runId: string,
  variant: McpFixtureVariant,
  enabled: boolean,
): Readonly<Record<string, unknown>> {
  return {
    name: mcpFixtureName(runId),
    display_name: mcpFixtureDisplayName(runId),
    description: mcpFixtureDescription,
    command: "",
    args: [],
    env: {
      Authorization: mcpFixtureAuthorization,
      HEADER_X_SPARK_X_RUN_ID: runId,
    },
    transport: "streamable_http",
    address: mcpFixtureAddress(environment, variant),
    capabilities: ["tools"],
    auto_start: false,
    is_enabled: enabled,
  };
}

function mcpFixtureSchema(version: "v1" | "v2"): Readonly<Record<string, unknown>> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reference", "limit"],
    properties: {
      reference: { type: "string", pattern: "^MCP-FIXTURE:[0-9a-f-]{36}$" },
      limit: { type: "integer", minimum: 1, maximum: 1 },
      ...(version === "v1"
        ? {}
        : { revision_hint: { type: "string", const: "v2", default: "v2" } }),
    },
  };
}

function mcpFixtureArguments(
  runId: string,
  version: "v1" | "v2",
): Readonly<Record<string, unknown>> {
  return {
    reference: `MCP-FIXTURE:${runId}`,
    limit: 1,
    ...(version === "v1" ? {} : { revision_hint: "v2" }),
  };
}

function mcpFixtureStructuredResult(
  runId: string,
  version: "v1" | "v2",
): Readonly<Record<string, unknown>> {
  return {
    success: true,
    fixture_version: version,
    reference: `MCP-FIXTURE:${runId}`,
    record_count: 1,
    record: { status: "stable", revision: version === "v1" ? 1 : 2 },
  };
}

function mcpFixtureServerProjection(
  value: unknown,
  environment: HttpExecutionEnvironment,
  runId: string,
  allowedVariants: readonly McpFixtureVariant[],
  code: string,
): SparkXMcpFixtureServerProjection {
  const server = objectValue(value);
  const env = objectValue(server?.env);
  const variants = allowedVariants.filter(
    (variant) => server?.address === mcpFixtureAddress(environment, variant),
  );
  if (
    server === null ||
    typeof server.id !== "string" ||
    !uuidPattern.test(server.id) ||
    server.name !== mcpFixtureName(runId) ||
    server.display_name !== mcpFixtureDisplayName(runId) ||
    server.description !== mcpFixtureDescription ||
    server.command !== "" ||
    !Array.isArray(server.args) ||
    server.args.length !== 0 ||
    env === null ||
    env.Authorization !== "***" ||
    env.HEADER_X_SPARK_X_RUN_ID !== runId ||
    Object.keys(env).sort().join(",") !== "Authorization,HEADER_X_SPARK_X_RUN_ID" ||
    server.transport !== "streamable_http" ||
    variants.length !== 1 ||
    server.cwd !== null ||
    server.filesystem_path !== null ||
    !Array.isArray(server.capabilities) ||
    canonicalJson(server.capabilities) !== canonicalJson(["tools"]) ||
    server.auto_start !== false ||
    typeof server.is_enabled !== "boolean" ||
    server.is_builtin !== false ||
    !["running", "stopped", "error", "starting"].includes(String(server.status)) ||
    typeof server.tools_count !== "number" ||
    !Number.isSafeInteger(server.tools_count) ||
    server.tools_count < 0 ||
    server.tools_count > 10 ||
    !(
      server.started_at === null ||
      (typeof server.started_at === "string" && Number.isFinite(Date.parse(server.started_at)))
    ) ||
    !(
      server.last_error === null ||
      (typeof server.last_error === "string" && server.last_error.length <= 4_000)
    )
  ) {
    throw apiFailure(code, "MCP 夹具服务投影超出固定地址、凭据遮罩或可补偿边界。");
  }
  return {
    id: server.id,
    name: mcpFixtureName(runId),
    variant: variants[0] as McpFixtureVariant,
    enabled: server.is_enabled,
    status: server.status as SparkXMcpFixtureServerProjection["status"],
    toolsCount: server.tools_count,
    startedAt: server.started_at,
  };
}

async function listAdminMcpOccurrences(
  environment: HttpExecutionEnvironment,
  token: string,
  expectedName: string,
  options: SparkXAgentExecutionOptions,
): Promise<number> {
  const response = await authenticatedRequest(
    environment,
    token,
    { method: "GET", path: actionPath("/admin/mcp/servers") },
    options,
  );
  acceptedMcpRuntime(response, "SPARK_X_AGENT_MCP_ADMIN_LIST_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_MCP_ADMIN_LIST_INVALID");
  const items = Array.isArray(data.items) ? data.items.map(objectValue) : null;
  if (
    items === null ||
    items.length > 100 ||
    items.some(
      (item) =>
        item === null ||
        typeof item.id !== "string" ||
        !uuidPattern.test(item.id) ||
        typeof item.name !== "string",
    )
  ) {
    throw environmentFailure(
      "SPARK_X_AGENT_MCP_CATALOG_BOUND_EXCEEDED",
      "MCP 管理清单无效或超过 100 条安全上限。",
    );
  }
  return items.filter((item) => item?.name === expectedName).length;
}

async function listUserMcpOccurrences(
  environment: HttpExecutionEnvironment,
  token: string,
  expected: Readonly<{
    name: string;
    serverId?: string;
    status?: string;
    toolsCount?: number;
  }>,
  options: SparkXAgentExecutionOptions,
): Promise<Readonly<{ occurrences: number; privateFieldsAbsent: boolean }>> {
  const response = await authenticatedRequest(
    environment,
    token,
    { method: "GET", path: actionPath("/mcp/servers") },
    options,
  );
  acceptedMcpRuntime(response, "SPARK_X_AGENT_MCP_USER_LIST_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_MCP_USER_LIST_INVALID");
  const items = Array.isArray(data.items) ? data.items.map(objectValue) : null;
  if (items === null || items.length > 100 || items.some((item) => item === null)) {
    throw environmentFailure(
      "SPARK_X_AGENT_MCP_CATALOG_BOUND_EXCEEDED",
      "MCP 用户清单无效或超过 100 条安全上限。",
    );
  }
  const matches = items.filter((item) => item?.name === expected.name);
  const privateFieldsAbsent = matches.every((item) =>
    privateCatalogFields.every((field) => !Object.hasOwn(item ?? {}, field)),
  );
  if (
    matches.some(
      (item) =>
        (expected.serverId !== undefined && item?.id !== expected.serverId) ||
        item?.is_enabled !== true ||
        (expected.status !== undefined && item.status !== expected.status) ||
        (expected.toolsCount !== undefined && item.tools_count !== expected.toolsCount),
    )
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_MCP_USER_PROJECTION_MISMATCH",
      "MCP 用户投影身份、状态或工具数量不一致。",
    );
  }
  if (!privateFieldsAbsent) {
    throw apiFailure(
      "SPARK_X_AGENT_MCP_PRIVATE_FIELDS_LEAKED",
      "MCP 用户投影暴露了管理员连接配置或错误字段。",
    );
  }
  return { occurrences: matches.length, privateFieldsAbsent };
}

function mcpFixtureToolProjection(
  value: unknown,
  serverId: string,
  version: "v1" | "v2",
  code: string,
): SparkXMcpFixtureToolProjection {
  const tool = objectValue(value);
  const expectedDescription =
    version === "v1"
      ? "Read one deterministic fixture record (revision one)."
      : "Read one deterministic fixture record (revision two).";
  const expectedAnnotations = {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  if (
    tool === null ||
    typeof tool.id !== "string" ||
    !uuidPattern.test(tool.id) ||
    tool.server_id !== serverId ||
    tool.name !== mcpFixtureToolName ||
    tool.description !== expectedDescription ||
    canonicalJson(tool.input_schema) !== canonicalJson(mcpFixtureSchema(version)) ||
    canonicalJson(tool.annotations) !== canonicalJson(expectedAnnotations) ||
    tool.is_enabled !== true ||
    tool.is_discovered !== true ||
    tool.risk_level !== "low" ||
    tool.action_type !== "read" ||
    tool.is_write !== false ||
    tool.requires_review !== false
  ) {
    throw apiFailure(code, "MCP 夹具工具描述符或正式只读治理投影不一致。");
  }
  return { id: tool.id, schema: mcpFixtureSchema(version) };
}

async function readMcpFixtureTool(
  environment: HttpExecutionEnvironment,
  token: string,
  serverId: string,
  version: "v1" | "v2",
  options: SparkXAgentExecutionOptions,
): Promise<SparkXMcpFixtureToolProjection> {
  const response = await authenticatedRequest(
    environment,
    token,
    { method: "GET", path: actionPath(`/admin/mcp/servers/${encodeURIComponent(serverId)}/tools`) },
    options,
  );
  acceptedMcpRuntime(response, "SPARK_X_AGENT_MCP_TOOL_LIST_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_MCP_TOOL_LIST_INVALID");
  if (!Array.isArray(data.items) || data.items.length !== 1) {
    throw apiFailure(
      "SPARK_X_AGENT_MCP_TOOL_CARDINALITY_MISMATCH",
      "MCP 夹具必须且只能发现一个固定工具。",
    );
  }
  return mcpFixtureToolProjection(
    data.items[0],
    serverId,
    version,
    "SPARK_X_AGENT_MCP_TOOL_PROJECTION_MISMATCH",
  );
}

async function invokeMcpFixtureTool(
  environment: HttpExecutionEnvironment,
  token: string,
  runId: string,
  toolId: string,
  version: "v1" | "v2",
  options: SparkXAgentExecutionOptions,
): Promise<SparkXMcpInvocationEvidence> {
  const parameters = mcpFixtureArguments(runId, version);
  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "POST",
      path: actionPath("/admin/mcp/tools/invoke"),
      headers: { "Content-Type": "application/json" },
      body: { tool_id: toolId, parameters },
    },
    options,
  );
  acceptedMcpRuntime(response, "SPARK_X_AGENT_MCP_INVOCATION_FAILED");
  const data = dataEnvelope(response.body, "SPARK_X_AGENT_MCP_INVOCATION_INVALID");
  const result = objectValue(data.result);
  const structured = objectValue(result?.structuredContent);
  const raw = objectValue(result?.raw);
  const rawStructured = objectValue(raw?.structuredContent);
  const expected = mcpFixtureStructuredResult(runId, version);
  const expectedText = JSON.stringify(expected);
  if (
    data.qualified_name !== `${mcpFixtureName(runId)}__${mcpFixtureToolName}` ||
    result?.success !== true ||
    result.content !== expectedText ||
    structured === null ||
    canonicalJson(structured) !== canonicalJson(expected) ||
    raw === null ||
    raw.isError !== false ||
    rawStructured === null ||
    canonicalJson(rawStructured) !== canonicalJson(expected)
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_MCP_INVOCATION_RESULT_MISMATCH",
      "MCP 夹具实际调用的限定名称、参数结果或结构化映射不一致。",
    );
  }
  return {
    argumentsSha256: sha256(canonicalJson(parameters)),
    resultSha256: sha256(canonicalJson(expected)),
    recordCount: 1,
    revision: version === "v1" ? 1 : 2,
  };
}

function expectedMcpFailureSha256(
  response: HttpExecutionResult,
  code: string,
  message: string,
): string {
  if (
    response.status >= 500 ||
    response.status === 401 ||
    response.status === 403 ||
    response.status === 429
  ) {
    throw environmentFailure(code, `星火 Agent MCP 依赖返回 HTTP ${response.status}。`);
  }
  if (response.status < 400) throw apiFailure(code, message, response.status);
  return sha256(canonicalJson(response.body));
}

interface SparkXTurnAdmission {
  readonly documentContext?: Readonly<{
    provider: "caishui_knowledge";
    snapshotId: string;
    snapshotHash: string;
  }>;
  readonly toolMode?: "auto";
}

async function enqueueSparkXTurn(
  environment: HttpExecutionEnvironment,
  token: string,
  conversationId: string,
  requestId: string,
  content: string,
  remainingOptions: () => SparkXAgentExecutionOptions,
  admission: SparkXTurnAdmission = {},
): Promise<EnqueuedSparkXTurn> {
  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "POST",
      path: actionPath(`/v5/conversations/${encodeURIComponent(conversationId)}/turns`),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
      },
      body: {
        client_request_id: requestId,
        content,
        attachments: [],
        skill_names: [],
        document_ids: [],
        task_title: null,
        document_context:
          admission.documentContext === undefined
            ? null
            : {
                provider: admission.documentContext.provider,
                snapshot_id: admission.documentContext.snapshotId,
                snapshot_hash: admission.documentContext.snapshotHash,
              },
        required_capabilities:
          admission.toolMode === undefined ? null : { tool_mode: admission.toolMode },
      },
    },
    remainingOptions(),
  );
  accepted(response, "SPARK_X_AGENT_TURN_ENQUEUE_FAILED");
  const receipt = objectValue(response.body);
  if (
    receipt === null ||
    typeof receipt.turn_id !== "string" ||
    !uuidPattern.test(receipt.turn_id) ||
    typeof receipt.message_id !== "string" ||
    !uuidPattern.test(receipt.message_id) ||
    receipt.status !== "queued" ||
    receipt.idempotent_replay !== false
  ) {
    throw apiFailure(
      "SPARK_X_AGENT_TURN_ENQUEUE_RESPONSE_INVALID",
      "星火 Agent Turn 入队回执缺少唯一新建标识或排队状态。",
    );
  }
  return { turnId: receipt.turn_id, messageId: receipt.message_id };
}

async function readSparkXTurnSnapshot(
  environment: HttpExecutionEnvironment,
  token: string,
  conversationId: string,
  turnId: string,
  remainingOptions: () => SparkXAgentExecutionOptions,
): Promise<SparkXTurnSnapshot> {
  const response = await authenticatedRequest(
    environment,
    token,
    {
      method: "GET",
      path: actionPath(`/v5/turns/${encodeURIComponent(turnId)}`),
    },
    remainingOptions(),
  );
  accepted(response, "SPARK_X_AGENT_TURN_SNAPSHOT_FAILED");
  return sparkXTurnSnapshot(response.body, turnId, conversationId);
}

async function waitForSparkXTurnActive(
  environment: HttpExecutionEnvironment,
  token: string,
  conversationId: string,
  turnId: string,
  remainingOptions: () => SparkXAgentExecutionOptions,
): Promise<Readonly<{ snapshot: SparkXTurnSnapshot; pollAttempts: number }>> {
  for (let attempt = 1; attempt <= 200; attempt += 1) {
    const snapshot = await readSparkXTurnSnapshot(
      environment,
      token,
      conversationId,
      turnId,
      remainingOptions,
    );
    if (snapshot.status === "claimed" || snapshot.status === "running") {
      return { snapshot, pollAttempts: attempt };
    }
    if (terminalSparkXTurnStatuses.has(snapshot.status)) {
      throw environmentFailure(
        "SPARK_X_AGENT_TURN_CANCEL_WINDOW_MISSED",
        "星火 Agent Turn 在取消窗口建立前已经终止，无法验证用户停止生成。",
      );
    }
    await boundedDelay(100, remainingOptions().signal);
  }
  throw environmentFailure(
    "SPARK_X_AGENT_TURN_ACTIVE_TIMEOUT",
    "星火 Agent Turn 未在有界时间内进入可取消的 active 状态。",
  );
}

async function waitForSparkXTurnTerminal(
  environment: HttpExecutionEnvironment,
  token: string,
  conversationId: string,
  turnId: string,
  maximumAttempts: number,
  remainingOptions: () => SparkXAgentExecutionOptions,
): Promise<Readonly<{ snapshot: SparkXTurnSnapshot; pollAttempts: number }>> {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const snapshot = await readSparkXTurnSnapshot(
      environment,
      token,
      conversationId,
      turnId,
      remainingOptions,
    );
    if (terminalSparkXTurnStatuses.has(snapshot.status)) {
      return { snapshot, pollAttempts: attempt };
    }
    await boundedDelay(200, remainingOptions().signal);
  }
  throw environmentFailure(
    "SPARK_X_AGENT_TURN_TERMINAL_TIMEOUT",
    "星火 Agent Turn 未在有界时间内进入终态。",
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
    if (response.status === 404 || (allowMissing && response.status === 410)) {
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

interface SparkXAgentToolSequenceEvent {
  readonly kind: "call" | "result";
  readonly id: string;
  readonly name: string;
  readonly success?: boolean;
}

interface SparkXAgentSkillTrace {
  readonly name: string;
  readonly args: string;
}

interface SparkXAgentChatResult {
  readonly conversationId: string;
  readonly contentEventCount: number;
  readonly statusEventCount: number;
  readonly statusPhases: readonly string[];
  readonly assistantPreviewEventCount: number;
  readonly toolEventCount: number;
  readonly skillEventCount: number;
  readonly skillEvents: readonly SparkXAgentSkillTrace[];
  readonly reviewEventCount: number;
  readonly toolCalls: readonly SparkXAgentToolCallTrace[];
  readonly toolResults: readonly SparkXAgentToolResultTrace[];
  readonly toolSequence: readonly SparkXAgentToolSequenceEvent[];
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
  const statusPhases: string[] = [];
  let assistantPreviewEventCount = 0;
  let toolEventCount = 0;
  let skillEventCount = 0;
  const skillEvents: SparkXAgentSkillTrace[] = [];
  let reviewEventCount = 0;
  const toolCalls: SparkXAgentToolCallTrace[] = [];
  const toolResults: SparkXAgentToolResultTrace[] = [];
  const toolSequence: SparkXAgentToolSequenceEvent[] = [];
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
      if (
        event === "status" &&
        typeof data.phase === "string" &&
        data.phase.length > 0 &&
        data.phase.length <= 100
      ) {
        statusPhases.push(data.phase);
      }
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
      toolSequence.push({ kind: "call", id: data.id, name: data.name });
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
      toolSequence.push({
        kind: "result",
        id: data.id,
        name: data.name,
        success: data.success,
      });
    } else if (event === "skill") {
      if (
        typeof data.name !== "string" ||
        data.name.trim() === "" ||
        data.name.length > 200 ||
        typeof data.args !== "string" ||
        data.args.length > 8_192
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_SKILL_TRACE_INVALID",
          "星火 Agent Skill 事件缺少受限名称或参数。",
        );
      }
      skillEventCount += 1;
      skillEvents.push({ name: data.name, args: data.args });
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
    statusPhases,
    assistantPreviewEventCount,
    toolEventCount,
    skillEventCount,
    skillEvents,
    reviewEventCount,
    toolCalls,
    toolResults,
    toolSequence,
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

interface SparkXAgentChatSelection {
  readonly skillNames: readonly string[];
  readonly activeSkillName: string;
}

async function streamChat(
  environment: HttpExecutionEnvironment,
  token: string,
  expectedConversationId: string,
  message: string,
  options: SparkXAgentExecutionOptions,
  selection?: SparkXAgentChatSelection,
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
        body: JSON.stringify({
          message,
          conversation_id: expectedConversationId,
          ...(selection === undefined
            ? {}
            : {
                skill_names: selection.skillNames,
                active_skill_name: selection.activeSkillName,
              }),
        }),
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

  if (action === "adapter:spark-x-agent/provider.create-transient-failure-fixture") {
    const name = requiredString(params, "name", variables, 200);
    const runId = variables["run.id"];
    if (
      typeof runId !== "string" ||
      !uuidPattern.test(runId) ||
      !name.includes(runId) ||
      name.trim() !== name ||
      name.includes("\u0000")
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_TRACEABILITY_REQUIRED",
        "短暂 Provider 故障夹具名称必须包含当前 run_id 且符合受控文本边界。",
      );
    }
    const faultBaseUrl = transientProviderFixtureBaseUrl(environment);
    const before = await listSparkXProviders(environment, token, remainingOptions());
    const active = before.filter((provider) => provider.active);
    if (active.length !== 1 || active[0] === undefined) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_BASELINE_INVALID",
        "星火 Agent 测试账号必须且只能有一个活跃 Provider。",
      );
    }
    if (before.some((provider) => provider.name === name)) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_NAME_CONFLICT",
        "本次运行的短暂 Provider 故障夹具名称已存在，需先完成残留清理。",
      );
    }
    const poolCandidates = before.filter(
      (provider) => provider.name === transientProviderFixturePoolName,
    );
    if (poolCandidates.length > 1) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_POOL_DUPLICATED",
        "短暂 Provider 显式测试资源池存在重复记录，需先完成环境治理。",
      );
    }
    const pool = poolCandidates[0];
    if (
      pool !== undefined &&
      (pool.active ||
        pool.baseUrl !== faultBaseUrl ||
        pool.model !== transientProviderFixtureModel ||
        pool.protocol !== "openai")
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_POOL_INVALID",
        "短暂 Provider 显式测试资源池已偏离固定非活跃基线。",
      );
    }
    const fixtureCreated = pool === undefined;
    const fixtureReused = pool !== undefined;
    let fixture: SparkXProviderProjection | undefined;
    let createdId: string | undefined;
    try {
      if (pool !== undefined) {
        fixture = await updateSparkXProviderFixture(
          environment,
          token,
          pool.id,
          {
            name,
            baseUrl: faultBaseUrl,
            apiKey: transientProviderFixtureApiKey,
            model: transientProviderFixtureModel,
          },
          remainingOptions(),
        );
      } else {
        const response = await authenticatedRequest(
          environment,
          token,
          {
            method: "POST",
            path: actionPath("/providers"),
            headers: { "Content-Type": "application/json" },
            body: {
              name,
              base_url: faultBaseUrl,
              api_key: transientProviderFixtureApiKey,
              model: transientProviderFixtureModel,
              protocol: "openai",
            },
          },
          remainingOptions(),
        );
        accepted(response, "SPARK_X_AGENT_PROVIDER_FIXTURE_CREATE_FAILED");
        const createdData = dataEnvelope(
          response.body,
          "SPARK_X_AGENT_PROVIDER_FIXTURE_RESPONSE_INVALID",
        );
        createdId =
          typeof createdData.id === "string" && uuidPattern.test(createdData.id)
            ? createdData.id
            : undefined;
        fixture = sparkXProviderProjection(
          createdData,
          "SPARK_X_AGENT_PROVIDER_FIXTURE_RESPONSE_INVALID",
        );
      }
      if (
        fixture.name !== name ||
        fixture.baseUrl !== faultBaseUrl ||
        fixture.model !== transientProviderFixtureModel ||
        fixture.protocol !== "openai" ||
        fixture.active
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_PROVIDER_FIXTURE_RESPONSE_INVALID",
          "临时 Provider 故障夹具的名称、固定目标、协议或非活跃状态不一致。",
        );
      }
    } catch (firstError) {
      if (pool !== undefined) {
        try {
          await updateSparkXProviderFixture(
            environment,
            token,
            pool.id,
            {
              name: transientProviderFixturePoolName,
              baseUrl: faultBaseUrl,
              apiKey: transientProviderFixtureApiKey,
              model: transientProviderFixtureModel,
            },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; pool restoration is best-effort here.
        }
      } else if (createdId !== undefined) {
        try {
          await authenticatedRequest(
            environment,
            token,
            { method: "DELETE", path: actionPath(`/providers/${encodeURIComponent(createdId)}`) },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; a malformed new row has no safe ledger identity.
        }
      }
      throw firstError;
    }
    if (fixture === undefined) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_RESPONSE_INVALID",
        "短暂 Provider 故障夹具准备结果缺失。",
      );
    }
    const providerFixtureResourceId = `${fixture.id}:${active[0].id}`;
    return {
      providerFixtureResourceId,
      fixtureProviderId: fixture.id,
      originalProviderId: active[0].id,
      fixtureCreated,
      fixtureReused,
      originalProviderActive: true,
      faultTargetAllowed: true,
      faultBaseUrlSha256: sha256(faultBaseUrl),
      nameSha256: sha256(name),
    };
  }

  if (action === "adapter:spark-x-agent/provider.create-context-compaction-fixture") {
    const name = requiredString(params, "name", variables, 200);
    const runId = variables["run.id"];
    if (
      typeof runId !== "string" ||
      !uuidPattern.test(runId) ||
      !name.includes(runId) ||
      name.trim() !== name ||
      name.includes("\u0000")
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_CONTEXT_FIXTURE_TRACEABILITY_REQUIRED",
        "上下文压缩 Provider 夹具名称必须包含当前 run_id 且符合受控文本边界。",
      );
    }
    const contextBaseUrl = contextCompactionFixtureBaseUrl(environment);
    const before = await listSparkXProviders(environment, token, remainingOptions());
    const active = before.filter((provider) => provider.active);
    if (active.length !== 1 || active[0] === undefined) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_BASELINE_INVALID",
        "星火 Agent 测试账号必须且只能有一个活跃 Provider。",
      );
    }
    if (before.some((provider) => provider.name === name)) {
      throw environmentFailure(
        "SPARK_X_AGENT_CONTEXT_FIXTURE_NAME_CONFLICT",
        "本次运行的上下文压缩 Provider 夹具名称已存在，需先完成残留清理。",
      );
    }
    const poolCandidates = before.filter(
      (provider) => provider.name === contextCompactionFixturePoolName,
    );
    if (poolCandidates.length > 1) {
      throw environmentFailure(
        "SPARK_X_AGENT_CONTEXT_FIXTURE_POOL_DUPLICATED",
        "上下文压缩 Provider 显式测试资源池存在重复记录，需先完成环境治理。",
      );
    }
    const pool = poolCandidates[0];
    if (
      pool !== undefined &&
      (pool.active ||
        pool.baseUrl !== contextBaseUrl ||
        pool.model !== contextCompactionFixtureModel ||
        pool.protocol !== "openai")
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_CONTEXT_FIXTURE_POOL_INVALID",
        "上下文压缩 Provider 显式测试资源池已偏离固定非活跃基线。",
      );
    }
    const fixtureCreated = pool === undefined;
    const fixtureReused = pool !== undefined;
    let fixture: SparkXProviderProjection | undefined;
    let createdId: string | undefined;
    try {
      if (pool !== undefined) {
        fixture = await updateSparkXProviderFixture(
          environment,
          token,
          pool.id,
          {
            name,
            baseUrl: contextBaseUrl,
            apiKey: contextCompactionFixtureApiKey,
            model: contextCompactionFixtureModel,
          },
          remainingOptions(),
        );
      } else {
        const response = await authenticatedRequest(
          environment,
          token,
          {
            method: "POST",
            path: actionPath("/providers"),
            headers: { "Content-Type": "application/json" },
            body: {
              name,
              base_url: contextBaseUrl,
              api_key: contextCompactionFixtureApiKey,
              model: contextCompactionFixtureModel,
              protocol: "openai",
            },
          },
          remainingOptions(),
        );
        accepted(response, "SPARK_X_AGENT_CONTEXT_FIXTURE_CREATE_FAILED");
        const createdData = dataEnvelope(
          response.body,
          "SPARK_X_AGENT_CONTEXT_FIXTURE_RESPONSE_INVALID",
        );
        createdId =
          typeof createdData.id === "string" && uuidPattern.test(createdData.id)
            ? createdData.id
            : undefined;
        fixture = sparkXProviderProjection(
          createdData,
          "SPARK_X_AGENT_CONTEXT_FIXTURE_RESPONSE_INVALID",
        );
      }
      if (
        fixture.name !== name ||
        fixture.baseUrl !== contextBaseUrl ||
        fixture.model !== contextCompactionFixtureModel ||
        fixture.protocol !== "openai" ||
        fixture.active
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_CONTEXT_FIXTURE_RESPONSE_INVALID",
          "上下文压缩 Provider 夹具的名称、固定目标、协议或非活跃状态不一致。",
        );
      }
    } catch (firstError) {
      if (pool !== undefined) {
        try {
          await updateSparkXProviderFixture(
            environment,
            token,
            pool.id,
            {
              name: contextCompactionFixturePoolName,
              baseUrl: contextBaseUrl,
              apiKey: contextCompactionFixtureApiKey,
              model: contextCompactionFixtureModel,
            },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; pool restoration is best-effort here.
        }
      } else if (createdId !== undefined) {
        try {
          await authenticatedRequest(
            environment,
            token,
            { method: "DELETE", path: actionPath(`/providers/${encodeURIComponent(createdId)}`) },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; a malformed new row has no safe ledger identity.
        }
      }
      throw firstError;
    }
    if (fixture === undefined) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_FIXTURE_RESPONSE_INVALID",
        "上下文压缩 Provider 夹具准备结果缺失。",
      );
    }
    const providerFixtureResourceId = `${fixture.id}:${active[0].id}`;
    return {
      providerFixtureResourceId,
      fixtureProviderId: fixture.id,
      originalProviderId: active[0].id,
      fixtureCreated,
      fixtureReused,
      originalProviderActive: true,
      contextFixtureTargetAllowed: true,
      contextBaseUrlSha256: sha256(contextBaseUrl),
      nameSha256: sha256(name),
    };
  }

  if (action === "adapter:spark-x-agent/provider.create-skill-injection-fixture") {
    const name = requiredString(params, "name", variables, 200);
    const runId = variables["run.id"];
    if (
      typeof runId !== "string" ||
      !uuidPattern.test(runId) ||
      !name.includes(runId) ||
      name.trim() !== name ||
      name.includes("\u0000")
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_SKILL_FIXTURE_TRACEABILITY_REQUIRED",
        "Skill 注入 Provider 夹具名称必须包含当前 run_id 且符合受控文本边界。",
      );
    }
    const skillBaseUrl = skillInjectionFixtureBaseUrl(environment);
    const before = await listSparkXProviders(environment, token, remainingOptions());
    const active = before.filter((provider) => provider.active);
    if (active.length !== 1 || active[0] === undefined) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_BASELINE_INVALID",
        "星火 Agent 测试账号必须且只能有一个活跃 Provider。",
      );
    }
    if (before.some((provider) => provider.name === name)) {
      throw environmentFailure(
        "SPARK_X_AGENT_SKILL_FIXTURE_NAME_CONFLICT",
        "本次运行的 Skill 注入 Provider 夹具名称已存在，需先完成残留清理。",
      );
    }
    const poolCandidates = before.filter(
      (provider) => provider.name === skillInjectionFixturePoolName,
    );
    if (poolCandidates.length > 1) {
      throw environmentFailure(
        "SPARK_X_AGENT_SKILL_FIXTURE_POOL_DUPLICATED",
        "Skill 注入 Provider 显式测试资源池存在重复记录，需先完成环境治理。",
      );
    }
    const pool = poolCandidates[0];
    if (
      pool !== undefined &&
      (pool.active ||
        pool.baseUrl !== skillBaseUrl ||
        pool.model !== skillInjectionFixtureModel ||
        pool.protocol !== "openai")
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_SKILL_FIXTURE_POOL_INVALID",
        "Skill 注入 Provider 显式测试资源池已偏离固定非活跃基线。",
      );
    }
    const fixtureCreated = pool === undefined;
    const fixtureReused = pool !== undefined;
    let fixture: SparkXProviderProjection | undefined;
    let createdId: string | undefined;
    try {
      if (pool !== undefined) {
        fixture = await updateSparkXProviderFixture(
          environment,
          token,
          pool.id,
          {
            name,
            baseUrl: skillBaseUrl,
            apiKey: skillInjectionFixtureApiKey,
            model: skillInjectionFixtureModel,
          },
          remainingOptions(),
        );
      } else {
        const response = await authenticatedRequest(
          environment,
          token,
          {
            method: "POST",
            path: actionPath("/providers"),
            headers: { "Content-Type": "application/json" },
            body: {
              name,
              base_url: skillBaseUrl,
              api_key: skillInjectionFixtureApiKey,
              model: skillInjectionFixtureModel,
              protocol: "openai",
            },
          },
          remainingOptions(),
        );
        accepted(response, "SPARK_X_AGENT_SKILL_FIXTURE_CREATE_FAILED");
        const createdData = dataEnvelope(
          response.body,
          "SPARK_X_AGENT_SKILL_FIXTURE_RESPONSE_INVALID",
        );
        createdId =
          typeof createdData.id === "string" && uuidPattern.test(createdData.id)
            ? createdData.id
            : undefined;
        fixture = sparkXProviderProjection(
          createdData,
          "SPARK_X_AGENT_SKILL_FIXTURE_RESPONSE_INVALID",
        );
      }
      if (
        fixture.name !== name ||
        fixture.baseUrl !== skillBaseUrl ||
        fixture.model !== skillInjectionFixtureModel ||
        fixture.protocol !== "openai" ||
        fixture.active
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_SKILL_FIXTURE_RESPONSE_INVALID",
          "Skill 注入 Provider 夹具的名称、固定目标、协议或非活跃状态不一致。",
        );
      }
    } catch (firstError) {
      if (pool !== undefined) {
        try {
          await updateSparkXProviderFixture(
            environment,
            token,
            pool.id,
            {
              name: skillInjectionFixturePoolName,
              baseUrl: skillBaseUrl,
              apiKey: skillInjectionFixtureApiKey,
              model: skillInjectionFixtureModel,
            },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; pool restoration is best-effort here.
        }
      } else if (createdId !== undefined) {
        try {
          await authenticatedRequest(
            environment,
            token,
            { method: "DELETE", path: actionPath(`/providers/${encodeURIComponent(createdId)}`) },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; a malformed new row has no safe ledger identity.
        }
      }
      throw firstError;
    }
    if (fixture === undefined) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_FIXTURE_RESPONSE_INVALID",
        "Skill 注入 Provider 夹具准备结果缺失。",
      );
    }
    const providerFixtureResourceId = `${fixture.id}:${active[0].id}`;
    return {
      providerFixtureResourceId,
      fixtureProviderId: fixture.id,
      originalProviderId: active[0].id,
      fixtureCreated,
      fixtureReused,
      originalProviderActive: true,
      skillFixtureTargetAllowed: true,
      skillBaseUrlSha256: sha256(skillBaseUrl),
      nameSha256: sha256(name),
    };
  }

  if (action === "adapter:spark-x-agent/provider.cleanup-transient-failure-fixture") {
    const providerFixtureResourceId = requiredString(
      params,
      "providerFixtureResourceId",
      variables,
      73,
    );
    const fixtureResource = providerFixtureResource(providerFixtureResourceId);
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_TRACEABILITY_REQUIRED",
        "Provider 夹具清理必须绑定有效 run_id。",
      );
    }
    const before = await listSparkXProviders(environment, token, remainingOptions());
    const original = before.find((provider) => provider.id === fixtureResource.originalProviderId);
    if (original === undefined) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_RESTORE_TARGET_MISSING",
        "短暂故障前的原 Provider 已缺失，不能安全恢复账号基线。",
      );
    }
    await activateSparkXProvider(environment, token, original.id, remainingOptions());
    const fixture = before.find((provider) => provider.id === fixtureResource.fixtureProviderId);
    const candidateFixtureConfiguration: SparkXProviderFixtureConfiguration | undefined =
      fixture?.model === transientProviderFixtureModel
        ? {
            poolName: transientProviderFixturePoolName,
            baseUrl: transientProviderFixtureBaseUrl(environment),
            apiKey: transientProviderFixtureApiKey,
            model: transientProviderFixtureModel,
          }
        : fixture?.model === contextCompactionFixtureModel
          ? {
              poolName: contextCompactionFixturePoolName,
              baseUrl: contextCompactionFixtureBaseUrl(environment),
              apiKey: contextCompactionFixtureApiKey,
              model: contextCompactionFixtureModel,
            }
          : fixture?.model === skillInjectionFixtureModel
            ? {
                poolName: skillInjectionFixturePoolName,
                baseUrl: skillInjectionFixtureBaseUrl(environment),
                apiKey: skillInjectionFixtureApiKey,
                model: skillInjectionFixtureModel,
              }
            : undefined;
    const fixtureConfiguration =
      fixture === undefined || candidateFixtureConfiguration === undefined
        ? undefined
        : fixture.baseUrl === candidateFixtureConfiguration.baseUrl &&
            fixture.protocol === "openai" &&
            (fixture.name === candidateFixtureConfiguration.poolName ||
              fixture.name.includes(runId))
          ? candidateFixtureConfiguration
          : undefined;
    if (fixture !== undefined && fixtureConfiguration === undefined) {
      throw assertionFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_CLEANUP_OWNERSHIP_FAILED",
        "Provider 夹具清理目标与当前 run_id 或固定夹具配置不一致。",
      );
    }
    const fixtureDeleted = fixture === undefined;
    let fixtureReturnedToPool = false;
    if (fixtureConfiguration !== undefined && fixture !== undefined) {
      const pooled = await updateSparkXProviderFixture(
        environment,
        token,
        fixture.id,
        {
          name: fixtureConfiguration.poolName,
          baseUrl: fixtureConfiguration.baseUrl,
          apiKey: fixtureConfiguration.apiKey,
          model: fixtureConfiguration.model,
        },
        remainingOptions(),
      );
      if (
        pooled.id !== fixture.id ||
        pooled.name !== fixtureConfiguration.poolName ||
        pooled.active ||
        pooled.baseUrl !== fixtureConfiguration.baseUrl ||
        pooled.model !== fixtureConfiguration.model ||
        pooled.protocol !== "openai"
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_PROVIDER_FIXTURE_POOL_RESTORE_FAILED",
          "Provider 夹具未恢复为对应的显式非活跃测试池资源。",
        );
      }
      fixtureReturnedToPool = true;
    }
    const after = await listSparkXProviders(environment, token, remainingOptions());
    const active = after.filter((provider) => provider.active);
    const pooled = after.find((provider) => provider.id === fixtureResource.fixtureProviderId);
    const poolRestored =
      fixtureReturnedToPool &&
      fixtureConfiguration !== undefined &&
      pooled?.name === fixtureConfiguration.poolName &&
      pooled.baseUrl === fixtureConfiguration.baseUrl &&
      pooled.model === fixtureConfiguration.model &&
      pooled.protocol === "openai" &&
      !pooled.active;
    if (
      active.length !== 1 ||
      active[0]?.id !== original.id ||
      (fixtureReturnedToPool ? !poolRestored : pooled !== undefined) ||
      (fixtureConfiguration !== undefined &&
        after.some(
          (provider) =>
            provider.id !== fixtureResource.fixtureProviderId &&
            provider.name === fixtureConfiguration.poolName,
        ))
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_CLEANUP_ASSERTION_FAILED",
        "Provider 夹具清理后没有恢复唯一原 Provider、回收池或删除边界。",
      );
    }
    return {
      providerFixtureResourceIdSha256: sha256(providerFixtureResourceId),
      originalProviderActive: true,
      fixtureDeleted,
      fixtureReturnedToPool,
      activeProviderCount: active.length,
    };
  }

  if (action === "adapter:spark-x-agent/automation.create") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const name = requiredString(params, "name", variables, 160);
    const goal = requiredString(params, "goal", variables, 65_536);
    const firstFireDelaySeconds =
      optionalBoundedInteger(params, "firstFireDelaySeconds", 0, 900) ?? 0;
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
    const firstFireAt = new Date(Date.now() + firstFireDelaySeconds * 1_000).toISOString();
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
      ...(firstFireDelaySeconds === 0 ? {} : { firstFireDelaySeconds }),
    };
  }

  if (action === "adapter:spark-x-agent/automation.wait-fired") {
    const automationId = requiredUuid(params, "automationId", variables);
    const conversationId = requiredUuid(params, "conversationId", variables);
    const expectedName = requiredString(params, "expectedName", variables, 160);
    const expectedGoal = requiredString(params, "expectedGoal", variables, 65_536);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    const expectedFirstFireAt =
      params.expectedFirstFireAt === undefined
        ? undefined
        : requiredString(params, "expectedFirstFireAt", variables, 100);
    if (expectedFirstFireAt !== undefined && !validTimestamp(expectedFirstFireAt)) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "自动任务预期首次触发时间不是有效的 ISO 时间戳。",
      );
    }
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
        const timezoneEvidence = (() => {
          if (expectedFirstFireAt === undefined) return {};
          const firstFireDriftSeconds =
            Math.abs(Date.parse(definition.lastFireAt) - Date.parse(expectedFirstFireAt)) / 1_000;
          const observedFirstFireLocal = asiaShanghaiTimestamp(definition.lastFireAt);
          const nextFireLocal = asiaShanghaiTimestamp(definition.nextFireAt);
          const localScheduleAdvancedBySeconds =
            (Date.parse(nextFireLocal) - Date.parse(observedFirstFireLocal)) / 1_000;
          if (firstFireDriftSeconds > 60 || localScheduleAdvancedBySeconds !== 300) {
            throw apiFailure(
              "SPARK_X_AGENT_AUTOMATION_TIMEZONE_SCHEDULE_INVALID",
              "自动任务首次触发或 Asia/Shanghai 下一次计划与请求时间不一致。",
            );
          }
          return {
            timezone: "Asia/Shanghai" as const,
            utcOffsetMinutes: 480 as const,
            scheduledFirstFireAt: expectedFirstFireAt,
            observedFirstFireAt: definition.lastFireAt,
            observedFirstFireLocal,
            nextFireLocal,
            firstFireScheduleMatched: true as const,
            firstFireDriftSeconds,
            localScheduleAdvancedBySeconds: 300 as const,
          };
        })();
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
            ...timezoneEvidence,
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

  if (action === "adapter:spark-x-agent/automation.assert-no-duplicate-delivery") {
    const automationId = requiredUuid(params, "automationId", variables);
    const conversationId = requiredUuid(params, "conversationId", variables);
    const expectedName = requiredString(params, "expectedName", variables, 160);
    const expectedGoal = requiredString(params, "expectedGoal", variables, 65_536);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    const expectedLastFireAt = requiredString(params, "expectedLastFireAt", variables, 100);
    const expectedNextFireAt = requiredString(params, "expectedNextFireAt", variables, 100);
    const expectedAssistantSha256 = requiredSha256(params, "expectedAssistantSha256", variables);
    if (!validTimestamp(expectedLastFireAt) || !validTimestamp(expectedNextFireAt)) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "自动任务无重复投递断言缺少有效的调度时间戳。",
      );
    }
    let stableStateVersion: number | undefined;
    let finalHistory: AutomationHistoryEvidence | undefined;
    for (let observation = 1; observation <= 3; observation += 1) {
      const listResponse = await authenticatedRequest(
        environment,
        token,
        { method: "GET", path: actionPath("/v5/automations?limit=100") },
        remainingOptions(),
      );
      const definition = listedAutomation(
        listResponse,
        automationId,
        "SPARK_X_AGENT_AUTOMATION_DUPLICATE_OBSERVATION_FAILED",
      );
      if (
        definition === null ||
        definition.conversationId !== conversationId ||
        definition.name !== expectedName ||
        definition.goal !== expectedGoal ||
        definition.intervalSeconds !== 300 ||
        definition.status !== "enabled" ||
        definition.selectedSkillId !== null ||
        definition.lastFireAt === null ||
        Date.parse(definition.lastFireAt) !== Date.parse(expectedLastFireAt) ||
        Date.parse(definition.nextFireAt) !== Date.parse(expectedNextFireAt) ||
        (stableStateVersion !== undefined && definition.stateVersion !== stableStateVersion)
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_AUTOMATION_DUPLICATE_DELIVERY_DETECTED",
          "自动任务在静默观察窗口内发生第二次投递、游标推进或定义漂移。",
        );
      }
      stableStateVersion ??= definition.stateVersion;
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
      acceptedAutomationRuntime(
        historyResponse,
        "SPARK_X_AGENT_AUTOMATION_DUPLICATE_HISTORY_FAILED",
      );
      const history = automationHistoryEvidence(
        historyResponse.body,
        expectedGoal,
        expectedAssistantText,
      );
      if (
        history === null ||
        history.assistantContentSha256 !== expectedAssistantSha256 ||
        (finalHistory !== undefined &&
          (history.userContentSha256 !== finalHistory.userContentSha256 ||
            history.assistantContentSha256 !== finalHistory.assistantContentSha256))
      ) {
        throw apiFailure(
          "SPARK_X_AGENT_AUTOMATION_DUPLICATE_DELIVERY_DETECTED",
          "自动任务在静默观察窗口内出现重复消息或已完成回复发生漂移。",
        );
      }
      finalHistory = history;
      if (observation < 3) await boundedDelay(2_000, remainingOptions().signal);
    }
    if (stableStateVersion === undefined || finalHistory === undefined) {
      throw environmentFailure(
        "SPARK_X_AGENT_AUTOMATION_DUPLICATE_OBSERVATION_INCOMPLETE",
        "自动任务无重复投递观察未完成。",
      );
    }
    return {
      automationId,
      conversationId,
      duplicateDeliveryAbsent: true,
      stableScheduleObserved: true,
      observationCount: 3,
      stateVersion: stableStateVersion,
      lastFireAt: expectedLastFireAt,
      nextFireAt: expectedNextFireAt,
      userMessageCount: finalHistory.userMessageCount,
      assistantMessageCount: finalHistory.assistantMessageCount,
      toolMessageCount: finalHistory.toolMessageCount,
      toolCallCount: finalHistory.toolCallCount,
      toolTraceEventCount: finalHistory.toolTraceEventCount,
      expectedAssistantHashMatched: true,
      userContentSha256: finalHistory.userContentSha256,
      assistantContentSha256: finalHistory.assistantContentSha256,
    };
  }

  if (action === "adapter:spark-x-agent/automation.assert-lifecycle") {
    const automationId = requiredUuid(params, "automationId", variables);
    const conversationId = requiredUuid(params, "conversationId", variables);
    const expectedName = requiredString(params, "expectedName", variables, 160);
    const expectedGoal = requiredString(params, "expectedGoal", variables, 65_536);
    const updatedName = requiredString(params, "updatedName", variables, 160);
    const updatedGoal = requiredString(params, "updatedGoal", variables, 65_536);
    if (
      updatedName.trim() !== updatedName ||
      updatedGoal.includes("\u0000") ||
      updatedGoal.includes("\r") ||
      new TextEncoder().encode(updatedGoal).byteLength > 65_536
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "自动任务更新名称或目标违反受控文本边界。",
      );
    }
    const list = async (code: string): Promise<AutomationDefinitionProjection | null> => {
      const response = await authenticatedRequest(
        environment,
        token,
        { method: "GET", path: actionPath("/v5/automations?limit=100") },
        remainingOptions(),
      );
      return listedAutomation(response, automationId, code);
    };
    const baseline = await list("SPARK_X_AGENT_AUTOMATION_LIFECYCLE_LIST_FAILED");
    if (
      baseline === null ||
      baseline.conversationId !== conversationId ||
      baseline.name !== expectedName ||
      baseline.goal !== expectedGoal ||
      baseline.intervalSeconds !== 300 ||
      baseline.status !== "enabled" ||
      baseline.selectedSkillId !== null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_PRECONDITION_FAILED",
        "本次运行登记的自动任务与生命周期测试前置定义不一致。",
      );
    }
    if (baseline.lastFireAt !== null || Date.parse(baseline.nextFireAt) - Date.now() < 300_000) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_ALREADY_FIRED",
        "生命周期测试任务已触发或没有保留足够的无触发变更窗口。",
      );
    }
    const updatedNextFireAt = new Date(Date.now() + 600_000).toISOString();
    const updateResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "PUT",
        path: actionPath(`/v5/automations/${encodeURIComponent(automationId)}`),
        headers: { "Content-Type": "application/json" },
        body: {
          expected_version: baseline.stateVersion,
          name: updatedName,
          goal: updatedGoal,
          selected_skill_id: null,
          interval_seconds: 600,
          next_fire_at: updatedNextFireAt,
        },
      },
      remainingOptions(),
    );
    acceptedAutomationRuntime(updateResponse, "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_UPDATE_FAILED");
    const updateReceipt = objectValue(updateResponse.body);
    if (
      updateReceipt === null ||
      updateReceipt.definition_id !== automationId ||
      updateReceipt.state_version !== baseline.stateVersion + 1 ||
      updateReceipt.status !== "enabled" ||
      !validTimestamp(updateReceipt.next_fire_at) ||
      Math.abs(Date.parse(updateReceipt.next_fire_at) - Date.parse(updatedNextFireAt)) > 1_000
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_UPDATE_RESPONSE_INVALID",
        "自动任务修改回执与乐观版本或下一次计划不一致。",
      );
    }
    const updatedVersion = Number(updateReceipt.state_version);
    const updated = await list("SPARK_X_AGENT_AUTOMATION_LIFECYCLE_LIST_FAILED");
    if (
      updated === null ||
      updated.stateVersion !== updatedVersion ||
      updated.name !== updatedName ||
      updated.goal !== updatedGoal ||
      updated.intervalSeconds !== 600 ||
      updated.status !== "enabled" ||
      updated.lastFireAt !== null ||
      updated.selectedSkillId !== null ||
      Math.abs(Date.parse(updated.nextFireAt) - Date.parse(updatedNextFireAt)) > 1_000
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_UPDATE_NOT_PERSISTED",
        "自动任务修改后的定义、周期或下一次计划未精确持久化。",
      );
    }
    const disableResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath(`/v5/automations/${encodeURIComponent(automationId)}/disable`),
        headers: { "Content-Type": "application/json" },
        body: { expected_version: updatedVersion },
      },
      remainingOptions(),
    );
    acceptedAutomationRuntime(disableResponse, "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_DISABLE_FAILED");
    const disableReceipt = objectValue(disableResponse.body);
    if (
      disableReceipt === null ||
      disableReceipt.definition_id !== automationId ||
      disableReceipt.state_version !== updatedVersion + 1 ||
      disableReceipt.status !== "disabled" ||
      disableReceipt.next_fire_at !== null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_DISABLE_RESPONSE_INVALID",
        "自动任务停用回执与乐观版本或停用状态不一致。",
      );
    }
    const disabledVersion = Number(disableReceipt.state_version);
    const disabled = await list("SPARK_X_AGENT_AUTOMATION_LIFECYCLE_LIST_FAILED");
    if (
      disabled === null ||
      disabled.stateVersion !== disabledVersion ||
      disabled.status !== "disabled" ||
      disabled.lastFireAt !== null ||
      disabled.name !== updatedName ||
      disabled.goal !== updatedGoal
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_DISABLE_NOT_PERSISTED",
        "自动任务停用状态或已修改定义未精确持久化。",
      );
    }
    const enableResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath(`/v5/automations/${encodeURIComponent(automationId)}/enable`),
        headers: { "Content-Type": "application/json" },
        body: { expected_version: disabledVersion },
      },
      remainingOptions(),
    );
    acceptedAutomationRuntime(enableResponse, "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_ENABLE_FAILED");
    const enableReceipt = objectValue(enableResponse.body);
    if (
      enableReceipt === null ||
      enableReceipt.definition_id !== automationId ||
      enableReceipt.state_version !== disabledVersion + 1 ||
      enableReceipt.status !== "enabled" ||
      !validTimestamp(enableReceipt.next_fire_at)
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_ENABLE_RESPONSE_INVALID",
        "自动任务重新启用回执与乐观版本或下一次计划不一致。",
      );
    }
    const enabledVersion = Number(enableReceipt.state_version);
    const deleteResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "DELETE",
        path: actionPath(`/v5/automations/${encodeURIComponent(automationId)}`),
        headers: { "Content-Type": "application/json" },
        body: { expected_version: enabledVersion },
      },
      remainingOptions(),
    );
    acceptedAutomationRuntime(deleteResponse, "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_DELETE_FAILED");
    const deleteReceipt = objectValue(deleteResponse.body);
    if (
      deleteReceipt === null ||
      deleteReceipt.definition_id !== automationId ||
      deleteReceipt.state_version !== enabledVersion + 1 ||
      deleteReceipt.status !== "disabled" ||
      deleteReceipt.next_fire_at !== null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_DELETE_RESPONSE_INVALID",
        "自动任务删除回执与乐观版本或终止状态不一致。",
      );
    }
    const deletedVersion = Number(deleteReceipt.state_version);
    if ((await list("SPARK_X_AGENT_AUTOMATION_LIFECYCLE_LIST_FAILED")) !== null) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_DELETE_NOT_PERSISTED",
        "自动任务删除后仍出现在所有者任务列表。",
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
    acceptedAutomationRuntime(historyResponse, "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_HISTORY_FAILED");
    const history = dataEnvelope(
      historyResponse.body,
      "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_HISTORY_RESPONSE_INVALID",
    );
    if (!Array.isArray(history.items) || history.items.length !== 0) {
      throw apiFailure(
        "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_UNEXPECTED_TRIGGER",
        "自动任务在修改、停用或删除期间产生了非预期调度消息。",
      );
    }
    return {
      automationId,
      conversationId,
      updated: true,
      disabled: true,
      enabledAgain: true,
      deleted: true,
      absentAfterDelete: true,
      noTriggerMessages: true,
      initialStateVersion: baseline.stateVersion,
      updatedStateVersion: updatedVersion,
      disabledStateVersion: disabledVersion,
      enabledStateVersion: enabledVersion,
      deletedStateVersion: deletedVersion,
      updatedIntervalSeconds: 600,
      selectedSkillAbsent: true,
      updatedNameSha256: sha256(updatedName),
      updatedGoalSha256: sha256(updatedGoal),
    };
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

  if (action === "adapter:spark-x-agent/skill.assert-selected-injection") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const providerFixtureResourceId = requiredString(
      params,
      "providerFixtureResourceId",
      variables,
      73,
    );
    const expectedPublicationSha256 = requiredSha256(
      params,
      "expectedPublicationSha256",
      variables,
    );
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_SKILL_RUN_ID_REQUIRED",
        "Skill 注入回归必须绑定有效 run_id。",
      );
    }
    const fixtureResource = providerFixtureResource(providerFixtureResourceId);
    const skillBaseUrl = skillInjectionFixtureBaseUrl(environment);
    const providers = await listSparkXProviders(environment, token, remainingOptions());
    const original = providers.find(
      (provider) => provider.id === fixtureResource.originalProviderId,
    );
    const fixture = providers.find((provider) => provider.id === fixtureResource.fixtureProviderId);
    const active = providers.filter((provider) => provider.active);
    if (
      original === undefined ||
      fixture === undefined ||
      active.length !== 1 ||
      active[0]?.id !== original.id ||
      fixture.active ||
      fixture.baseUrl !== skillBaseUrl ||
      fixture.model !== skillInjectionFixtureModel ||
      fixture.protocol !== "openai"
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_SKILL_FIXTURE_BASELINE_INVALID",
        "Skill 注入 Provider 夹具或原活跃 Provider 已偏离本次运行登记基线。",
      );
    }

    const skillResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/skills/${encodeURIComponent(trustedSkillName)}`) },
      remainingOptions(),
    );
    acceptedSkillRuntime(skillResponse, "SPARK_X_AGENT_SELECTED_SKILL_DETAIL_FAILED");
    const skill = objectValue(
      successfulData(skillResponse.body, "SPARK_X_AGENT_SELECTED_SKILL_DETAIL_INVALID"),
    );
    const skillConfig = objectValue(skill?.config);
    const prompt = skillConfig?.prompt_template;
    if (
      skill === null ||
      typeof skill.id !== "string" ||
      !uuidPattern.test(skill.id) ||
      skill.name !== trustedSkillName ||
      skill.display_name !== trustedSkillDisplayName ||
      skill.category !== trustedSkillCategory ||
      skill.is_enabled !== true ||
      skill.is_builtin !== false ||
      skillConfig === null ||
      typeof prompt !== "string" ||
      prompt.length === 0 ||
      new TextEncoder().encode(prompt).byteLength > 65_536 ||
      prompt.includes("\u0000")
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_SELECTED_SKILL_DETAIL_INVALID",
        "选中 Skill 的身份、状态、分类或受限发布正文投影不完整。",
      );
    }
    const promptSha256 = sha256(prompt);
    if (promptSha256 !== expectedPublicationSha256) {
      throw assertionFailure(
        "SPARK_X_AGENT_SELECTED_SKILL_HASH_MISMATCH",
        "选中 Skill 的精确发布内容哈希与测试基线不一致。",
      );
    }

    await activateSparkXProvider(environment, token, fixture.id, remainingOptions());
    const activated = await listSparkXProviders(environment, token, remainingOptions());
    const activatedProviders = activated.filter((provider) => provider.active);
    if (activatedProviders.length !== 1 || activatedProviders[0]?.id !== fixture.id) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_FIXTURE_ACTIVATION_ASSERTION_FAILED",
        "Skill 注入 Provider 夹具没有成为唯一活跃 Provider。",
      );
    }

    const message = `SKILL002_USE:${runId}`;
    const finalContent = `SKILL002_APPLIED:${runId}`;
    const result = await streamChat(
      environment,
      token,
      conversationId,
      message,
      remainingOptions(),
      { skillNames: [trustedSkillName], activeSkillName: trustedSkillName },
    );
    const skillEvent = result.skillEvents[0];
    if (
      result.finalContent !== finalContent ||
      result.stopReason !== "stop" ||
      result.skillEventCount !== 1 ||
      result.skillEvents.length !== 1 ||
      skillEvent?.name !== trustedSkillName ||
      skillEvent?.args !== "" ||
      result.toolEventCount !== 0 ||
      result.toolCalls.length !== 0 ||
      result.toolResults.length !== 0 ||
      result.reviewEventCount !== 0
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_SELECTED_SKILL_INJECTION_FAILED",
        "唯一选中 Skill 未形成固定能力回复、唯一流式 Skill 事件或零额外工具边界。",
      );
    }

    const detailResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/conversations/${encodeURIComponent(conversationId)}`),
      },
      remainingOptions(),
    );
    accepted(detailResponse, "SPARK_X_AGENT_SELECTED_SKILL_CONVERSATION_FAILED");
    const detail = dataEnvelope(
      detailResponse.body,
      "SPARK_X_AGENT_SELECTED_SKILL_CONVERSATION_INVALID",
    );
    const conversation = objectValue(detail.conversation);
    const activatedAt = conversation?.active_skill_activated_at;
    if (
      conversation?.id !== conversationId ||
      conversation.active_skill_name !== trustedSkillName ||
      typeof activatedAt !== "string" ||
      !Number.isFinite(Date.parse(activatedAt)) ||
      detail.message_count !== 2
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_SELECTED_SKILL_STATE_FAILED",
        "会话未持久化唯一选中 Skill、有效激活时间或精确消息基数。",
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
    accepted(historyResponse, "SPARK_X_AGENT_SELECTED_SKILL_HISTORY_FAILED");
    const history = dataEnvelope(
      historyResponse.body,
      "SPARK_X_AGENT_SELECTED_SKILL_HISTORY_INVALID",
    );
    const items = Array.isArray(history.items)
      ? history.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const userMessages = items.filter((item) => item.role === "user");
    const assistantMessages = items.filter((item) => item.role === "assistant");
    const toolMessages = items.filter((item) => item.role === "tool");
    const historySkillEvents = assistantMessages.flatMap((item) =>
      Array.isArray(item.public_execution_trace)
        ? item.public_execution_trace
            .map(objectValue)
            .filter(
              (event): event is Readonly<Record<string, unknown>> =>
                event !== null && event.kind === "skill",
            )
        : [],
    );
    const historySkillEvent = historySkillEvents[0];
    if (
      items.length !== 2 ||
      userMessages.length !== 1 ||
      assistantMessages.length !== 1 ||
      toolMessages.length !== 0 ||
      userMessages[0]?.content !== message ||
      userMessages[0]?.payload_truncated === true ||
      assistantMessages[0]?.content !== finalContent ||
      assistantMessages[0]?.payload_truncated === true ||
      assistantMessages[0]?.finish_reason !== "stop" ||
      historySkillEvents.length !== 1 ||
      historySkillEvent?.name !== trustedSkillName ||
      historySkillEvent?.args !== ""
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_SELECTED_SKILL_HISTORY_ASSERTION_FAILED",
        "公开历史未保留唯一选中 Skill 事件、固定回复与精确两消息基数。",
      );
    }
    return {
      conversationId,
      skillId: skill.id,
      skillName: trustedSkillName,
      selected: true,
      publicationHashMatched: true,
      providerInjectionMatched: true,
      unselectedSkillBodyAbsent: true,
      activeSkillPersisted: true,
      skillActivatedAtPresent: true,
      skillEventCount: result.skillEventCount,
      historySkillEventCount: historySkillEvents.length,
      toolCallCount: result.toolCalls.length,
      toolResultCount: result.toolResults.length,
      reviewEventCount: result.reviewEventCount,
      messageCount: items.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      skillNameSha256: sha256(trustedSkillName),
      skillArgsSha256: sha256(""),
      promptSha256,
      finalContentSha256: sha256(finalContent),
    };
  }

  if (action === "adapter:spark-x-agent/skill.create-lifecycle-fixture") {
    const runId = variables["run.id"];
    const name = requiredString(params, "name", variables, 128);
    if (
      typeof runId !== "string" ||
      !uuidPattern.test(runId) ||
      name !== lifecycleSkillName(runId)
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_TRACEABILITY_REQUIRED",
        "Skill 生命周期夹具名称必须严格绑定当前 run_id。",
      );
    }
    const beforeOccurrences = await listAdminSkillOccurrences(
      environment,
      token,
      name,
      remainingOptions(),
    );
    if (beforeOccurrences !== 0) {
      throw environmentFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_NAME_CONFLICT",
        "当前 run_id 的 Skill 生命周期夹具已存在，需先清理残留。",
      );
    }
    const prompt = lifecycleSkillPrompt(runId);
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/admin/skills"),
        headers: { "Content-Type": "application/json" },
        body: {
          name,
          display_name: `Spark X Skill Lifecycle ${runId}`,
          description: "Spark X Test Platform reversible Skill lifecycle fixture",
          category: lifecycleSkillCategory,
          config: {
            prompt_template: prompt,
            source: lifecycleSkillSource,
            lifecycle_fixture: true,
          },
        },
      },
      remainingOptions(),
    );
    acceptedSkillRuntime(response, "SPARK_X_AGENT_SKILL_LIFECYCLE_CREATE_FAILED");
    const data = dataEnvelope(
      response.body,
      "SPARK_X_AGENT_SKILL_LIFECYCLE_CREATE_RESPONSE_INVALID",
    );
    let createdId: string | undefined;
    try {
      const created = lifecycleSkillProjection(
        data,
        runId,
        "SPARK_X_AGENT_SKILL_LIFECYCLE_CREATE_RESPONSE_INVALID",
      );
      createdId = created.id;
      if (!created.enabled) {
        throw apiFailure(
          "SPARK_X_AGENT_SKILL_LIFECYCLE_CREATE_RESPONSE_INVALID",
          "Skill 生命周期夹具创建后未启用。",
        );
      }
      const userCatalogOccurrences = await listUserSkillOccurrences(
        environment,
        token,
        name,
        remainingOptions(),
      );
      const detailResponse = await authenticatedRequest(
        environment,
        token,
        { method: "GET", path: actionPath(`/skills/${encodeURIComponent(name)}`) },
        remainingOptions(),
      );
      acceptedSkillRuntime(detailResponse, "SPARK_X_AGENT_SKILL_LIFECYCLE_USER_DETAIL_FAILED");
      const detail = lifecycleSkillProjection(
        successfulData(detailResponse.body, "SPARK_X_AGENT_SKILL_LIFECYCLE_USER_DETAIL_INVALID"),
        runId,
        "SPARK_X_AGENT_SKILL_LIFECYCLE_USER_DETAIL_INVALID",
      );
      if (userCatalogOccurrences !== 1 || detail.id !== created.id || !detail.enabled) {
        throw apiFailure(
          "SPARK_X_AGENT_SKILL_LIFECYCLE_USER_PROJECTION_FAILED",
          "Skill 生命周期夹具未形成唯一已启用用户投影。",
        );
      }
      return {
        skillFixtureResourceId: created.id,
        skillId: created.id,
        skillNameSha256: sha256(name),
        promptSha256: sha256(prompt),
        created: true,
        enabled: true,
        builtin: false,
        userCatalogOccurrences,
        userDetailMatched: true,
        assetRootAbsent: true,
        mainAssetAbsent: true,
      };
    } catch (firstError) {
      const possibleId =
        createdId ??
        (data.name === name && typeof data.id === "string" && uuidPattern.test(data.id)
          ? data.id
          : undefined);
      if (possibleId !== undefined) {
        try {
          await authenticatedRequest(
            environment,
            token,
            {
              method: "DELETE",
              path: actionPath(`/admin/skills/${encodeURIComponent(possibleId)}`),
            },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; the bounded fixture delete is best-effort here.
        }
      }
      throw firstError;
    }
  }

  if (action === "adapter:spark-x-agent/skill.assert-disabled-and-deleted") {
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_SKILL_RUN_ID_REQUIRED",
        "Skill 生命周期回归必须绑定有效 run_id。",
      );
    }
    const conversationId = requiredUuid(params, "conversationId", variables);
    const skillId = requiredUuid(params, "skillId", variables);
    const name = lifecycleSkillName(runId);
    const baselineResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}`) },
      remainingOptions(),
    );
    acceptedSkillRuntime(baselineResponse, "SPARK_X_AGENT_SKILL_LIFECYCLE_BASELINE_FAILED");
    const baseline = lifecycleSkillProjection(
      successfulData(baselineResponse.body, "SPARK_X_AGENT_SKILL_LIFECYCLE_BASELINE_INVALID"),
      runId,
      "SPARK_X_AGENT_SKILL_LIFECYCLE_BASELINE_INVALID",
    );
    if (baseline.id !== skillId || !baseline.enabled) {
      throw environmentFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_BASELINE_INVALID",
        "Skill 生命周期夹具不存在或已偏离启用基线。",
      );
    }

    const toggleResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "PATCH",
        path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}/toggle`),
      },
      remainingOptions(),
    );
    acceptedSkillRuntime(toggleResponse, "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLE_FAILED");
    const toggle = dataEnvelope(
      toggleResponse.body,
      "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLE_RESPONSE_INVALID",
    );
    if (toggle.id !== skillId || toggle.is_enabled !== false) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLE_RESPONSE_INVALID",
        "Skill 停用回执未关联已登记夹具或状态不正确。",
      );
    }

    const disabledAdminResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}`) },
      remainingOptions(),
    );
    acceptedSkillRuntime(
      disabledAdminResponse,
      "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLED_ADMIN_FAILED",
    );
    const disabledAdmin = lifecycleSkillProjection(
      successfulData(
        disabledAdminResponse.body,
        "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLED_ADMIN_INVALID",
      ),
      runId,
      "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLED_ADMIN_INVALID",
    );
    if (disabledAdmin.id !== skillId || disabledAdmin.enabled) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLED_ADMIN_INVALID",
        "Skill 管理投影未持久化停用状态。",
      );
    }
    const disabledUserCatalogOccurrences = await listUserSkillOccurrences(
      environment,
      token,
      name,
      remainingOptions(),
    );
    if (disabledUserCatalogOccurrences !== 0) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_DISABLED_CATALOG_FAILED",
        "已停用 Skill 仍出现在用户可用清单。",
      );
    }
    const disabledDetailResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/skills/${encodeURIComponent(name)}`) },
      remainingOptions(),
    );
    assertUserSkillDetailDenied(disabledDetailResponse, "disabled");
    const disabledSelectionResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/chat"),
        headers: { "Content-Type": "application/json" },
        body: {
          message: `SKILL004_DISABLED_PROBE:${runId}`,
          conversation_id: conversationId,
          skill_names: [name],
          active_skill_name: name,
        },
      },
      remainingOptions(),
    );
    const disabledErrorSha256 = skillDenialErrorSha256(disabledSelectionResponse, "disabled");
    await assertEmptySkillLifecycleConversation(
      environment,
      token,
      conversationId,
      remainingOptions(),
    );

    const deleteResponse = await authenticatedRequest(
      environment,
      token,
      { method: "DELETE", path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}`) },
      remainingOptions(),
    );
    acceptedSkillRuntime(deleteResponse, "SPARK_X_AGENT_SKILL_LIFECYCLE_DELETE_FAILED");
    const deleteBody = objectValue(deleteResponse.body);
    if (deleteBody?.success !== true || deleteBody.message !== "技能已删除") {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_DELETE_RESPONSE_INVALID",
        "Skill 删除回执缺少稳定成功证据。",
      );
    }
    const deletedAdminDetail = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}`) },
      remainingOptions(),
    );
    if (deletedAdminDetail.status !== 404) {
      if (deletedAdminDetail.status >= 500) {
        throw environmentFailure(
          "SPARK_X_AGENT_SKILL_LIFECYCLE_DEPENDENCY_UNAVAILABLE",
          `Skill 删除后管理详情返回 HTTP ${deletedAdminDetail.status}。`,
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_DELETE_RESIDUE",
        "Skill 删除后管理详情仍可读。",
        deletedAdminDetail.status,
      );
    }
    const deletedAdminCatalogOccurrences = await listAdminSkillOccurrences(
      environment,
      token,
      name,
      remainingOptions(),
    );
    const deletedUserCatalogOccurrences = await listUserSkillOccurrences(
      environment,
      token,
      name,
      remainingOptions(),
    );
    if (deletedAdminCatalogOccurrences !== 0 || deletedUserCatalogOccurrences !== 0) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_DELETE_RESIDUE",
        "Skill 删除后管理或用户清单仍有残留。",
      );
    }
    const deletedDetailResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/skills/${encodeURIComponent(name)}`) },
      remainingOptions(),
    );
    assertUserSkillDetailDenied(deletedDetailResponse, "deleted");
    const deletedSelectionResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/chat"),
        headers: { "Content-Type": "application/json" },
        body: {
          message: `SKILL004_DELETED_PROBE:${runId}`,
          conversation_id: conversationId,
          skill_names: [name],
          active_skill_name: name,
        },
      },
      remainingOptions(),
    );
    const deletedErrorSha256 = skillDenialErrorSha256(deletedSelectionResponse, "deleted");
    await assertEmptySkillLifecycleConversation(
      environment,
      token,
      conversationId,
      remainingOptions(),
    );
    return {
      conversationId,
      skillId,
      skillNameSha256: sha256(name),
      disabled: true,
      disabledAdminStateMatched: true,
      disabledUserCatalogOccurrences,
      disabledUserDetailDenied: true,
      disabledSelectionDenied: true,
      deleted: true,
      deletedAdminDetailAbsent: true,
      deletedAdminCatalogOccurrences,
      deletedUserCatalogOccurrences,
      deletedUserDetailDenied: true,
      deletedSelectionDenied: true,
      activeSkillAbsentBeforeDelete: true,
      activeSkillAbsentAfterDelete: true,
      messageCountBeforeDelete: 0,
      messageCountAfterDelete: 0,
      disabledErrorSha256,
      deletedErrorSha256,
    };
  }

  if (action === "adapter:spark-x-agent/skill.cleanup-lifecycle-fixture") {
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_SKILL_RUN_ID_REQUIRED",
        "Skill 夹具清理必须绑定有效 run_id。",
      );
    }
    const skillId = requiredUuid(params, "skillId", variables);
    const name = lifecycleSkillName(runId);
    const detailResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}`) },
      remainingOptions(),
    );
    let alreadyMissing = detailResponse.status === 404;
    if (!alreadyMissing) {
      acceptedSkillRuntime(detailResponse, "SPARK_X_AGENT_SKILL_LIFECYCLE_CLEANUP_READ_FAILED");
      const detail = lifecycleSkillProjection(
        successfulData(detailResponse.body, "SPARK_X_AGENT_SKILL_LIFECYCLE_CLEANUP_READ_INVALID"),
        runId,
        "SPARK_X_AGENT_SKILL_LIFECYCLE_CLEANUP_READ_INVALID",
      );
      if (detail.id !== skillId) {
        throw assertionFailure(
          "SPARK_X_AGENT_SKILL_LIFECYCLE_CLEANUP_OWNERSHIP_FAILED",
          "Skill 夹具清理目标与当前 run_id 资源不一致。",
        );
      }
      const deleteResponse = await authenticatedRequest(
        environment,
        token,
        { method: "DELETE", path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}`) },
        remainingOptions(),
      );
      if (deleteResponse.status === 404) {
        alreadyMissing = true;
      } else {
        acceptedSkillRuntime(deleteResponse, "SPARK_X_AGENT_SKILL_LIFECYCLE_CLEANUP_DELETE_FAILED");
      }
    }
    const verifyResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/skills/${encodeURIComponent(skillId)}`) },
      remainingOptions(),
    );
    if (verifyResponse.status !== 404) {
      if (verifyResponse.status >= 500) {
        throw environmentFailure(
          "SPARK_X_AGENT_SKILL_LIFECYCLE_DEPENDENCY_UNAVAILABLE",
          `Skill 夹具清理复核返回 HTTP ${verifyResponse.status}。`,
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_CLEANUP_RESIDUE",
        "Skill 夹具清理后管理详情仍可读。",
        verifyResponse.status,
      );
    }
    const adminCatalogOccurrences = await listAdminSkillOccurrences(
      environment,
      token,
      name,
      remainingOptions(),
    );
    if (adminCatalogOccurrences !== 0) {
      throw apiFailure(
        "SPARK_X_AGENT_SKILL_LIFECYCLE_CLEANUP_RESIDUE",
        "Skill 夹具清理后管理清单仍有同名残留。",
      );
    }
    return {
      skillId,
      skillNameSha256: sha256(name),
      deleted: true,
      alreadyMissing,
      adminDetailAbsent: true,
      adminCatalogOccurrences,
    };
  }

  if (action === "adapter:spark-x-agent/mcp.create-fixture") {
    const runId = variables["run.id"];
    const name = requiredString(params, "name", variables, 128);
    if (typeof runId !== "string" || !uuidPattern.test(runId) || name !== mcpFixtureName(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_MCP_TRACEABILITY_REQUIRED",
        "MCP 夹具名称必须严格绑定当前 run_id。",
      );
    }
    const beforeOccurrences = await listAdminMcpOccurrences(
      environment,
      token,
      name,
      remainingOptions(),
    );
    if (beforeOccurrences !== 0) {
      throw environmentFailure(
        "SPARK_X_AGENT_MCP_NAME_CONFLICT",
        "当前 run_id 的 MCP 夹具已经存在，需先清理残留。",
      );
    }
    const response = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/admin/mcp/servers"),
        headers: { "Content-Type": "application/json" },
        body: mcpFixtureInput(environment, runId, "v1", true),
      },
      remainingOptions(),
    );
    acceptedMcpRuntime(response, "SPARK_X_AGENT_MCP_CREATE_FAILED");
    const data = dataEnvelope(response.body, "SPARK_X_AGENT_MCP_CREATE_INVALID");
    let createdId: string | undefined;
    try {
      const created = mcpFixtureServerProjection(
        data,
        environment,
        runId,
        ["v1"],
        "SPARK_X_AGENT_MCP_CREATE_INVALID",
      );
      createdId = created.id;
      if (!created.enabled || created.status !== "stopped" || created.toolsCount !== 0) {
        throw apiFailure(
          "SPARK_X_AGENT_MCP_CREATE_BASELINE_MISMATCH",
          "MCP 夹具创建后未保持已启用、未启动和零工具运行时基线。",
        );
      }
      const adminCatalogOccurrences = await listAdminMcpOccurrences(
        environment,
        token,
        name,
        remainingOptions(),
      );
      if (adminCatalogOccurrences !== 1) {
        throw apiFailure(
          "SPARK_X_AGENT_MCP_CREATE_CATALOG_MISMATCH",
          "MCP 夹具创建后未形成唯一管理投影。",
        );
      }
      return {
        mcpFixtureResourceId: created.id,
        serverId: created.id,
        serverNameSha256: sha256(name),
        addressSha256: sha256(mcpFixtureAddress(environment, "v1")),
        created: true,
        enabled: true,
        builtin: false,
        stopped: true,
        fixedTargetAllowed: true,
        credentialProjectionMasked: true,
        adminCatalogOccurrences,
      };
    } catch (firstError) {
      const possibleId =
        createdId ??
        (data.name === name && typeof data.id === "string" && uuidPattern.test(data.id)
          ? data.id
          : undefined);
      if (possibleId !== undefined) {
        try {
          await authenticatedRequest(
            environment,
            token,
            { method: "DELETE", path: actionPath(`/admin/mcp/servers/${possibleId}`) },
            remainingOptions(),
          );
        } catch {
          // Preserve the first projection failure; bounded deletion is best-effort here.
        }
      }
      throw firstError;
    }
  }

  if (action === "adapter:spark-x-agent/mcp.assert-invocation") {
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure("SPARK_X_AGENT_MCP_RUN_ID_REQUIRED", "MCP 调用必须绑定有效 run_id。");
    }
    const serverId = requiredUuid(params, "serverId", variables);
    const baselineResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(baselineResponse, "SPARK_X_AGENT_MCP_BASELINE_FAILED");
    const baseline = mcpFixtureServerProjection(
      successfulData(baselineResponse.body, "SPARK_X_AGENT_MCP_BASELINE_INVALID"),
      environment,
      runId,
      ["v1"],
      "SPARK_X_AGENT_MCP_BASELINE_INVALID",
    );
    if (
      baseline.id !== serverId ||
      !baseline.enabled ||
      baseline.status !== "stopped" ||
      baseline.toolsCount !== 0
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_MCP_BASELINE_MISMATCH",
        "MCP 调用夹具不存在或已偏离未启动基线。",
      );
    }
    const startResponse = await authenticatedRequest(
      environment,
      token,
      { method: "POST", path: actionPath(`/admin/mcp/servers/${serverId}/start`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(startResponse, "SPARK_X_AGENT_MCP_START_FAILED");
    const runningResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(runningResponse, "SPARK_X_AGENT_MCP_RUNNING_READ_FAILED");
    const running = mcpFixtureServerProjection(
      successfulData(runningResponse.body, "SPARK_X_AGENT_MCP_RUNNING_INVALID"),
      environment,
      runId,
      ["v1"],
      "SPARK_X_AGENT_MCP_RUNNING_INVALID",
    );
    if (
      running.id !== serverId ||
      !running.enabled ||
      running.status !== "running" ||
      running.toolsCount !== 1 ||
      running.startedAt === null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_RUNNING_STATE_MISMATCH",
        "MCP 夹具启动后未形成唯一运行中工具投影。",
      );
    }
    const tool = await readMcpFixtureTool(environment, token, serverId, "v1", remainingOptions());
    const user = await listUserMcpOccurrences(
      environment,
      token,
      { name: running.name, serverId, status: "running", toolsCount: 1 },
      remainingOptions(),
    );
    if (user.occurrences !== 1) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_USER_PROJECTION_MISMATCH",
        "运行中的 MCP 夹具未形成唯一用户投影。",
      );
    }
    const invocation = await invokeMcpFixtureTool(
      environment,
      token,
      runId,
      tool.id,
      "v1",
      remainingOptions(),
    );
    return {
      serverId,
      toolId: tool.id,
      serverNameSha256: sha256(running.name),
      qualifiedNameSha256: sha256(`${running.name}__${mcpFixtureToolName}`),
      inputSchemaSha256: sha256(canonicalJson(tool.schema)),
      argumentsSha256: invocation.argumentsSha256,
      resultSha256: invocation.resultSha256,
      running: true,
      userProjectionMatched: true,
      credentialFieldsAbsent: user.privateFieldsAbsent,
      toolGovernanceMatched: true,
      invoked: true,
      recordCount: invocation.recordCount,
      revision: invocation.revision,
    };
  }

  if (action === "adapter:spark-x-agent/mcp.assert-reconnect") {
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure("SPARK_X_AGENT_MCP_RUN_ID_REQUIRED", "MCP 重连必须绑定有效 run_id。");
    }
    const serverId = requiredUuid(params, "serverId", variables);
    const baselineResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(baselineResponse, "SPARK_X_AGENT_MCP_BASELINE_FAILED");
    const baseline = mcpFixtureServerProjection(
      successfulData(baselineResponse.body, "SPARK_X_AGENT_MCP_BASELINE_INVALID"),
      environment,
      runId,
      ["v1"],
      "SPARK_X_AGENT_MCP_BASELINE_INVALID",
    );
    if (
      baseline.id !== serverId ||
      !baseline.enabled ||
      baseline.status !== "stopped" ||
      baseline.toolsCount !== 0
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_MCP_BASELINE_MISMATCH",
        "MCP 重连夹具不存在或已偏离未启动基线。",
      );
    }
    const startResponse = await authenticatedRequest(
      environment,
      token,
      { method: "POST", path: actionPath(`/admin/mcp/servers/${serverId}/start`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(startResponse, "SPARK_X_AGENT_MCP_START_FAILED");
    const v1DetailResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(v1DetailResponse, "SPARK_X_AGENT_MCP_RUNNING_READ_FAILED");
    const v1Detail = mcpFixtureServerProjection(
      successfulData(v1DetailResponse.body, "SPARK_X_AGENT_MCP_RUNNING_INVALID"),
      environment,
      runId,
      ["v1"],
      "SPARK_X_AGENT_MCP_RUNNING_INVALID",
    );
    if (
      v1Detail.id !== serverId ||
      v1Detail.status !== "running" ||
      v1Detail.toolsCount !== 1 ||
      v1Detail.startedAt === null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_RUNNING_STATE_MISMATCH",
        "MCP 重连夹具未进入 v1 运行基线。",
      );
    }
    const v1Tool = await readMcpFixtureTool(environment, token, serverId, "v1", remainingOptions());
    const v1Invocation = await invokeMcpFixtureTool(
      environment,
      token,
      runId,
      v1Tool.id,
      "v1",
      remainingOptions(),
    );
    const updateResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "PUT",
        path: actionPath(`/admin/mcp/servers/${serverId}`),
        headers: { "Content-Type": "application/json" },
        body: mcpFixtureInput(environment, runId, "v2", true),
      },
      remainingOptions(),
    );
    acceptedMcpRuntime(updateResponse, "SPARK_X_AGENT_MCP_UPDATE_FAILED");
    const updateEnvelope = objectValue(updateResponse.body);
    const updated = mcpFixtureServerProjection(
      successfulData(updateResponse.body, "SPARK_X_AGENT_MCP_UPDATE_INVALID"),
      environment,
      runId,
      ["v2"],
      "SPARK_X_AGENT_MCP_UPDATE_INVALID",
    );
    if (
      updateEnvelope?.needs_restart !== true ||
      updated.id !== serverId ||
      updated.status !== "running" ||
      updated.toolsCount !== 1
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_UPDATE_RESTART_MARKER_MISSING",
        "MCP 运行中配置修改未保留旧连接或未返回需重启标记。",
      );
    }
    const beforeRestart = await invokeMcpFixtureTool(
      environment,
      token,
      runId,
      v1Tool.id,
      "v1",
      remainingOptions(),
    );
    const restartResponse = await authenticatedRequest(
      environment,
      token,
      { method: "POST", path: actionPath(`/admin/mcp/servers/${serverId}/restart`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(restartResponse, "SPARK_X_AGENT_MCP_RESTART_FAILED");
    const v2DetailResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(v2DetailResponse, "SPARK_X_AGENT_MCP_RESTART_READ_FAILED");
    const v2Detail = mcpFixtureServerProjection(
      successfulData(v2DetailResponse.body, "SPARK_X_AGENT_MCP_RESTART_INVALID"),
      environment,
      runId,
      ["v2"],
      "SPARK_X_AGENT_MCP_RESTART_INVALID",
    );
    if (
      v2Detail.id !== serverId ||
      v2Detail.status !== "running" ||
      v2Detail.toolsCount !== 1 ||
      v2Detail.startedAt === null ||
      v2Detail.startedAt === v1Detail.startedAt
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_RESTART_STATE_MISMATCH",
        "MCP 重启后未切换到新连接或启动时间未推进。",
      );
    }
    const refreshResponse = await authenticatedRequest(
      environment,
      token,
      { method: "POST", path: actionPath(`/admin/mcp/servers/${serverId}/refresh`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(refreshResponse, "SPARK_X_AGENT_MCP_REFRESH_FAILED");
    const refreshData = dataEnvelope(refreshResponse.body, "SPARK_X_AGENT_MCP_REFRESH_INVALID");
    if (!Array.isArray(refreshData.items) || refreshData.items.length !== 1) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_REFRESH_CARDINALITY_MISMATCH",
        "MCP 重连后刷新未返回唯一工具。",
      );
    }
    const refreshedTool = mcpFixtureToolProjection(
      refreshData.items[0],
      serverId,
      "v2",
      "SPARK_X_AGENT_MCP_REFRESH_PROJECTION_MISMATCH",
    );
    const v2Tool = await readMcpFixtureTool(environment, token, serverId, "v2", remainingOptions());
    if (refreshedTool.id !== v1Tool.id || v2Tool.id !== v1Tool.id) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_TOOL_IDENTITY_DRIFT",
        "MCP 重连刷新后同名工具身份发生漂移。",
      );
    }
    const v2Invocation = await invokeMcpFixtureTool(
      environment,
      token,
      runId,
      v2Tool.id,
      "v2",
      remainingOptions(),
    );
    const v1SchemaSha256 = sha256(canonicalJson(v1Tool.schema));
    const v2SchemaSha256 = sha256(canonicalJson(v2Tool.schema));
    if (v1SchemaSha256 === v2SchemaSha256) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_DESCRIPTOR_NOT_REFRESHED",
        "MCP 重连后的工具描述符未刷新到 v2。",
      );
    }
    return {
      serverId,
      toolId: v1Tool.id,
      serverNameSha256: sha256(v2Detail.name),
      v1AddressSha256: sha256(mcpFixtureAddress(environment, "v1")),
      v2AddressSha256: sha256(mcpFixtureAddress(environment, "v2")),
      v1SchemaSha256,
      v2SchemaSha256,
      v1ResultSha256: v1Invocation.resultSha256,
      v2ResultSha256: v2Invocation.resultSha256,
      needsRestart: true,
      oldConnectionUsedBeforeRestart: beforeRestart.revision === 1,
      restarted: true,
      startedAtChanged: true,
      toolIdentityStable: true,
      descriptorChanged: true,
      cacheRefreshed: true,
    };
  }

  if (action === "adapter:spark-x-agent/mcp.assert-disconnect-disable-delete") {
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_MCP_RUN_ID_REQUIRED",
        "MCP 断线生命周期必须绑定有效 run_id。",
      );
    }
    const serverId = requiredUuid(params, "serverId", variables);
    const baselineResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(baselineResponse, "SPARK_X_AGENT_MCP_BASELINE_FAILED");
    const baseline = mcpFixtureServerProjection(
      successfulData(baselineResponse.body, "SPARK_X_AGENT_MCP_BASELINE_INVALID"),
      environment,
      runId,
      ["v1"],
      "SPARK_X_AGENT_MCP_BASELINE_INVALID",
    );
    if (
      baseline.id !== serverId ||
      !baseline.enabled ||
      baseline.status !== "stopped" ||
      baseline.toolsCount !== 0
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_MCP_BASELINE_MISMATCH",
        "MCP 断线夹具不存在或已偏离未启动基线。",
      );
    }
    const startResponse = await authenticatedRequest(
      environment,
      token,
      { method: "POST", path: actionPath(`/admin/mcp/servers/${serverId}/start`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(startResponse, "SPARK_X_AGENT_MCP_START_FAILED");
    const tool = await readMcpFixtureTool(environment, token, serverId, "v1", remainingOptions());
    const updateResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "PUT",
        path: actionPath(`/admin/mcp/servers/${serverId}`),
        headers: { "Content-Type": "application/json" },
        body: mcpFixtureInput(environment, runId, "fault", true),
      },
      remainingOptions(),
    );
    acceptedMcpRuntime(updateResponse, "SPARK_X_AGENT_MCP_FAULT_UPDATE_FAILED");
    const updateEnvelope = objectValue(updateResponse.body);
    const updated = mcpFixtureServerProjection(
      successfulData(updateResponse.body, "SPARK_X_AGENT_MCP_FAULT_UPDATE_INVALID"),
      environment,
      runId,
      ["fault"],
      "SPARK_X_AGENT_MCP_FAULT_UPDATE_INVALID",
    );
    if (
      updateEnvelope?.needs_restart !== true ||
      updated.id !== serverId ||
      updated.status !== "running"
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_FAULT_UPDATE_RESTART_MARKER_MISSING",
        "MCP 断线配置未在旧连接仍运行时要求重启。",
      );
    }
    const restartResponse = await authenticatedRequest(
      environment,
      token,
      { method: "POST", path: actionPath(`/admin/mcp/servers/${serverId}/restart`) },
      remainingOptions(),
    );
    const disconnectErrorSha256 = expectedMcpFailureSha256(
      restartResponse,
      "SPARK_X_AGENT_MCP_DISCONNECT_NOT_VISIBLE",
      "MCP 固定不可达目标重启没有返回可见失败。",
    );
    const errorResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(errorResponse, "SPARK_X_AGENT_MCP_ERROR_READ_FAILED");
    const errorState = mcpFixtureServerProjection(
      successfulData(errorResponse.body, "SPARK_X_AGENT_MCP_ERROR_STATE_INVALID"),
      environment,
      runId,
      ["fault"],
      "SPARK_X_AGENT_MCP_ERROR_STATE_INVALID",
    );
    if (
      errorState.id !== serverId ||
      errorState.status !== "error" ||
      errorState.toolsCount !== 0
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_ERROR_STATE_MISMATCH",
        "MCP 断线后未持久化 error 状态或仍保留运行时工具。",
      );
    }
    const disableResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "PUT",
        path: actionPath(`/admin/mcp/servers/${serverId}`),
        headers: { "Content-Type": "application/json" },
        body: mcpFixtureInput(environment, runId, "fault", false),
      },
      remainingOptions(),
    );
    acceptedMcpRuntime(disableResponse, "SPARK_X_AGENT_MCP_DISABLE_FAILED");
    const disabled = mcpFixtureServerProjection(
      successfulData(disableResponse.body, "SPARK_X_AGENT_MCP_DISABLE_INVALID"),
      environment,
      runId,
      ["fault"],
      "SPARK_X_AGENT_MCP_DISABLE_INVALID",
    );
    if (disabled.id !== serverId || disabled.enabled || disabled.status !== "stopped") {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_DISABLE_STATE_MISMATCH",
        "MCP 停用后未持久化 stopped 状态。",
      );
    }
    const disabledUser = await listUserMcpOccurrences(
      environment,
      token,
      { name: disabled.name },
      remainingOptions(),
    );
    if (disabledUser.occurrences !== 0) {
      throw apiFailure("SPARK_X_AGENT_MCP_DISABLED_STILL_VISIBLE", "MCP 停用后仍出现在用户目录。");
    }
    const disabledInvocation = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath("/admin/mcp/tools/invoke"),
        headers: { "Content-Type": "application/json" },
        body: {
          tool_id: tool.id,
          parameters: mcpFixtureArguments(runId, "v1"),
        },
      },
      remainingOptions(),
    );
    const disabledInvocationErrorSha256 = expectedMcpFailureSha256(
      disabledInvocation,
      "SPARK_X_AGENT_MCP_DISABLED_INVOCATION_NOT_DENIED",
      "MCP 停用后诊断调用未被阻断。",
    );
    const deleteResponse = await authenticatedRequest(
      environment,
      token,
      { method: "DELETE", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    acceptedMcpRuntime(deleteResponse, "SPARK_X_AGENT_MCP_DELETE_FAILED");
    const deleteBody = objectValue(deleteResponse.body);
    if (deleteBody?.success !== true || deleteBody.message !== "服务已删除") {
      throw apiFailure(
        "SPARK_X_AGENT_MCP_DELETE_RESPONSE_INVALID",
        "MCP 删除回执缺少稳定成功证据。",
      );
    }
    const deletedDetail = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    if (deletedDetail.status !== 404) {
      if (deletedDetail.status >= 500) {
        throw environmentFailure(
          "SPARK_X_AGENT_MCP_DEPENDENCY_UNAVAILABLE",
          `MCP 删除后管理详情返回 HTTP ${deletedDetail.status}。`,
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_MCP_DELETE_RESIDUE",
        "MCP 删除后管理详情仍可读。",
        deletedDetail.status,
      );
    }
    const deletedAdminCatalogOccurrences = await listAdminMcpOccurrences(
      environment,
      token,
      disabled.name,
      remainingOptions(),
    );
    const deletedUser = await listUserMcpOccurrences(
      environment,
      token,
      { name: disabled.name },
      remainingOptions(),
    );
    if (deletedAdminCatalogOccurrences !== 0 || deletedUser.occurrences !== 0) {
      throw apiFailure("SPARK_X_AGENT_MCP_DELETE_RESIDUE", "MCP 删除后管理或用户目录仍有残留。");
    }
    return {
      serverId,
      toolId: tool.id,
      serverNameSha256: sha256(disabled.name),
      disconnectErrorSha256,
      disabledInvocationErrorSha256,
      disconnectFailureVisible: true,
      errorStateMatched: true,
      runtimeToolsUnavailable: true,
      disabled: true,
      disabledUserCatalogOccurrences: disabledUser.occurrences,
      disabledInvocationDenied: true,
      deleted: true,
      deletedAdminDetailAbsent: true,
      deletedAdminCatalogOccurrences,
      deletedUserCatalogOccurrences: deletedUser.occurrences,
    };
  }

  if (action === "adapter:spark-x-agent/mcp.cleanup-fixture") {
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_MCP_RUN_ID_REQUIRED",
        "MCP 夹具清理必须绑定有效 run_id。",
      );
    }
    const serverId = requiredUuid(params, "serverId", variables);
    const name = mcpFixtureName(runId);
    const detailResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    let alreadyMissing = detailResponse.status === 404;
    if (!alreadyMissing) {
      acceptedMcpRuntime(detailResponse, "SPARK_X_AGENT_MCP_CLEANUP_READ_FAILED");
      const detail = mcpFixtureServerProjection(
        successfulData(detailResponse.body, "SPARK_X_AGENT_MCP_CLEANUP_READ_INVALID"),
        environment,
        runId,
        ["v1", "v2", "fault"],
        "SPARK_X_AGENT_MCP_CLEANUP_READ_INVALID",
      );
      if (detail.id !== serverId) {
        throw assertionFailure(
          "SPARK_X_AGENT_MCP_CLEANUP_OWNERSHIP_FAILED",
          "MCP 夹具清理目标与当前 run_id 资源不一致。",
        );
      }
      const stopResponse = await authenticatedRequest(
        environment,
        token,
        { method: "POST", path: actionPath(`/admin/mcp/servers/${serverId}/stop`) },
        remainingOptions(),
      );
      acceptedMcpRuntime(stopResponse, "SPARK_X_AGENT_MCP_CLEANUP_STOP_FAILED");
      const deleteResponse = await authenticatedRequest(
        environment,
        token,
        { method: "DELETE", path: actionPath(`/admin/mcp/servers/${serverId}`) },
        remainingOptions(),
      );
      if (deleteResponse.status === 404) {
        alreadyMissing = true;
      } else {
        acceptedMcpRuntime(deleteResponse, "SPARK_X_AGENT_MCP_CLEANUP_DELETE_FAILED");
      }
    }
    const verifyResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: actionPath(`/admin/mcp/servers/${serverId}`) },
      remainingOptions(),
    );
    if (verifyResponse.status !== 404) {
      if (verifyResponse.status >= 500) {
        throw environmentFailure(
          "SPARK_X_AGENT_MCP_DEPENDENCY_UNAVAILABLE",
          `MCP 清理复核返回 HTTP ${verifyResponse.status}。`,
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_MCP_CLEANUP_RESIDUE",
        "MCP 清理后管理详情仍可读。",
        verifyResponse.status,
      );
    }
    const adminCatalogOccurrences = await listAdminMcpOccurrences(
      environment,
      token,
      name,
      remainingOptions(),
    );
    if (adminCatalogOccurrences !== 0) {
      throw apiFailure("SPARK_X_AGENT_MCP_CLEANUP_RESIDUE", "MCP 清理后管理目录仍有同名残留。");
    }
    return {
      serverId,
      serverNameSha256: sha256(name),
      stopped: true,
      deleted: true,
      alreadyMissing,
      adminDetailAbsent: true,
      adminCatalogOccurrences,
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
    const fixtureKind = params.fixtureKind ?? "order";
    if (
      fixtureKind !== "order" &&
      fixtureKind !== "account-chart" &&
      fixtureKind !== "large-table"
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "知识库测试夹具类型必须是 order、account-chart 或 large-table。",
      );
    }
    const fixture = buildKnowledgeFixture(knowledgeBaseId, fixtureKind);
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
      fixtureKind: fixture.kind,
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

  if (action === "adapter:spark-x-agent/knowledge-base.assert-large-table-continuation") {
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    const knowledgeDocumentId = requiredUuid(params, "knowledgeDocumentId", variables);
    const expectedFixtureSha256 = requiredSha256(params, "expectedFixtureSha256", variables);
    const documentResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: domainActionPath(
          `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(knowledgeDocumentId)}`,
        ),
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(
      documentResponse,
      "SPARK_X_AGENT_KNOWLEDGE_TABLE_DOCUMENT_READ_FAILED",
    );
    const document = dataEnvelope(
      documentResponse.body,
      "SPARK_X_AGENT_KNOWLEDGE_TABLE_DOCUMENT_RESPONSE_INVALID",
    );
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
    acceptedKnowledgeRuntime(versionsResponse, "SPARK_X_AGENT_KNOWLEDGE_TABLE_VERSION_READ_FAILED");
    const versionsData = dataEnvelope(
      versionsResponse.body,
      "SPARK_X_AGENT_KNOWLEDGE_TABLE_VERSION_RESPONSE_INVALID",
    );
    const versions = Array.isArray(versionsData.items)
      ? versionsData.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const version = versions[0];
    if (
      document.id !== knowledgeDocumentId ||
      document.knowledge_base_id !== knowledgeBaseId ||
      document.status !== "completed" ||
      document.current_version_number !== 1 ||
      !boundedParserIdentifier(document.parser_document_id) ||
      !boundedParserIdentifier(document.current_version_id) ||
      versions.length !== 1 ||
      version?.knowledge_document_id !== knowledgeDocumentId ||
      version.version_number !== 1 ||
      version.status !== "completed" ||
      version.content_hash !== expectedFixtureSha256 ||
      version.parser_version_id !== document.current_version_id
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_TABLE_BINDING_FAILED",
        "固定大表的领域文档、内容哈希与精确解析版本绑定不一致。",
      );
    }
    const binding = {
      parserDocumentId: document.parser_document_id,
      parserVersionId: document.current_version_id,
    } satisfies LargeTableParserBinding;
    const cursorHashes: string[] = [];
    const seenCursorHashes = new Set<string>();
    const tableUnitIds = new Set<string>();
    let cursor: string | null = null;
    let expectedSegmentStart = 0;
    let reconstructed = "";
    let pageCount = 0;
    let sourceComplete = false;
    for (let pageNumber = 1; pageNumber <= 64; pageNumber += 1) {
      const page = await requestLargeTableContinuationPage(
        environment,
        binding,
        cursor,
        pageNumber,
        remainingOptions(),
      );
      pageCount = pageNumber;
      if (page.totalUnits !== 1 || page.items.length !== 1) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_TABLE_UNIT_BOUNDARY_FAILED",
          "固定大表没有被解析为唯一、可连续读取的表格单元。",
        );
      }
      const item = page.items[0];
      const segment = objectValue(item?.text_segment);
      if (
        item?.kind !== "table" ||
        item.document_id !== binding.parserDocumentId ||
        item.version_id !== binding.parserVersionId
      ) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_TABLE_DOCUMENT_BOUNDARY_FAILED",
          "固定大表续查跳转到了非预期的文档、版本或内容类型。",
        );
      }
      if (
        typeof item.unit_id !== "string" ||
        item.unit_id.length === 0 ||
        item.unit_id.length > 1_000 ||
        typeof item.text !== "string" ||
        item.text.length === 0 ||
        item.text.length > 1_000 ||
        segment === null ||
        !Number.isInteger(segment.start) ||
        !Number.isInteger(segment.end) ||
        typeof segment.unit_complete !== "boolean" ||
        segment.start !== expectedSegmentStart ||
        segment.end !== expectedSegmentStart + item.text.length
      ) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_TABLE_SEGMENT_DISCONTINUITY",
          "固定大表分段发生跳段、重叠、越界或文档版本漂移。",
        );
      }
      tableUnitIds.add(item.unit_id);
      expectedSegmentStart = segment.end;
      reconstructed += item.text;
      if (
        page.usedChars !== item.text.length ||
        page.deliveredChars !== reconstructed.length ||
        page.completedUnits !== (segment.unit_complete ? 1 : 0) ||
        page.sourceComplete !== !page.hasMore ||
        page.sourceComplete !== (page.nextCursor === null) ||
        segment.unit_complete !== page.sourceComplete
      ) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_TABLE_COVERAGE_DRIFT",
          "固定大表的累计字符、完成单元或续查终态发生漂移。",
        );
      }
      if (page.sourceComplete) {
        sourceComplete = true;
        break;
      }
      if (page.nextCursor === null) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_TABLE_CURSOR_MISSING",
          "固定大表尚未完整遍历，但解析服务没有返回续查游标。",
        );
      }
      const cursorHash = sha256(page.nextCursor);
      if (seenCursorHashes.has(cursorHash)) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_TABLE_CURSOR_REPEATED",
          "固定大表续查游标重复，无法证明遍历向前推进。",
        );
      }
      seenCursorHashes.add(cursorHash);
      cursorHashes.push(cursorHash);
      cursor = page.nextCursor;
    }
    if (
      !sourceComplete ||
      pageCount < 2 ||
      cursorHashes.length !== pageCount - 1 ||
      tableUnitIds.size !== 1
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_TABLE_CONTINUATION_INCOMPLETE",
        "固定大表未在有界页数内通过唯一游标链完整遍历。",
      );
    }
    const headerMarkers = ["ROW_ID", "RUN_RESOURCE_ID", "ACCOUNT_CODE", "AMOUNT_CNY"];
    const firstRowMarker = "KB006-ROW-001";
    const headerDetected = headerMarkers.every((marker) => {
      const first = reconstructed.indexOf(marker);
      return first >= 0 && first < reconstructed.indexOf(firstRowMarker);
    });
    const recoveredMarkers = [...reconstructed.matchAll(/KB006-ROW-\d{3}/gu)].map(
      (match) => match[0],
    );
    const expectedMarkers = Array.from(
      { length: largeTableFixtureRowCount },
      (_, index) => `KB006-ROW-${String(index + 1).padStart(3, "0")}`,
    );
    const fixtureMarkerCount = reconstructed.split(knowledgeBaseId).length - 1;
    if (
      !headerDetected ||
      recoveredMarkers.length !== largeTableFixtureRowCount ||
      new Set(recoveredMarkers).size !== largeTableFixtureRowCount ||
      expectedMarkers.some((marker, index) => recoveredMarkers[index] !== marker) ||
      fixtureMarkerCount !== largeTableFixtureRowCount
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_TABLE_CONTENT_FAILED",
        "固定大表的表头、顺序行标识或运行资源标识发生遗漏、重复或错序。",
      );
    }
    return {
      knowledgeBaseId,
      knowledgeDocumentId,
      fixtureSha256: expectedFixtureSha256,
      parserDocumentIdSha256: sha256(binding.parserDocumentId),
      parserVersionIdSha256: sha256(binding.parserVersionId),
      pageCount,
      cursorCount: cursorHashes.length,
      tableUnitCount: tableUnitIds.size,
      expectedRowCount: largeTableFixtureRowCount,
      recoveredRowCount: recoveredMarkers.length,
      headerDetected: true,
      segmentsContiguous: true,
      cursorChainUnique: true,
      sourceComplete: true,
      documentBindingMatched: true,
      versionBindingMatched: true,
      fixtureMarkerMatched: true,
      cursorChainSha256: sha256(cursorHashes.join(":")),
      reconstructedTableSha256: sha256(reconstructed),
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

  if (action === "adapter:spark-x-agent/knowledge-base.query-and-assert-evidence") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const requestId = requiredUuid(params, "requestId", variables);
    const snapshotId = requiredUuid(params, "snapshotId", variables);
    const snapshotHash = requiredSha256(params, "snapshotHash", variables);
    const knowledgeDocumentId = requiredUuid(params, "knowledgeDocumentId", variables);
    const forbiddenKnowledgeDocumentId = requiredUuid(
      params,
      "forbiddenKnowledgeDocumentId",
      variables,
    );
    const expectedFixtureSha256 = requiredSha256(params, "expectedFixtureSha256", variables);
    const expectedTitle = requiredString(params, "expectedTitle", variables, 512);
    const expectedResourceMarker =
      params.expectedResourceMarker === undefined
        ? undefined
        : requiredUuid(params, "expectedResourceMarker", variables);
    const forbiddenResourceMarker =
      params.forbiddenResourceMarker === undefined
        ? undefined
        : requiredUuid(params, "forbiddenResourceMarker", variables);
    const resourceMarkerChecked = expectedResourceMarker !== undefined;
    const message = requiredString(params, "message", variables, 20_000);
    if (
      knowledgeDocumentId === forbiddenKnowledgeDocumentId ||
      (expectedResourceMarker === undefined) !== (forbiddenResourceMarker === undefined) ||
      (expectedResourceMarker !== undefined &&
        expectedResourceMarker === forbiddenResourceMarker) ||
      message.includes("\u0000") ||
      expectedTitle.includes("\u0000")
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "知识检索回归必须使用不同的允许/禁止文档和成对的不同资源标识，且受控文本不能包含空字符。",
      );
    }

    const turn = await enqueueSparkXTurn(
      environment,
      token,
      conversationId,
      requestId,
      message,
      remainingOptions,
      {
        documentContext: {
          provider: "caishui_knowledge",
          snapshotId,
          snapshotHash,
        },
        toolMode: "auto",
      },
    );
    const terminal = await waitForSparkXTurnTerminal(
      environment,
      token,
      conversationId,
      turn.turnId,
      600,
      remainingOptions,
    );
    if (
      terminal.snapshot.status !== "completed" ||
      terminal.snapshot.assistantMessageId === null ||
      terminal.snapshot.finishReason !== "stop" ||
      terminal.snapshot.failureCode !== null ||
      terminal.snapshot.failureRetryable !== null
    ) {
      if (terminal.snapshot.failureRetryable === true) {
        throw environmentFailure(
          "SPARK_X_AGENT_KNOWLEDGE_QUERY_ENVIRONMENT_FAILED",
          "知识检索 Turn 因可重试运行时、检索服务或 Provider 原因失败。",
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_QUERY_TURN_FAILED",
        "知识检索 Turn 未以带可信回答的 stop 终态完成。",
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
    accepted(historyResponse, "SPARK_X_AGENT_KNOWLEDGE_QUERY_HISTORY_FAILED");
    const history = dataEnvelope(
      historyResponse.body,
      "SPARK_X_AGENT_KNOWLEDGE_QUERY_HISTORY_RESPONSE_INVALID",
    );
    const items = Array.isArray(history.items)
      ? history.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    if (items.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_QUERY_HISTORY_TRUNCATED",
        "知识检索历史包含已截断的公开消息。",
      );
    }
    const userMessages = items.filter((item) => item.role === "user");
    const assistantMessages = items.filter((item) => item.role === "assistant");
    const toolMessages = items.filter((item) => item.role === "tool");
    const userMessage = userMessages[0];
    const assistantMessage = assistantMessages[0];
    const answer = typeof assistantMessage?.content === "string" ? assistantMessage.content : "";
    const receipt = objectValue(assistantMessage?.document_context);
    const citedRefs = Array.isArray(receipt?.cited_refs) ? receipt.cited_refs : [];
    if (
      items.length !== 2 ||
      userMessages.length !== 1 ||
      assistantMessages.length !== 1 ||
      toolMessages.length !== 0 ||
      userMessage?.turn_id !== turn.turnId ||
      userMessage.content !== message ||
      userMessage.turn_status !== "completed" ||
      assistantMessage?.id !== terminal.snapshot.assistantMessageId ||
      assistantMessage.turn_id !== turn.turnId ||
      assistantMessage.turn_status !== "completed" ||
      assistantMessage.finish_reason !== "stop" ||
      answer === "" ||
      receipt === null ||
      receipt.provider !== "caishui_knowledge" ||
      receipt.snapshot_id !== snapshotId ||
      receipt.snapshot_hash !== snapshotHash ||
      typeof receipt.retrieval_id !== "string" ||
      !uuidPattern.test(receipt.retrieval_id) ||
      typeof receipt.packet_hash !== "string" ||
      !sha256Pattern.test(receipt.packet_hash) ||
      !Number.isSafeInteger(receipt.evidence_count) ||
      Number(receipt.evidence_count) < 1 ||
      Number(receipt.evidence_count) > 20 ||
      citedRefs.length < 1 ||
      citedRefs.length > Number(receipt.evidence_count) ||
      citedRefs.some(
        (reference) => typeof reference !== "string" || !/^K[1-9][0-9]{0,3}$/u.test(reference),
      ) ||
      new Set(citedRefs).size !== citedRefs.length
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_QUERY_HISTORY_ASSERTION_FAILED",
        "知识检索回答、Turn 关联或不可变知识回执不完整。",
      );
    }
    const expectedFacts = [
      "B2C-KB-001",
      "SPARK-REGRESSION",
      "4200",
      "PAID",
      ...(expectedResourceMarker === undefined ? [] : [expectedResourceMarker]),
    ];
    const forbiddenFacts = [
      "9900",
      "1122",
      "ACCOUNTS_RECEIVABLE",
      ...(forbiddenResourceMarker === undefined ? [] : [forbiddenResourceMarker]),
    ];
    if (
      expectedFacts.some((fact) => !answer.includes(fact)) ||
      forbiddenFacts.some((fact) => answer.includes(fact))
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_QUERY_ANSWER_FAILED",
        "知识检索回答缺少订单事实或混入了禁止的科目表事实。",
      );
    }

    const evidenceResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: domainActionPath(`/turns/${encodeURIComponent(turn.turnId)}/knowledge-evidence`),
      },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(evidenceResponse, "SPARK_X_AGENT_KNOWLEDGE_QUERY_EVIDENCE_FAILED");
    const evidenceData = dataEnvelope(
      evidenceResponse.body,
      "SPARK_X_AGENT_KNOWLEDGE_QUERY_EVIDENCE_RESPONSE_INVALID",
    );
    const evidenceItems = Array.isArray(evidenceData.evidence)
      ? evidenceData.evidence
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const retrievalModes = new Set(["keyword", "semantic", "hybrid"]);
    const evidenceRefs = evidenceItems.map((item) => item.ref);
    if (
      evidenceData.turn_id !== turn.turnId ||
      evidenceData.retrieval_id !== receipt.retrieval_id ||
      evidenceData.snapshot_id !== snapshotId ||
      evidenceData.snapshot_hash !== snapshotHash ||
      evidenceData.retrieval_policy !== "required" ||
      typeof evidenceData.mode !== "string" ||
      !retrievalModes.has(evidenceData.mode) ||
      evidenceData.truncated !== false ||
      !Array.isArray(evidenceData.warnings) ||
      evidenceData.warnings.length > 32 ||
      evidenceData.warnings.some(
        (warning) => typeof warning !== "string" || warning.length > 1_024,
      ) ||
      evidenceItems.length < 1 ||
      evidenceItems.length > 20 ||
      evidenceItems.length !== Number(receipt.evidence_count) ||
      citedRefs.length !== evidenceItems.length ||
      citedRefs.some((reference) => !evidenceRefs.includes(reference)) ||
      evidenceRefs.some((reference) => !citedRefs.includes(reference))
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_QUERY_EVIDENCE_RESPONSE_INVALID",
        "知识检索证据包与回答回执、快照或引用集合不一致。",
      );
    }
    for (const [index, item] of evidenceItems.entries()) {
      if (
        item.ref !== `K${index + 1}` ||
        item.document_id !== knowledgeDocumentId ||
        item.document_id === forbiddenKnowledgeDocumentId ||
        typeof item.version_id !== "string" ||
        !uuidPattern.test(item.version_id) ||
        typeof item.version_number !== "number" ||
        !Number.isSafeInteger(item.version_number) ||
        item.version_number < 1 ||
        item.content_hash !== expectedFixtureSha256 ||
        item.title !== expectedTitle ||
        objectValue(item.locator) === null ||
        typeof item.snippet !== "string" ||
        item.snippet.trim() === "" ||
        item.snippet.length > 32_000 ||
        typeof item.evidence_type !== "string" ||
        item.evidence_type.trim() === "" ||
        typeof item.retrieval_mode !== "string" ||
        !retrievalModes.has(item.retrieval_mode) ||
        item.truncated !== false ||
        !(item.score === null || (typeof item.score === "number" && Number.isFinite(item.score)))
      ) {
        throw assertionFailure(
          "SPARK_X_AGENT_KNOWLEDGE_QUERY_DOCUMENT_BOUNDARY_FAILED",
          "知识检索证据包含错误文档、版本、哈希、标题或越界字段。",
        );
      }
    }
    const evidenceText = evidenceItems.map((item) => String(item.snippet)).join("\n");
    if (
      expectedFacts.some((fact) => !evidenceText.includes(fact)) ||
      forbiddenFacts.some((fact) => evidenceText.includes(fact))
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_QUERY_EVIDENCE_FACTS_FAILED",
        "知识检索证据缺少订单事实或混入了禁止的科目表事实。",
      );
    }
    const evidenceSetSha256 = sha256(
      canonicalJson(
        evidenceItems.map((item) => ({
          ref: item.ref,
          documentId: item.document_id,
          versionId: item.version_id,
          versionNumber: item.version_number,
          contentHash: item.content_hash,
          titleSha256: sha256(String(item.title)),
          locatorSha256: sha256(canonicalJson(item.locator)),
          snippetSha256: sha256(String(item.snippet)),
          retrievalMode: item.retrieval_mode,
          truncated: item.truncated,
        })),
      ),
    );
    return {
      conversationId,
      turnId: turn.turnId,
      knowledgeDocumentId,
      snapshotId,
      snapshotHash,
      retrievalId: receipt.retrieval_id,
      packetHash: receipt.packet_hash,
      completed: true,
      expectedFactsMatched: true,
      resourceMarkerChecked,
      resourceMarkerMatched: true,
      citationSetMatched: true,
      forbiddenEvidenceAbsent: true,
      messageCount: items.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolMessageCount: toolMessages.length,
      evidenceCount: evidenceItems.length,
      citedRefCount: citedRefs.length,
      retrievalMode: evidenceData.mode,
      answerLength: answer.length,
      answerSha256: sha256(answer),
      evidenceSetSha256,
      pollAttempts: terminal.pollAttempts,
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.assert-cleaned-state") {
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    const knowledgeDocumentId = requiredUuid(params, "knowledgeDocumentId", variables);
    const uploadedDocumentId = requiredUuid(params, "uploadedDocumentId", variables);
    if (new Set([knowledgeBaseId, knowledgeDocumentId, uploadedDocumentId]).size !== 3) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "知识库清理验证必须引用三个不同的已登记资源标识。",
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
    requireKnowledgeStatus(
      baseResponse,
      [404],
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_BASE_CHECK_FAILED",
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_BASE_REMAINS",
      "已清理知识库仍可从活动详情接口访问。",
    );

    const listResponse = await authenticatedRequest(
      environment,
      token,
      { method: "GET", path: domainActionPath("/knowledge-bases") },
      remainingOptions(),
    );
    acceptedKnowledgeRuntime(listResponse, "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_BASE_LIST_FAILED");
    const listData = dataEnvelope(
      listResponse.body,
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_BASE_LIST_INVALID",
    );
    const activeBases = Array.isArray(listData.items)
      ? listData.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : null;
    if (
      activeBases === null ||
      activeBases.length !== (Array.isArray(listData.items) ? listData.items.length : -1) ||
      activeBases.some(
        (item) =>
          typeof item.id !== "string" || !uuidPattern.test(item.id) || item.status !== "active",
      )
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_BASE_LIST_INVALID",
        "活动知识库清单不是完整结构化数组。",
      );
    }
    if (activeBases.some((item) => item.id === knowledgeBaseId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_BASE_LIST_REMAINS",
        "已清理知识库仍残留在活动知识库清单。",
      );
    }

    const documentResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: domainActionPath(
          `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(knowledgeDocumentId)}`,
        ),
      },
      remainingOptions(),
    );
    requireKnowledgeStatus(
      documentResponse,
      [404],
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_DOCUMENT_CHECK_FAILED",
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_DOCUMENT_REMAINS",
      "已清理知识文档仍可从领域详情接口访问。",
    );

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
    requireKnowledgeStatus(
      versionsResponse,
      [404],
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_VERSION_CHECK_FAILED",
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_VERSION_REMAINS",
      "已清理知识文档的版本接口仍可访问。",
    );

    const searchResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: domainActionPath("/knowledge/search"),
        headers: { "Content-Type": "application/json" },
        body: {
          query: "B2C-KB-001",
          knowledge_base_ids: [knowledgeBaseId],
          mode: "hybrid",
          top_k_documents: 1,
          evidence_per_document: 1,
        },
      },
      remainingOptions(),
    );
    requireKnowledgeStatus(
      searchResponse,
      [403],
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_SEARCH_CHECK_FAILED",
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_SEARCH_REMAINS",
      "已清理知识库仍被检索接口接受为活动范围。",
    );

    const uploadStatusResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/documents/upload-status/${encodeURIComponent(knowledgeBaseId)}`),
      },
      remainingOptions(),
    );
    requireKnowledgeStatus(
      uploadStatusResponse,
      [404, 410],
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_UPLOAD_STATUS_CHECK_FAILED",
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_UPLOAD_STATUS_REMAINS",
      "已清理原始上传仍保留可用上传状态。",
    );

    const rawDocumentResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/documents/${encodeURIComponent(uploadedDocumentId)}`),
      },
      remainingOptions(),
    );
    requireKnowledgeStatus(
      rawDocumentResponse,
      [404],
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_RAW_DOCUMENT_CHECK_FAILED",
      "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_RAW_DOCUMENT_REMAINS",
      "已清理原始上传仍可从文档详情接口访问。",
    );

    return {
      knowledgeBaseId,
      knowledgeDocumentId,
      uploadedDocumentId,
      baseDetailAbsent: true,
      activeListAbsent: true,
      domainDocumentAbsent: true,
      domainVersionsAbsent: true,
      retrievalRejected: true,
      uploadStatusAbsent: true,
      rawDocumentAbsent: true,
      cleanupClosureMatched: true,
    };
  }

  if (action === "adapter:spark-x-agent/knowledge-base.cleanup") {
    const knowledgeBaseId = requiredUuid(params, "knowledgeBaseId", variables);
    let knowledgeDocumentDeleteCount = 0;
    let knowledgeDocumentAlreadyAbsentCount = 0;
    let parserDeleteReceiptCount = 0;
    let parserDeletedCount = 0;
    let parserAlreadyAbsentCount = 0;
    let parserVersionDeleteCount = 0;
    let parserJobDeleteCount = 0;
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
        if (deleted.status === 404) {
          knowledgeDocumentAlreadyAbsentCount += 1;
        } else {
          acceptedKnowledgeRuntime(deleted, "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_DELETE_FAILED");
          const receipt = objectValue(
            successfulData(
              deleted.body,
              "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_DELETE_RESPONSE_INVALID",
            ),
          );
          const parser = objectValue(receipt?.parser);
          const parserDeleted = parser?.deleted === true;
          const parserAlreadyAbsent = parser?.already_absent === true;
          if (
            receipt === null ||
            receipt.document_id !== item.id ||
            receipt.status !== "deleted" ||
            receipt.deleted !== true ||
            parser === null ||
            typeof parser.document_id !== "string" ||
            parser.document_id.length < 1 ||
            !["deleted", "not_found"].includes(String(parser.status)) ||
            parserDeleted === parserAlreadyAbsent ||
            !Number.isInteger(parser.version_count) ||
            Number(parser.version_count) < 0 ||
            !Number.isInteger(parser.job_count) ||
            Number(parser.job_count) < 0
          ) {
            throw apiFailure(
              "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_DELETE_RESPONSE_INVALID",
              "知识文档删除回执未证明解析索引与任务完成清理。",
            );
          }
          parserDeleteReceiptCount += 1;
          parserDeletedCount += parserDeleted ? 1 : 0;
          parserAlreadyAbsentCount += parserAlreadyAbsent ? 1 : 0;
          parserVersionDeleteCount += Number(parser.version_count);
          parserJobDeleteCount += Number(parser.job_count);
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
        const archivedBase = dataEnvelope(
          archived.body,
          "SPARK_X_AGENT_KNOWLEDGE_BASE_ARCHIVE_RESPONSE_INVALID",
        );
        if (archivedBase.id !== knowledgeBaseId || archivedBase.status !== "archived") {
          throw apiFailure(
            "SPARK_X_AGENT_KNOWLEDGE_BASE_ARCHIVE_RESPONSE_INVALID",
            "知识库归档回执未证明目标资源进入归档状态。",
          );
        }
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
      knowledgeDocumentAlreadyAbsentCount,
      parserDeleteReceiptCount,
      parserDeletedCount,
      parserAlreadyAbsentCount,
      parserVersionDeleteCount,
      parserJobDeleteCount,
      parserCleanupConfirmed:
        parserDeleteReceiptCount + knowledgeDocumentAlreadyAbsentCount ===
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
      writeToolsAbsent: true,
      reviewRequiredToolsAbsent: true,
      unsafeRiskToolsAbsent: true,
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

  if (action === "adapter:spark-x-agent/tool.invoke-failure-recovery") {
    const conversationId = requiredString(params, "conversationId", variables, 100);
    const message = requiredString(params, "message", variables, 20_000);
    const expectedText = requiredString(params, "expectedText", variables, 5_000);
    const failureArguments = expectedJsonObject(params, "failureArgumentsJson", variables);
    const failureResult = expectedJsonObject(params, "failureResultJson", variables);
    const recoveryArguments = expectedJsonObject(params, "recoveryArgumentsJson", variables);
    const recoveryResult = expectedJsonObject(params, "recoveryResultJson", variables);
    if (message.includes("\u0000")) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "星火 Agent 工具失败恢复消息不能包含空字符。",
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
        "SPARK_X_AGENT_TOOL_RECOVERY_FINAL_RESPONSE_FAILED",
        "工具失败恢复后的最终回复未包含预期运行标识。",
      );
    }
    if (
      result.toolCalls.length !== 2 ||
      result.toolResults.length !== 2 ||
      result.reviewEventCount !== 0
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_CARDINALITY_FAILED",
        "工具失败恢复回归必须产生一次失败调用和一次成功恢复调用。",
      );
    }
    const failureCall = result.toolCalls[0];
    const failureToolResult = result.toolResults[0];
    const recoveryCall = result.toolCalls[1];
    const recoveryToolResult = result.toolResults[1];
    if (
      failureCall === undefined ||
      failureToolResult === undefined ||
      recoveryCall === undefined ||
      recoveryToolResult === undefined ||
      failureCall.name !== "builtin-demo__calculator" ||
      failureToolResult.name !== "builtin-demo__calculator" ||
      failureCall.id !== failureToolResult.id ||
      failureToolResult.success !== false ||
      recoveryCall.name !== "builtin-demo__echo" ||
      recoveryToolResult.name !== "builtin-demo__echo" ||
      recoveryCall.id !== recoveryToolResult.id ||
      recoveryToolResult.success !== true ||
      failureCall.id === recoveryCall.id ||
      result.toolSequence.length !== 4 ||
      result.toolSequence[0]?.kind !== "call" ||
      result.toolSequence[0]?.id !== failureCall.id ||
      result.toolSequence[1]?.kind !== "result" ||
      result.toolSequence[1]?.id !== failureCall.id ||
      result.toolSequence[1]?.success !== false ||
      result.toolSequence[2]?.kind !== "call" ||
      result.toolSequence[2]?.id !== recoveryCall.id ||
      result.toolSequence[3]?.kind !== "result" ||
      result.toolSequence[3]?.id !== recoveryCall.id ||
      result.toolSequence[3]?.success !== true
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_SEQUENCE_FAILED",
        "工具失败与恢复调用的名称、标识、成功状态或执行顺序不一致。",
      );
    }
    const failureArgumentsCanonical = canonicalJson(failureCall.arguments);
    const failureResultCanonical = canonicalJson(failureToolResult.result);
    const recoveryArgumentsCanonical = canonicalJson(recoveryCall.arguments);
    const recoveryResultCanonical = canonicalJson(recoveryToolResult.result);
    if (
      failureArgumentsCanonical !== canonicalJson(failureArguments) ||
      failureResultCanonical !== canonicalJson(failureResult) ||
      recoveryArgumentsCanonical !== canonicalJson(recoveryArguments) ||
      recoveryResultCanonical !== canonicalJson(recoveryResult)
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_PAYLOAD_FAILED",
        "工具失败或恢复调用的结构化参数与结果不符合精确预期。",
      );
    }
    return {
      conversationId: result.conversationId,
      done: true,
      failureObserved: true,
      recoveryObserved: true,
      sequenceMatched: true,
      expectedTextMatched: true,
      toolCallCount: result.toolCalls.length,
      toolResultCount: result.toolResults.length,
      failedToolResultCount: 1,
      successfulToolResultCount: 1,
      reviewEventCount: result.reviewEventCount,
      failureCallIdSha256: sha256(failureCall.id),
      recoveryCallIdSha256: sha256(recoveryCall.id),
      failureArgumentsSha256: sha256(failureArgumentsCanonical),
      failureResultSha256: sha256(failureResultCanonical),
      recoveryArgumentsSha256: sha256(recoveryArgumentsCanonical),
      recoveryResultSha256: sha256(recoveryResultCanonical),
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

  if (action === "adapter:spark-x-agent/chat.assert-context-compaction-continuity") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const providerFixtureResourceId = requiredString(
      params,
      "providerFixtureResourceId",
      variables,
      73,
    );
    const runId = variables["run.id"];
    if (typeof runId !== "string" || !uuidPattern.test(runId)) {
      throw assertionFailure(
        "SPARK_X_AGENT_CONTEXT_RUN_ID_REQUIRED",
        "上下文压缩回归必须绑定有效 run_id。",
      );
    }
    const fixtureResource = providerFixtureResource(providerFixtureResourceId);
    const contextBaseUrl = contextCompactionFixtureBaseUrl(environment);
    const providers = await listSparkXProviders(environment, token, remainingOptions());
    const original = providers.find(
      (provider) => provider.id === fixtureResource.originalProviderId,
    );
    const fixture = providers.find((provider) => provider.id === fixtureResource.fixtureProviderId);
    const active = providers.filter((provider) => provider.active);
    if (
      original === undefined ||
      fixture === undefined ||
      active.length !== 1 ||
      active[0]?.id !== original.id ||
      fixture.active ||
      fixture.baseUrl !== contextBaseUrl ||
      fixture.model !== contextCompactionFixtureModel ||
      fixture.protocol !== "openai"
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_CONTEXT_FIXTURE_BASELINE_INVALID",
        "上下文压缩 Provider 夹具或原活跃 Provider 已偏离本次运行登记基线。",
      );
    }
    await activateSparkXProvider(environment, token, fixture.id, remainingOptions());
    const activated = await listSparkXProviders(environment, token, remainingOptions());
    const activatedProviders = activated.filter((provider) => provider.active);
    if (activatedProviders.length !== 1 || activatedProviders[0]?.id !== fixture.id) {
      throw apiFailure(
        "SPARK_X_AGENT_CONTEXT_FIXTURE_ACTIVATION_ASSERTION_FAILED",
        "上下文压缩 Provider 夹具没有成为唯一活跃 Provider。",
      );
    }

    const toolMessage = `CHAT005_TOOL:${runId}`;
    const expectedToolArguments = { query: `spark-x-chat005-${runId}` };
    const expectedToolResult = {
      success: true,
      results: [],
      message: "No relevant documents found",
    };
    const toolRound = await streamChat(
      environment,
      token,
      conversationId,
      toolMessage,
      remainingOptions(),
    );
    const toolCall = toolRound.toolCalls[0];
    const toolResult = toolRound.toolResults[0];
    if (
      toolRound.finalContent !== `CHAT005_TOOL_DONE:${runId}` ||
      toolRound.toolCalls.length !== 1 ||
      toolRound.toolResults.length !== 1 ||
      toolRound.reviewEventCount !== 0 ||
      toolCall === undefined ||
      toolResult === undefined ||
      toolCall.name !== "document_search" ||
      toolResult.name !== "document_search" ||
      toolCall.id !== toolResult.id ||
      toolResult.success !== true ||
      canonicalJson(toolCall.arguments) !== canonicalJson(expectedToolArguments) ||
      canonicalJson(toolResult.result) !== canonicalJson(expectedToolResult)
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_CONTEXT_TOOL_STATE_INVALID",
        "压缩前只读工具调用、结果或最终回复没有形成唯一完整的真实工具状态。",
      );
    }

    let triggerRound: number | undefined;
    let contextCompactingCount = 0;
    let contextReadyCount = 0;
    let phaseOrderMatched = false;
    const filler = "x".repeat(19_200);
    for (let round = 1; round <= 24; round += 1) {
      const result = await streamChat(
        environment,
        token,
        conversationId,
        `CHAT005_FILL:${runId}:${String(round).padStart(2, "0")}:${filler}`,
        remainingOptions(),
      );
      if (
        result.finalContent !== `CHAT005_FILL_ACK:${runId}` ||
        result.toolCalls.length !== 0 ||
        result.toolResults.length !== 0 ||
        result.reviewEventCount !== 0
      ) {
        throw assertionFailure(
          "SPARK_X_AGENT_CONTEXT_FILLER_RESPONSE_INVALID",
          "上下文填充轮产生了非固定回复、额外工具调用或人工复核。",
        );
      }
      const compactingIndexes = result.statusPhases
        .map((phase, index) => (phase === "context_compacting" ? index : -1))
        .filter((index) => index >= 0);
      const readyIndexes = result.statusPhases
        .map((phase, index) => (phase === "context_ready" ? index : -1))
        .filter((index) => index >= 0);
      if (compactingIndexes.length > 0 || readyIndexes.length > 0) {
        triggerRound = round;
        contextCompactingCount = compactingIndexes.length;
        contextReadyCount = readyIndexes.length;
        phaseOrderMatched =
          compactingIndexes.length === 1 &&
          readyIndexes.length === 1 &&
          (compactingIndexes[0] ?? Number.MAX_SAFE_INTEGER) < (readyIndexes[0] ?? -1);
        break;
      }
    }
    if (
      triggerRound === undefined ||
      contextCompactingCount !== 1 ||
      contextReadyCount !== 1 ||
      !phaseOrderMatched
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_CONTEXT_COMPACTION_NOT_OBSERVED",
        "有界长上下文没有产生唯一且有序的 context_compacting/context_ready 阶段。",
      );
    }

    const continuationText = `CHAT005_CONTINUITY_OK:${runId}`;
    const continuation = await streamChat(
      environment,
      token,
      conversationId,
      `CHAT005_CONTINUE:${runId}`,
      remainingOptions(),
    );
    const continuationRecompactionCount = continuation.statusPhases.filter(
      (phase) => phase === "context_compacting",
    ).length;
    if (
      continuation.finalContent !== continuationText ||
      continuation.toolCalls.length !== 0 ||
      continuation.toolResults.length !== 0 ||
      continuation.reviewEventCount !== 0 ||
      continuationRecompactionCount !== 0
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_CONTEXT_COMPACTION_CONTINUITY_FAILED",
        "独立续接请求没有从持久化摘要恢复关键事实与工具状态，或游标导致立即重复压缩。",
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
    accepted(historyResponse, "SPARK_X_AGENT_CONTEXT_COMPACTION_HISTORY_FAILED");
    const history = dataEnvelope(
      historyResponse.body,
      "SPARK_X_AGENT_CONTEXT_COMPACTION_HISTORY_RESPONSE_INVALID",
    );
    const items = Array.isArray(history.items)
      ? history.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
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
    const historyCall = calls[0];
    const historyFunction = historyCall === undefined ? null : objectValue(historyCall.function);
    const historyTool = toolMessages[0];
    const expectedMessageCount = triggerRound * 2 + 6;
    const traceEvents = items.flatMap((item) =>
      Array.isArray(item.public_execution_trace)
        ? item.public_execution_trace
            .map(objectValue)
            .filter((event): event is Readonly<Record<string, unknown>> => event !== null)
        : [],
    );
    const traceCalls = traceEvents.filter((event) => event.kind === "tool_call");
    const traceResults = traceEvents.filter((event) => event.kind === "tool_result");
    const historyArguments = structuredObject(
      historyFunction?.arguments,
      "SPARK_X_AGENT_CONTEXT_COMPACTION_HISTORY_RESPONSE_INVALID",
      "压缩后的工具调用历史缺少结构化参数。",
      "product_failed",
    );
    const historyResult = structuredObject(
      historyTool?.content,
      "SPARK_X_AGENT_CONTEXT_COMPACTION_HISTORY_RESPONSE_INVALID",
      "压缩后的工具结果历史缺少结构化结果。",
      "product_failed",
    );
    if (
      items.length !== expectedMessageCount ||
      userMessages.length !== triggerRound + 2 ||
      assistantMessages.length !== triggerRound + 3 ||
      toolMessages.length !== 1 ||
      calls.length !== 1 ||
      userMessages.filter((item) => item.content === toolMessage && item.payload_truncated !== true)
        .length !== 1 ||
      userMessages.filter(
        (item) => item.content === `CHAT005_CONTINUE:${runId}` && item.payload_truncated !== true,
      ).length !== 1 ||
      assistantMessages.filter(
        (item) => item.content === continuationText && item.payload_truncated !== true,
      ).length !== 1 ||
      historyCall?.id !== toolCall.id ||
      historyFunction?.name !== "document_search" ||
      historyTool?.tool_call_id !== toolCall.id ||
      canonicalJson(historyArguments) !== canonicalJson(expectedToolArguments) ||
      canonicalJson(historyResult) !== canonicalJson(expectedToolResult) ||
      traceCalls.length !== 1 ||
      traceResults.length !== 1 ||
      traceCalls[0]?.id !== toolCall.id ||
      traceCalls[0]?.name !== "document_search" ||
      traceResults[0]?.id !== toolCall.id ||
      traceResults[0]?.name !== "document_search" ||
      traceResults[0]?.success !== true
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_CONTEXT_COMPACTION_HISTORY_ASSERTION_FAILED",
        "压缩后权威历史没有完整保留唯一工具调用/结果、续接消息、公开轨迹或精确消息基数。",
      );
    }
    const toolArgumentsCanonical = canonicalJson(expectedToolArguments);
    const toolResultCanonical = canonicalJson(expectedToolResult);
    return {
      conversationId,
      compactionObserved: true,
      contextCompactingCount,
      contextReadyCount,
      phaseOrderMatched: true,
      durableContinuation: true,
      durableCursorContinued: true,
      toolStatePreserved: true,
      toolCallCount: 1,
      toolResultCount: 1,
      toolCallIdSha256: sha256(toolCall.id),
      toolArgumentsSha256: sha256(toolArgumentsCanonical),
      toolResultSha256: sha256(toolResultCanonical),
      triggerRound,
      continuationRecompactionCount,
      messageCount: items.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolMessageCount: toolMessages.length,
      traceToolCallCount: traceCalls.length,
      traceToolResultCount: traceResults.length,
      continuationContentSha256: sha256(continuationText),
    };
  }

  if (action === "adapter:spark-x-agent/chat.assert-provider-failure-retry") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const providerFixtureResourceId = requiredString(
      params,
      "providerFixtureResourceId",
      variables,
      73,
    );
    const requestId = requiredUuid(params, "requestId", variables);
    const failureMessage = requiredString(params, "failureMessage", variables, 20_000);
    const retryMessage = requiredString(params, "retryMessage", variables, 20_000);
    const expectedText = requiredString(params, "expectedText", variables, 5_000);
    if (
      failureMessage === retryMessage ||
      failureMessage.includes("\u0000") ||
      retryMessage.includes("\u0000")
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "首次失败与明确重试消息必须是不同的受控非空文本，且不能包含空字符。",
      );
    }
    const fixtureResource = providerFixtureResource(providerFixtureResourceId);
    const faultBaseUrl = transientProviderFixtureBaseUrl(environment);
    const providers = await listSparkXProviders(environment, token, remainingOptions());
    const original = providers.find(
      (provider) => provider.id === fixtureResource.originalProviderId,
    );
    const fixture = providers.find((provider) => provider.id === fixtureResource.fixtureProviderId);
    const active = providers.filter((provider) => provider.active);
    if (
      original === undefined ||
      fixture === undefined ||
      active.length !== 1 ||
      active[0]?.id !== original.id ||
      fixture.active ||
      fixture.baseUrl !== faultBaseUrl ||
      fixture.model !== transientProviderFixtureModel ||
      fixture.protocol !== "openai"
    ) {
      throw environmentFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_BASELINE_INVALID",
        "短暂 Provider 故障夹具或原活跃 Provider 已偏离本次运行登记基线。",
      );
    }
    await activateSparkXProvider(environment, token, fixture.id, remainingOptions());
    const activated = await listSparkXProviders(environment, token, remainingOptions());
    const activatedProviders = activated.filter((provider) => provider.active);
    if (activatedProviders.length !== 1 || activatedProviders[0]?.id !== fixture.id) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_FIXTURE_ACTIVATION_ASSERTION_FAILED",
        "临时 Provider 故障夹具没有成为唯一活跃 Provider。",
      );
    }
    let failedTurn: EnqueuedSparkXTurn | undefined;
    let enqueueError: Error | undefined;
    try {
      failedTurn = await enqueueSparkXTurn(
        environment,
        token,
        conversationId,
        requestId,
        failureMessage,
        remainingOptions,
      );
    } catch (error) {
      enqueueError =
        error instanceof Error
          ? error
          : new ExecutorFailure(
              {
                code: "SPARK_X_AGENT_TURN_ENQUEUE_FAILED",
                message: "短暂故障 Turn 入队失败。",
                classification: "environment_failed",
              },
              error,
            );
    }
    let restoreError: unknown;
    try {
      await activateSparkXProvider(environment, token, original.id, remainingOptions());
    } catch (error) {
      restoreError = error;
    }
    if (enqueueError !== undefined) throw enqueueError;
    if (restoreError !== undefined) {
      throw new ExecutorFailure(
        {
          code: "SPARK_X_AGENT_PROVIDER_RESTORE_FAILED",
          message: "短暂故障 Turn 入队后未能立即恢复原 Provider。",
          classification: "environment_failed",
        },
        restoreError,
      );
    }
    if (failedTurn === undefined) {
      throw environmentFailure(
        "SPARK_X_AGENT_TURN_ENQUEUE_OUTCOME_UNKNOWN",
        "短暂故障 Turn 入队结果无法确认。",
      );
    }
    const restored = await listSparkXProviders(environment, token, remainingOptions());
    const restoredProviders = restored.filter((provider) => provider.active);
    if (restoredProviders.length !== 1 || restoredProviders[0]?.id !== original.id) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_RESTORE_ASSERTION_FAILED",
        "原 Provider 激活请求完成后没有恢复为唯一活跃 Provider。",
      );
    }
    const failed = await waitForSparkXTurnTerminal(
      environment,
      token,
      conversationId,
      failedTurn.turnId,
      300,
      remainingOptions,
    );
    if (
      failed.snapshot.status !== "failed" ||
      failed.snapshot.failureCode !== "provider_unavailable" ||
      failed.snapshot.failureRetryable !== true ||
      failed.snapshot.assistantMessageId !== null ||
      failed.snapshot.finishReason !== null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_FIRST_FAILURE_ASSERTION_FAILED",
        "固定不可达 Provider 没有留下可重试、无助手消息的 provider_unavailable 首次失败。",
      );
    }
    const firstHistoryResponse = await authenticatedRequest(
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
    accepted(firstHistoryResponse, "SPARK_X_AGENT_PROVIDER_FIRST_FAILURE_HISTORY_FAILED");
    const firstHistory = dataEnvelope(
      firstHistoryResponse.body,
      "SPARK_X_AGENT_PROVIDER_FIRST_FAILURE_HISTORY_RESPONSE_INVALID",
    );
    const firstItems = Array.isArray(firstHistory.items)
      ? firstHistory.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    const firstFailedUsers = firstItems.filter(
      (item) => item.turn_id === failedTurn.turnId && item.role === "user",
    );
    const firstFailedAssistants = firstItems.filter(
      (item) => item.turn_id === failedTurn.turnId && item.role === "assistant",
    );
    if (
      firstItems.some((item) => item.payload_truncated === true) ||
      firstFailedUsers.length !== 1 ||
      firstFailedAssistants.length !== 0 ||
      firstFailedUsers[0]?.id !== failedTurn.messageId ||
      firstFailedUsers[0]?.content !== failureMessage ||
      firstFailedUsers[0]?.turn_status !== "failed" ||
      firstFailedUsers[0]?.failure_code !== "provider_unavailable" ||
      firstFailedUsers[0]?.failure_retryable !== true
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_FIRST_FAILURE_HISTORY_ASSERTION_FAILED",
        "首次 Provider 失败没有以唯一失败输入、稳定错误码和可重试标记公开持久化。",
      );
    }

    const retryRequestId = derivedUuid(requestId, "explicit-provider-retry");
    const retryTurn = await enqueueSparkXTurn(
      environment,
      token,
      conversationId,
      retryRequestId,
      retryMessage,
      remainingOptions,
    );
    if (retryTurn.turnId === failedTurn.turnId || retryTurn.messageId === failedTurn.messageId) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_RETRY_IDENTITY_REUSED",
        "用户明确重试错误地复用了首次失败的 Turn 或输入消息标识。",
      );
    }
    const retried = await waitForSparkXTurnTerminal(
      environment,
      token,
      conversationId,
      retryTurn.turnId,
      600,
      remainingOptions,
    );
    if (
      retried.snapshot.status !== "completed" ||
      retried.snapshot.assistantMessageId === null ||
      retried.snapshot.finishReason !== "stop" ||
      retried.snapshot.failureCode !== null ||
      retried.snapshot.failureRetryable !== null
    ) {
      if (retried.snapshot.failureRetryable === true) {
        throw environmentFailure(
          "SPARK_X_AGENT_PROVIDER_EXPLICIT_RETRY_ENVIRONMENT_FAILED",
          "恢复原 Provider 后的明确重试仍因可重试运行时或 Provider 原因失败。",
        );
      }
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_EXPLICIT_RETRY_FAILED",
        "恢复原 Provider 后的独立重试 Turn 未以 stop 完成。",
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
    accepted(historyResponse, "SPARK_X_AGENT_PROVIDER_RETRY_HISTORY_FAILED");
    const history = dataEnvelope(
      historyResponse.body,
      "SPARK_X_AGENT_PROVIDER_RETRY_HISTORY_RESPONSE_INVALID",
    );
    const items = Array.isArray(history.items)
      ? history.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    if (items.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_RETRY_HISTORY_TRUNCATED",
        "Provider 失败与明确重试历史包含截断消息。",
      );
    }
    const publicMessages = items.filter(
      (item) => item.role === "user" || item.role === "assistant",
    );
    const toolMessages = items.filter((item) => item.role === "tool");
    const failedUsers = publicMessages.filter(
      (item) => item.turn_id === failedTurn.turnId && item.role === "user",
    );
    const failedAssistants = publicMessages.filter(
      (item) => item.turn_id === failedTurn.turnId && item.role === "assistant",
    );
    const retryUsers = publicMessages.filter(
      (item) => item.turn_id === retryTurn.turnId && item.role === "user",
    );
    const retryAssistants = publicMessages.filter(
      (item) => item.turn_id === retryTurn.turnId && item.role === "assistant",
    );
    const retryAssistant = retryAssistants[0];
    const expectedRoles = "user,user,assistant";
    const roles = publicMessages.map((item) => item.role).join(",");
    const reverseRoles = [...publicMessages]
      .reverse()
      .map((item) => item.role)
      .join(",");
    if (
      publicMessages.length !== 3 ||
      toolMessages.length !== 0 ||
      failedUsers.length !== 1 ||
      failedAssistants.length !== 0 ||
      retryUsers.length !== 1 ||
      retryAssistants.length !== 1 ||
      (roles !== expectedRoles && reverseRoles !== expectedRoles) ||
      failedUsers[0]?.id !== failedTurn.messageId ||
      failedUsers[0]?.content !== failureMessage ||
      failedUsers[0]?.turn_status !== "failed" ||
      failedUsers[0]?.failure_code !== "provider_unavailable" ||
      failedUsers[0]?.failure_retryable !== true ||
      retryUsers[0]?.id !== retryTurn.messageId ||
      retryUsers[0]?.content !== retryMessage ||
      retryUsers[0]?.turn_status !== "completed" ||
      retryAssistant === undefined ||
      retryAssistant.id !== retried.snapshot.assistantMessageId ||
      typeof retryAssistant.content !== "string" ||
      !retryAssistant.content.includes(expectedText) ||
      retryAssistant.turn_status !== "completed" ||
      retryAssistant.finish_reason !== "stop"
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_PROVIDER_RETRY_HISTORY_ASSERTION_FAILED",
        "Provider 失败与明确重试历史没有保持一条失败输入、一条重试输入和一条成功回复。",
      );
    }
    return {
      conversationId,
      failedTurnId: failedTurn.turnId,
      retryTurnId: retryTurn.turnId,
      firstFailureVisible: true,
      failureCode: "provider_unavailable",
      failureRetryable: true,
      failedAssistantAbsent: true,
      retryCompleted: true,
      independentAttempts: true,
      messageCardinalityMatched: true,
      messageCount: publicMessages.length,
      failedUserMessageCount: failedUsers.length,
      retryUserMessageCount: retryUsers.length,
      retryAssistantMessageCount: retryAssistants.length,
      toolMessageCount: toolMessages.length,
      expectedTextMatched: true,
      failureInputSha256: sha256(failureMessage),
      retryInputSha256: sha256(retryMessage),
      retryAssistantSha256: sha256(retryAssistant.content),
      retryAssistantContentLength: retryAssistant.content.length,
      failurePollAttempts: failed.pollAttempts,
      retryPollAttempts: retried.pollAttempts,
    };
  }

  if (action === "adapter:spark-x-agent/chat.cancel-and-resume") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const requestId = requiredUuid(params, "requestId", variables);
    const cancelMessage = requiredString(params, "cancelMessage", variables, 20_000);
    const resumeMessage = requiredString(params, "resumeMessage", variables, 20_000);
    const expectedText = requiredString(params, "expectedText", variables, 5_000);
    if (
      cancelMessage.includes("\u0000") ||
      resumeMessage.includes("\u0000") ||
      cancelMessage === resumeMessage
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "取消与续接消息必须是不同的受控非空文本，且不能包含空字符。",
      );
    }
    const cancelTurn = await enqueueSparkXTurn(
      environment,
      token,
      conversationId,
      requestId,
      cancelMessage,
      remainingOptions,
    );
    const active = await waitForSparkXTurnActive(
      environment,
      token,
      conversationId,
      cancelTurn.turnId,
      remainingOptions,
    );
    const cancelRequestId = derivedUuid(requestId, "cancel");
    const cancelResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "POST",
        path: actionPath(`/v5/turns/${encodeURIComponent(cancelTurn.turnId)}/cancel`),
        headers: { "Idempotency-Key": cancelRequestId },
      },
      remainingOptions(),
    );
    accepted(cancelResponse, "SPARK_X_AGENT_TURN_CANCEL_FAILED");
    const cancelReceipt = objectValue(cancelResponse.body);
    const actionBoundaries = [
      "none",
      "prepared_cancelled",
      "external_effect_in_flight",
      "completed_effect_exists",
    ];
    if (
      cancelReceipt === null ||
      typeof cancelReceipt.control_request_id !== "string" ||
      !uuidPattern.test(cancelReceipt.control_request_id) ||
      cancelReceipt.request_disposition !== "requested" ||
      cancelReceipt.idempotent_replay !== false ||
      typeof cancelReceipt.action_boundary !== "string" ||
      !actionBoundaries.includes(cancelReceipt.action_boundary)
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_TURN_CANCEL_RESPONSE_INVALID",
        "星火 Agent Turn 取消回执缺少首次请求、控制标识或动作边界。",
      );
    }
    const receiptSnapshot = sparkXTurnSnapshot(
      cancelReceipt.snapshot,
      cancelTurn.turnId,
      conversationId,
    );
    if (
      !["cancel_requested", "cancelling", "cancelled"].includes(receiptSnapshot.status) ||
      receiptSnapshot.cancelRequestedAt === null ||
      cancelReceipt.action_boundary !== "none"
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_TURN_CANCEL_BOUNDARY_FAILED",
        "无工具对话取消没有停留在安全的无外部副作用边界。",
      );
    }
    const cancelled = await waitForSparkXTurnTerminal(
      environment,
      token,
      conversationId,
      cancelTurn.turnId,
      300,
      remainingOptions,
    );
    if (
      cancelled.snapshot.status !== "cancelled" ||
      cancelled.snapshot.cancelRequestedAt === null ||
      cancelled.snapshot.assistantMessageId !== null ||
      cancelled.snapshot.finishReason !== null ||
      cancelled.snapshot.failureCode !== null ||
      cancelled.snapshot.failureRetryable !== null
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_TURN_CANCEL_TERMINAL_FAILED",
        "星火 Agent Turn 取消终态包含助手消息或不一致的成功/失败字段。",
      );
    }

    const resumeRequestId = derivedUuid(requestId, "resume");
    const resumedTurn = await enqueueSparkXTurn(
      environment,
      token,
      conversationId,
      resumeRequestId,
      resumeMessage,
      remainingOptions,
    );
    const resumed = await waitForSparkXTurnTerminal(
      environment,
      token,
      conversationId,
      resumedTurn.turnId,
      600,
      remainingOptions,
    );
    if (
      resumed.snapshot.status !== "completed" ||
      resumed.snapshot.assistantMessageId === null ||
      resumed.snapshot.finishReason !== "stop" ||
      resumed.snapshot.failureCode !== null ||
      resumed.snapshot.failureRetryable !== null
    ) {
      if (resumed.snapshot.failureRetryable === true) {
        throw environmentFailure(
          "SPARK_X_AGENT_TURN_RESUME_ENVIRONMENT_FAILED",
          "取消后的续接 Turn 因可重试运行时或 Provider 原因失败。",
        );
      }
      throw apiFailure("SPARK_X_AGENT_TURN_RESUME_FAILED", "取消后的续接 Turn 未以 stop 完成。");
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
    accepted(historyResponse, "SPARK_X_AGENT_TURN_CANCEL_HISTORY_FAILED");
    const history = dataEnvelope(
      historyResponse.body,
      "SPARK_X_AGENT_TURN_CANCEL_HISTORY_RESPONSE_INVALID",
    );
    const items = Array.isArray(history.items)
      ? history.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    if (items.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_TURN_CANCEL_HISTORY_TRUNCATED",
        "星火 Agent 取消与续接历史包含截断消息。",
      );
    }
    const publicMessages = items.filter(
      (item) => item.role === "user" || item.role === "assistant",
    );
    const toolMessages = items.filter((item) => item.role === "tool");
    const cancelledUsers = publicMessages.filter(
      (item) => item.turn_id === cancelTurn.turnId && item.role === "user",
    );
    const ghostAssistants = publicMessages.filter(
      (item) => item.turn_id === cancelTurn.turnId && item.role === "assistant",
    );
    const resumedUsers = publicMessages.filter(
      (item) => item.turn_id === resumedTurn.turnId && item.role === "user",
    );
    const resumedAssistants = publicMessages.filter(
      (item) => item.turn_id === resumedTurn.turnId && item.role === "assistant",
    );
    const resumedAssistant = resumedAssistants[0];
    if (
      publicMessages.length !== 3 ||
      toolMessages.length !== 0 ||
      cancelledUsers.length !== 1 ||
      ghostAssistants.length !== 0 ||
      resumedUsers.length !== 1 ||
      resumedAssistants.length !== 1 ||
      cancelledUsers[0]?.content !== cancelMessage ||
      cancelledUsers[0]?.turn_status !== "cancelled" ||
      resumedUsers[0]?.content !== resumeMessage ||
      resumedUsers[0]?.turn_status !== "completed" ||
      resumedAssistant === undefined ||
      typeof resumedAssistant.content !== "string" ||
      !resumedAssistant.content.includes(expectedText) ||
      resumedAssistant.turn_status !== "completed" ||
      resumedAssistant.finish_reason !== "stop"
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_TURN_CANCEL_HISTORY_ASSERTION_FAILED",
        "取消与续接历史没有保持一条取消输入、零幽灵回复和一组完整续接消息。",
      );
    }
    return {
      conversationId,
      cancelledTurnId: cancelTurn.turnId,
      resumedTurnId: resumedTurn.turnId,
      cancelRequested: true,
      cancelActionBoundary: cancelReceipt.action_boundary,
      cancelledStatus: "cancelled",
      cancelledAssistantAbsent: true,
      resumeCompleted: true,
      messageCount: publicMessages.length,
      cancelledUserMessageCount: cancelledUsers.length,
      resumedUserMessageCount: resumedUsers.length,
      resumedAssistantMessageCount: resumedAssistants.length,
      toolMessageCount: toolMessages.length,
      ghostAssistantCount: ghostAssistants.length,
      expectedTextMatched: true,
      cancelInputSha256: sha256(cancelMessage),
      resumeInputSha256: sha256(resumeMessage),
      resumeAssistantSha256: sha256(resumedAssistant.content),
      resumeAssistantContentLength: resumedAssistant.content.length,
      activePollAttempts: active.pollAttempts,
      cancelPollAttempts: cancelled.pollAttempts,
      resumePollAttempts: resumed.pollAttempts,
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

  if (action === "adapter:spark-x-agent/conversation.rename-and-assert-pagination") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const title = requiredString(params, "title", variables, 200);
    const expectedOrder = requiredUuidArray(params, "expectedOrder", variables, 3);
    if (expectedOrder[0] !== conversationId) {
      throw assertionFailure(
        "SPARK_X_AGENT_PARAMETER_INVALID",
        "重命名会话必须是预期更新时间顺序中的第一条。",
      );
    }
    const renameResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "PUT",
        path: actionPath(`/conversations/${encodeURIComponent(conversationId)}`),
        headers: { "Content-Type": "application/json" },
        body: { title },
      },
      remainingOptions(),
    );
    accepted(renameResponse, "SPARK_X_AGENT_CONVERSATION_RENAME_FAILED");
    const renamed = dataEnvelope(
      renameResponse.body,
      "SPARK_X_AGENT_CONVERSATION_RENAME_RESPONSE_INVALID",
    );
    if (
      renamed.id !== conversationId ||
      renamed.title !== title ||
      renamed.title_source !== "manual"
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_RENAME_RESPONSE_INVALID",
        "星火 Agent 会话重命名响应与目标会话或手工标题不一致。",
      );
    }

    const firstSweep = await scanConversationPagination(
      environment,
      token,
      expectedOrder,
      conversationId,
      title,
      remainingOptions,
    );
    const secondSweep = await scanConversationPagination(
      environment,
      token,
      expectedOrder,
      conversationId,
      title,
      remainingOptions,
    );
    if (
      firstSweep.orderedExpectedIds.join(",") !== secondSweep.orderedExpectedIds.join(",") ||
      firstSweep.expectedLocations.join(",") !== secondSweep.expectedLocations.join(",")
    ) {
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_PAGINATION_DRIFT",
        "星火 Agent 连续两次会话分页扫描出现位置或顺序漂移。",
      );
    }
    return {
      conversationId,
      renamed: true,
      titleSource: "manual",
      titleSha256: sha256(title),
      pageSize: 2,
      expectedConversationCount: expectedOrder.length,
      firstSweepPages: firstSweep.pagesScanned,
      secondSweepPages: secondSweep.pagesScanned,
      distinctExpectedPages: firstSweep.distinctExpectedPages,
      duplicateCount: 0,
      missingCount: 0,
      crossPage: true,
      orderStable: true,
    };
  }

  if (action === "adapter:spark-x-agent/conversation.assert-deleted-state") {
    const conversationId = requiredUuid(params, "conversationId", variables);
    const detailResponse = await authenticatedRequest(
      environment,
      token,
      {
        method: "GET",
        path: actionPath(`/conversations/${encodeURIComponent(conversationId)}`),
      },
      remainingOptions(),
    );
    let detailState: "deleted" | "missing";
    if (detailResponse.status === 404) {
      detailState = "missing";
    } else {
      accepted(detailResponse, "SPARK_X_AGENT_CONVERSATION_DELETED_DETAIL_FAILED");
      const detail = dataEnvelope(
        detailResponse.body,
        "SPARK_X_AGENT_CONVERSATION_DELETED_DETAIL_RESPONSE_INVALID",
      );
      const conversation = objectValue(detail.conversation);
      if (conversation?.id !== conversationId || conversation.status !== "deleted") {
        throw apiFailure(
          "SPARK_X_AGENT_CONVERSATION_DELETED_DETAIL_RESPONSE_INVALID",
          "星火 Agent 已删除会话详情没有返回目标删除状态。",
        );
      }
      detailState = "deleted";
    }
    const active = await scanConversationOccurrences(
      environment,
      token,
      conversationId,
      "active",
      remainingOptions,
    );
    if (active.occurrences !== 0) {
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_DELETE_ACTIVE_FAILED",
        "星火 Agent 已删除会话仍出现在活动会话列表。",
      );
    }
    const deleted = await scanConversationOccurrences(
      environment,
      token,
      conversationId,
      "deleted",
      remainingOptions,
    );
    if (deleted.occurrences !== 1) {
      throw apiFailure(
        "SPARK_X_AGENT_CONVERSATION_DELETE_CARDINALITY_FAILED",
        "星火 Agent 删除列表没有且仅有一条目标会话记录。",
      );
    }
    return {
      conversationId,
      detailState,
      activeOccurrences: active.occurrences,
      deletedOccurrences: deleted.occurrences,
      activePagesScanned: active.pagesScanned,
      deletedPagesScanned: deleted.pagesScanned,
      uniqueDeletedRecord: true,
    };
  }

  const conversationId = requiredString(params, "conversationId", variables, 100);
  if (action === "adapter:spark-x-agent/tool.assert-failure-recovery-history") {
    const expectedUserText = requiredString(params, "expectedUserText", variables, 20_000);
    const expectedAssistantText = requiredString(params, "expectedAssistantText", variables, 5_000);
    const expectedAssistantSha256 = requiredSha256(params, "expectedAssistantSha256", variables);
    const failureArgumentsSha256 = requiredSha256(params, "failureArgumentsSha256", variables);
    const failureResultSha256 = requiredSha256(params, "failureResultSha256", variables);
    const recoveryArgumentsSha256 = requiredSha256(params, "recoveryArgumentsSha256", variables);
    const recoveryResultSha256 = requiredSha256(params, "recoveryResultSha256", variables);
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
    accepted(response, "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_FAILED");
    const data = dataEnvelope(
      response.body,
      "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
    );
    const items = Array.isArray(data.items)
      ? data.items
          .map(objectValue)
          .filter((item): item is Readonly<Record<string, unknown>> => item !== null)
      : [];
    if (items.some((item) => item.payload_truncated === true)) {
      throw apiFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_TRUNCATED",
        "星火 Agent 工具失败恢复历史包含已截断的公开消息。",
      );
    }
    const roles = items.map((item) => item.role).join(",");
    const userMessages = items.filter((item) => item.role === "user");
    const assistantMessages = items.filter((item) => item.role === "assistant");
    const toolMessages = items.filter((item) => item.role === "tool");
    if (
      items.length !== 6 ||
      roles !== "user,assistant,tool,assistant,tool,assistant" ||
      userMessages.length !== 1 ||
      assistantMessages.length !== 3 ||
      toolMessages.length !== 2
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_CARDINALITY_FAILED",
        "工具失败恢复历史必须依次包含用户、失败调用/结果、恢复调用/结果和最终回复。",
      );
    }
    const failureAssistant = assistantMessages[0];
    const recoveryAssistant = assistantMessages[1];
    const finalAssistant = assistantMessages[2];
    const failureCalls = Array.isArray(failureAssistant?.tool_calls)
      ? failureAssistant.tool_calls
          .map(objectValue)
          .filter((call): call is Readonly<Record<string, unknown>> => call !== null)
      : [];
    const recoveryCalls = Array.isArray(recoveryAssistant?.tool_calls)
      ? recoveryAssistant.tool_calls
          .map(objectValue)
          .filter((call): call is Readonly<Record<string, unknown>> => call !== null)
      : [];
    const failureCall = failureCalls[0];
    const recoveryCall = recoveryCalls[0];
    const failureFunction = objectValue(failureCall?.function);
    const recoveryFunction = objectValue(recoveryCall?.function);
    const failureToolMessage = toolMessages[0];
    const recoveryToolMessage = toolMessages[1];
    if (
      userMessages[0]?.content !== expectedUserText ||
      failureCalls.length !== 1 ||
      recoveryCalls.length !== 1 ||
      typeof failureCall?.id !== "string" ||
      failureFunction?.name !== "builtin-demo__calculator" ||
      failureToolMessage?.tool_call_id !== failureCall.id ||
      typeof failureToolMessage.content !== "string" ||
      typeof recoveryCall?.id !== "string" ||
      recoveryCall.id === failureCall.id ||
      recoveryFunction?.name !== "builtin-demo__echo" ||
      recoveryToolMessage?.tool_call_id !== recoveryCall.id ||
      typeof recoveryToolMessage.content !== "string" ||
      finalAssistant?.finish_reason !== "stop" ||
      typeof finalAssistant.content !== "string" ||
      !finalAssistant.content.includes(expectedAssistantText) ||
      (Array.isArray(finalAssistant.tool_calls) && finalAssistant.tool_calls.length !== 0)
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_IDENTITY_FAILED",
        "工具失败恢复历史的调用身份、结果关联、顺序或最终回复不一致。",
      );
    }
    const failureArguments = structuredObject(
      failureFunction.arguments,
      "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
      "失败工具历史缺少结构化参数。",
      "product_failed",
    );
    const failureResult = structuredObject(
      failureToolMessage.content,
      "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
      "失败工具历史缺少结构化结果。",
      "product_failed",
    );
    const recoveryArguments = structuredObject(
      recoveryFunction.arguments,
      "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
      "恢复工具历史缺少结构化参数。",
      "product_failed",
    );
    const recoveryResult = structuredObject(
      recoveryToolMessage.content,
      "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
      "恢复工具历史缺少结构化结果。",
      "product_failed",
    );
    const assistantContentSha256 = sha256(finalAssistant.content);
    if (
      sha256(canonicalJson(failureArguments)) !== failureArgumentsSha256 ||
      sha256(canonicalJson(failureResult)) !== failureResultSha256 ||
      sha256(canonicalJson(recoveryArguments)) !== recoveryArgumentsSha256 ||
      sha256(canonicalJson(recoveryResult)) !== recoveryResultSha256 ||
      assistantContentSha256 !== expectedAssistantSha256
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_HASH_MISMATCH",
        "工具失败、恢复或最终回复的持久化哈希与流式证据不一致。",
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
      traceCalls.length !== 2 ||
      traceResults.length !== 2 ||
      traceCalls[0]?.id !== failureCall.id ||
      traceCalls[0]?.name !== "builtin-demo__calculator" ||
      traceResults[0]?.id !== failureCall.id ||
      traceResults[0]?.name !== "builtin-demo__calculator" ||
      traceResults[0]?.success !== false ||
      traceCalls[1]?.id !== recoveryCall.id ||
      traceCalls[1]?.name !== "builtin-demo__echo" ||
      traceResults[1]?.id !== recoveryCall.id ||
      traceResults[1]?.name !== "builtin-demo__echo" ||
      traceResults[1]?.success !== true
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_TRACE_FAILED",
        "工具失败恢复的公开执行轨迹与消息历史不一致。",
      );
    }
    const tracePayloadHashes = [
      sha256(
        canonicalJson(
          structuredObject(
            traceCalls[0]?.arguments,
            "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
            "失败工具公开轨迹缺少结构化参数。",
            "product_failed",
          ),
        ),
      ),
      sha256(
        canonicalJson(
          structuredObject(
            traceResults[0]?.result,
            "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
            "失败工具公开轨迹缺少结构化结果。",
            "product_failed",
          ),
        ),
      ),
      sha256(
        canonicalJson(
          structuredObject(
            traceCalls[1]?.arguments,
            "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
            "恢复工具公开轨迹缺少结构化参数。",
            "product_failed",
          ),
        ),
      ),
      sha256(
        canonicalJson(
          structuredObject(
            traceResults[1]?.result,
            "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_RESPONSE_INVALID",
            "恢复工具公开轨迹缺少结构化结果。",
            "product_failed",
          ),
        ),
      ),
    ];
    if (
      tracePayloadHashes.join(",") !==
      [
        failureArgumentsSha256,
        failureResultSha256,
        recoveryArgumentsSha256,
        recoveryResultSha256,
      ].join(",")
    ) {
      throw assertionFailure(
        "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_TRACE_FAILED",
        "工具失败恢复的公开执行轨迹与消息历史不一致。",
      );
    }
    return {
      conversationId,
      messageCount: items.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      toolMessageCount: toolMessages.length,
      toolCallCount: 2,
      toolResultCount: toolMessages.length,
      traceToolCallCount: traceCalls.length,
      traceToolResultCount: traceResults.length,
      failureObserved: true,
      recoveryObserved: true,
      sequenceMatched: true,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      assistantContentLength: finalAssistant.content.length,
      assistantContentSha256,
      assistantFinishReason: "stop",
    };
  }
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
    const occurrenceCount = items.filter((item) => item.id === conversationId).length;
    const position = items.findIndex((item) => item.id === conversationId);
    const firstUnpinned = items.findIndex((item) => item?.is_pinned !== true);
    const found = position < 0 ? null : items[position];
    if (
      position < 0 ||
      occurrenceCount !== 1 ||
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
      occurrenceCount,
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
