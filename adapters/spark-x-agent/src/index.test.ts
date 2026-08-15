import { createHash } from "node:crypto";

import { ExecutorFailure, type HttpExecutionEnvironment } from "@spark-x-test/executors";
import { describe, expect, it, vi } from "vitest";

import {
  executeSparkXAgentAction,
  sparkXAgentActionCapabilities,
  sparkXAgentActions,
  sparkXAgentAdapterManifest,
} from "./index.js";

const environment: HttpExecutionEnvironment = {
  baseUrl: "http://192.168.110.136/trade/",
  actionLevel: "dangerous",
  allowlist: [
    {
      protocol: "http",
      host: "192.168.110.136",
      ports: [80],
      pathPrefixes: ["/trade/", "/trade-domain-api/"],
    },
  ],
};

const credentials = {
  username: "${case.admin-username}",
  password: "${case.admin-password}",
};
const variables = {
  "case.admin-username": "admin",
  "case.admin-password": "never-persist-this-password",
  "run.id": "00000000-0000-4000-8000-000000000201",
};
const conversationId = "00000000-0000-4000-8000-000000000202";
const knowledgeBaseId = "00000000-0000-4000-8000-000000000210";
const uploadedDocumentId = "00000000-0000-4000-8000-000000000211";
const knowledgeDocumentId = "00000000-0000-4000-8000-000000000212";
const knowledgeVersionId = "00000000-0000-4000-8000-000000000215";
const knowledgeScopeId = "00000000-0000-4000-8000-000000000216";
const knowledgeSnapshotId = "00000000-0000-4000-8000-000000000217";
const skillId = "00000000-0000-4000-8000-000000000213";
const automationId = "00000000-0000-4000-8000-000000000214";
const automationMarker = `spark-x-auto-${variables["run.id"]}`;
const automationName = automationMarker;
const automationGoal = `自动任务回归标识 ${automationMarker}。请只回复这个标识，不要调用任何工具或 Skill。`;
const skillPrompt = "Produce the trusted daily trade and port brief without exposing credentials.";
const skillPromptSha256 = createHash("sha256").update(skillPrompt).digest("hex");

function trustedSkillProjection(
  prompt = skillPrompt,
  localAssetPresent = true,
): Readonly<Record<string, unknown>> {
  return {
    id: skillId,
    name: "trade-port-daily-brief",
    display_name: "贸易与港口每日简报",
    description: "trusted fixture",
    category: "utility",
    is_builtin: false,
    is_enabled: true,
    config: {
      prompt_template: prompt,
      source: "upload",
      main_file: "trade-port-daily-brief.md",
      durable_agent_task_v17: true,
      type: "行业研究",
    },
    assets: {
      root_exists: localAssetPresent,
      has_skill_md: localAssetPresent,
      main_file: localAssetPresent ? "trade-port-daily-brief.md" : null,
      asset_count: localAssetPresent ? 1 : 0,
    },
  };
}

function automationProjection(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    definition_id: automationId,
    conversation_id: conversationId,
    name: automationName,
    goal: automationGoal,
    selected_skill_id: null,
    interval_seconds: 300,
    status: "enabled",
    state_version: 2,
    next_fire_at: "2026-08-15T04:05:00.000Z",
    last_fire_at: "2026-08-15T04:00:00.000Z",
    suspension_reason: null,
    created_at: "2026-08-15T03:59:59.000Z",
    updated_at: "2026-08-15T04:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: readonly Readonly<Record<string, unknown>>[], status = 200): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function urlOf(input: URL | RequestInfo): string {
  return input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

describe("spark-x-agent adapter", () => {
  it("declares the controlled conversation capabilities", () => {
    expect(sparkXAgentAdapterManifest).toMatchObject({
      key: "spark-x-agent",
      version: "0.8.2",
      capabilities: {
        actions: [
          expect.objectContaining({
            key: "conversation.create",
            producesResource: true,
          }),
          expect.objectContaining({
            key: "conversation.assert-recent",
            actionLevel: "write",
          }),
          expect.objectContaining({ key: "chat.ask", producesResource: false }),
          expect.objectContaining({
            key: "chat.assert-history",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "chat.assert-context-history",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "tool.assert-safe-catalog",
            actionLevel: "read",
          }),
          expect.objectContaining({
            key: "tool.invoke-safe",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "tool.assert-history",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.create",
            producesResource: true,
            cleanupAction: "knowledge-base.cleanup",
          }),
          expect.objectContaining({
            key: "knowledge-base.upload-fixture",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.attach-upload",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.wait-ready",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.assert-conversation-scope",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.cleanup",
            actionLevel: "dangerous",
          }),
          expect.objectContaining({
            key: "automation.create",
            producesResource: true,
            cleanupAction: "automation.cleanup",
          }),
          expect.objectContaining({
            key: "automation.wait-fired",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "automation.cleanup",
            actionLevel: "dangerous",
          }),
          expect.objectContaining({
            key: "skill.assert-trusted-publication",
            actionLevel: "read",
            producesResource: false,
          }),
          expect.objectContaining({
            key: "conversation.delete",
            actionLevel: "dangerous",
          }),
        ],
      },
    });
    expect(
      sparkXAgentActionCapabilities
        .map((capability) => `adapter:spark-x-agent/${capability.key}`)
        .sort(),
    ).toEqual([...sparkXAgentActions].sort());
  });

  it("keeps the login token in memory while returning only structured create evidence", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: conversationId, title: "regression-run" },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/conversation.create",
      environment,
      { ...credentials, title: "regression-${run.id}" },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      conversationId,
      title: "regression-run",
    });
    expect(urlOf(fetcher.mock.calls[0]?.[0] as URL | RequestInfo)).toBe(
      "http://192.168.110.136/trade/api/auth/login",
    );
    expect(urlOf(fetcher.mock.calls[1]?.[0] as URL | RequestInfo)).toBe(
      "http://192.168.110.136/trade/api/conversations",
    );
    const createHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(createHeaders.get("authorization")).toBe("Bearer memory-only-access-token-value");
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("uses persisted history for the recent conversation message count", async () => {
    const title = `regression-${variables["run.id"]}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { id: "00000000-0000-4000-8000-000000000203", is_pinned: true },
              {
                id: conversationId,
                title,
                is_pinned: false,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { items: [] },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.assert-recent",
        environment,
        {
          ...credentials,
          conversationId,
          title: "regression-${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      conversationId,
      listed: true,
      recentPosition: 1,
      messageCount: 0,
      messageCountSource: "conversation-history",
    });
    expect(fetcher.mock.calls[2]?.[0]).toMatchObject({
      href: `http://192.168.110.136/trade/api/conversations/${conversationId}/messages?page=1&per_page=100`,
    });
  });

  it("fails when recent conversation history has a different message count", async () => {
    const title = `regression-${variables["run.id"]}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [{ id: conversationId, title, is_pinned: false }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { items: [{ role: "user" }] },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.assert-recent",
        environment,
        {
          ...credentials,
          conversationId,
          title: "regression-${run.id}",
          expectedMessageCount: 2,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_RECENT_CONVERSATION_MESSAGE_COUNT_FAILED",
        classification: "product_failed",
      },
    });
  });

  it("records bounded structured evidence for a complete chat stream without leaking content", async () => {
    const marker = `spark-x-chat-${variables["run.id"]}`;
    const finalContent = `已收到：${marker}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(
        sseResponse([
          {
            event: "conversation_id",
            data: { conversation_id: conversationId },
          },
          { event: "status", data: { phase: "running" } },
          { event: "assistant_preview", data: { content: "preview" } },
          { event: "content", data: { content: "已收到：" } },
          { event: "content", data: { content: marker } },
          {
            event: "done",
            data: {
              final_content: finalContent,
              truncated: false,
              stop_reason: "stop",
              duration_ms: 321,
            },
          },
        ]),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/chat.ask",
      environment,
      {
        ...credentials,
        conversationId,
        message: "自动化回归标识 spark-x-chat-${run.id}。请只回复这个标识。",
        expectedText: "spark-x-chat-${run.id}",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      conversationId,
      done: true,
      expectedTextMatched: true,
      contentEventCount: 2,
      statusEventCount: 1,
      assistantPreviewEventCount: 1,
      toolEventCount: 0,
      skillEventCount: 0,
      reviewEventCount: 0,
      streamBytes: output.streamBytes,
      streamedContentLength: finalContent.length,
      finalContentLength: finalContent.length,
      finalContentSha256: createHash("sha256").update(finalContent).digest("hex"),
      truncated: false,
      stopReason: "stop",
      durationMs: 321,
    });
    expect(typeof output.streamBytes).toBe("number");
    expect(output.streamBytes).toBeGreaterThan(0);
    const chatHeaders = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(chatHeaders.get("authorization")).toBe("Bearer memory-only-access-token-value");
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        message: `自动化回归标识 ${marker}。请只回复这个标识。`,
        conversation_id: conversationId,
      }),
    );
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(finalContent);
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("fails with a stable product error when the chat stream has no terminal event", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(
        sseResponse([
          {
            event: "conversation_id",
            data: { conversation_id: conversationId },
          },
          { event: "content", data: { content: "partial" } },
        ]),
      );

    let caught: unknown;
    try {
      await executeSparkXAgentAction(
        "adapter:spark-x-agent/chat.ask",
        environment,
        {
          ...credentials,
          conversationId,
          message: "spark-x-chat-${run.id}",
          expectedText: "spark-x-chat-${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutorFailure);
    if (!(caught instanceof ExecutorFailure)) throw new Error("expected ExecutorFailure");
    expect(caught.failure).toMatchObject({
      code: "SPARK_X_AGENT_CHAT_STREAM_INCOMPLETE",
      classification: "product_failed",
    });
  });

  it("rejects a chat stream that exceeds the bounded evidence limit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        new Response("x".repeat(1_000_001), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/chat.ask",
        environment,
        {
          ...credentials,
          conversationId,
          message: "spark-x-chat-${run.id}",
          expectedText: "spark-x-chat-${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CHAT_STREAM_TOO_LARGE",
        classification: "product_failed",
      },
    });
  });

  it("revalidates a chat redirect before resending the in-memory token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "http://attacker.invalid/collect" },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/chat.ask",
        environment,
        {
          ...credentials,
          conversationId,
          message: "spark-x-chat-${run.id}",
          expectedText: "spark-x-chat-${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({ failure: { code: "TARGET_NOT_ALLOWED" } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("propagates run cancellation through the chat stream with a stable classification", async () => {
    const controller = new AbortController();
    let notifyChatStarted: (() => void) | undefined;
    const chatStarted = new Promise<void>((resolve) => {
      notifyChatStarted = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockImplementationOnce((_input, init) => {
        notifyChatStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
            { once: true },
          );
        });
      });

    const execution = executeSparkXAgentAction(
      "adapter:spark-x-agent/chat.ask",
      environment,
      {
        ...credentials,
        conversationId,
        message: "spark-x-chat-${run.id}",
        expectedText: "spark-x-chat-${run.id}",
      },
      variables,
      { timeoutMs: 5_000, signal: controller.signal, fetcher },
    );
    await chatStarted;
    controller.abort(new Error("Run cancellation requested"));

    await expect(execution).rejects.toMatchObject({
      failure: { code: "EXECUTION_CANCELLED", classification: "environment_failed" },
    });
  });

  it("matches the persisted chat history to the streamed final-content hash", async () => {
    const marker = `spark-x-chat-${variables["run.id"]}`;
    const userContent = `自动化回归标识 ${marker}。请只回复这个标识。`;
    const assistantContent = marker;
    const assistantHash = createHash("sha256").update(assistantContent).digest("hex");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { role: "user", content: userContent, payload_truncated: false },
              {
                role: "assistant",
                content: assistantContent,
                payload_truncated: false,
                finish_reason: "stop",
                turn_status: "completed",
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/chat.assert-history",
        environment,
        {
          ...credentials,
          conversationId,
          expectedUserText: "自动化回归标识 spark-x-chat-${run.id}。请只回复这个标识。",
          expectedAssistantText: "spark-x-chat-${run.id}",
          expectedAssistantSha256: assistantHash,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      conversationId,
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      assistantContentLength: assistantContent.length,
      assistantContentSha256: assistantHash,
      assistantFinishReason: "stop",
      assistantTurnStatus: "completed",
    });
  });

  it("matches two streamed turns to persisted context history and rejects cross-conversation text", async () => {
    const marker = `spark-x-context-${variables["run.id"]}`;
    const forbidden = `spark-x-decoy-${variables["run.id"]}`;
    const firstUser = `请记住上下文标识 ${marker}，并只回复这个标识。`;
    const firstAssistant = marker;
    const secondUser = `请只回复上一轮的上下文标识；本轮校验号 ${variables["run.id"]}。`;
    const secondAssistant = marker;
    const firstHash = createHash("sha256").update(firstAssistant).digest("hex");
    const secondHash = createHash("sha256").update(secondAssistant).digest("hex");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                role: "assistant",
                content: secondAssistant,
                payload_truncated: false,
                finish_reason: "stop",
              },
              { role: "user", content: secondUser, payload_truncated: false },
              {
                role: "assistant",
                content: firstAssistant,
                payload_truncated: false,
                finish_reason: "stop",
              },
              { role: "user", content: firstUser, payload_truncated: false },
            ],
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/chat.assert-context-history",
      environment,
      {
        ...credentials,
        conversationId,
        firstUserText: "请记住上下文标识 spark-x-context-${run.id}，并只回复这个标识。",
        firstAssistantSha256: firstHash,
        secondUserText: "请只回复上一轮的上下文标识；本轮校验号 ${run.id}。",
        secondExpectedText: "spark-x-context-${run.id}",
        secondAssistantSha256: secondHash,
        forbiddenText: "spark-x-decoy-${run.id}",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      conversationId,
      messageCount: 4,
      userMessageCount: 2,
      assistantMessageCount: 2,
      toolMessageCount: 0,
      expectedOrderMatched: true,
      firstAssistantHashMatched: true,
      secondAssistantHashMatched: true,
      secondExpectedTextMatched: true,
      forbiddenTextAbsent: true,
      firstAssistantContentSha256: firstHash,
      secondAssistantContentSha256: secondHash,
      assistantFinishReasonsMatched: true,
    });
    expect(JSON.stringify(output)).not.toContain(marker);
    expect(JSON.stringify(output)).not.toContain(forbidden);
    expect(JSON.stringify(output)).not.toContain("memory-only-access-token-value");
  });

  it("fails two-turn context history when the main conversation contains the decoy marker", async () => {
    const marker = `spark-x-context-${variables["run.id"]}`;
    const forbidden = `spark-x-decoy-${variables["run.id"]}`;
    const firstUser = `请记住上下文标识 ${marker}，并只回复这个标识。`;
    const secondUser = `请只回复上一轮的上下文标识；本轮校验号 ${variables["run.id"]}。`;
    const contaminated = `${marker} ${forbidden}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { role: "user", content: firstUser, payload_truncated: false },
              {
                role: "assistant",
                content: marker,
                payload_truncated: false,
                finish_reason: "stop",
              },
              { role: "user", content: secondUser, payload_truncated: false },
              {
                role: "assistant",
                content: contaminated,
                payload_truncated: false,
                finish_reason: "stop",
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/chat.assert-context-history",
        environment,
        {
          ...credentials,
          conversationId,
          firstUserText: "请记住上下文标识 spark-x-context-${run.id}，并只回复这个标识。",
          firstAssistantSha256: createHash("sha256").update(marker).digest("hex"),
          secondUserText: "请只回复上一轮的上下文标识；本轮校验号 ${run.id}。",
          secondExpectedText: "spark-x-context-${run.id}",
          secondAssistantSha256: createHash("sha256").update(contaminated).digest("hex"),
          forbiddenText: "spark-x-decoy-${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CONTEXT_CROSS_TALK_FAILED",
        classification: "product_failed",
      },
    });
  });

  it("asserts the credential-free builtin demo catalog without returning raw schemas", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                id: "00000000-0000-4000-8000-000000000210",
                name: "builtin-demo",
                is_enabled: true,
                status: "running",
                tools_count: 3,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                name: "time",
                is_enabled: true,
                is_discovered: true,
                is_write: false,
                requires_review: false,
                risk_level: "low",
                input_schema: { type: "object" },
              },
              {
                name: "calculator",
                is_enabled: true,
                is_discovered: true,
                is_write: false,
                requires_review: null,
                risk_level: "read",
                input_schema: { type: "object" },
              },
              {
                name: "echo",
                is_enabled: true,
                is_discovered: true,
                is_write: false,
                requires_review: false,
                risk_level: "low",
                input_schema: { type: "object" },
              },
            ],
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/tool.assert-safe-catalog",
      environment,
      credentials,
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      serverName: "builtin-demo",
      visible: true,
      running: true,
      credentialFieldsAbsent: true,
      advertisedToolCount: 3,
      enabledDiscoveredToolCount: 3,
      expectedToolsMatched: true,
      catalogSha256: hashCanonical(["calculator", "echo", "time"]),
    });
    expect(urlOf(fetcher.mock.calls[1]?.[0] as URL | RequestInfo)).toBe(
      "http://192.168.110.136/trade/api/mcp/servers",
    );
    expect(urlOf(fetcher.mock.calls[2]?.[0] as URL | RequestInfo)).toBe(
      "http://192.168.110.136/trade/api/admin/mcp/servers/00000000-0000-4000-8000-000000000210/tools",
    );
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("input_schema");
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("classifies a stopped safe-tool fixture as an environment failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { items: [] } }));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.assert-safe-catalog",
        environment,
        credentials,
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_SAFE_TOOL_CATALOG_UNAVAILABLE",
        classification: "environment_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the user catalog leaks an administrator field", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                id: "00000000-0000-4000-8000-000000000210",
                name: "builtin-demo",
                is_enabled: true,
                status: "running",
                tools_count: 3,
                env: { TOKEN: "must-not-cross-boundary" },
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.assert-safe-catalog",
        environment,
        credentials,
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TOOL_CATALOG_LEAKED_PRIVATE_FIELDS",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("matches one safe tool call, arguments, result and final answer without leaking payloads", async () => {
    const marker = `spark-x-tool-${variables["run.id"]}:42`;
    const message = `回归 ${variables["run.id"]}：只调用一次计算器计算 6×7，再回复 ${marker}`;
    const argumentsValue = { operation: "multiply", a: 6, b: 7 };
    const resultValue = { success: true, operation: "multiply", a: 6, b: 7, result: 42 };
    const finalContent = `结果为 ${marker}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { event: "conversation_id", data: { conversation_id: conversationId } },
          {
            event: "tool_call",
            data: {
              id: "call-safe-1",
              name: "builtin-demo__calculator",
              arguments: JSON.stringify({ b: 7, operation: "multiply", a: 6 }),
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-safe-1",
              name: "builtin-demo__calculator",
              result: resultValue,
              success: true,
            },
          },
          { event: "content", data: { content: finalContent } },
          {
            event: "done",
            data: { final_content: finalContent, truncated: false, stop_reason: "stop" },
          },
        ]),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/tool.invoke-safe",
      environment,
      {
        ...credentials,
        conversationId,
        message: "回归 ${run.id}：只调用一次计算器计算 6×7，再回复 spark-x-tool-${run.id}:42",
        expectedText: "spark-x-tool-${run.id}:42",
        expectedToolName: "builtin-demo__calculator",
        expectedArgumentsJson: JSON.stringify(argumentsValue),
        expectedResultJson: JSON.stringify(resultValue),
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      conversationId,
      done: true,
      expectedTextMatched: true,
      expectedToolNameMatched: true,
      argumentsMatched: true,
      resultMatched: true,
      toolCallCount: 1,
      toolResultCount: 1,
      reviewEventCount: 0,
      toolCallIdSha256: createHash("sha256").update("call-safe-1").digest("hex"),
      argumentsSha256: hashCanonical(argumentsValue),
      resultSha256: hashCanonical(resultValue),
      finalContentLength: finalContent.length,
      finalContentSha256: createHash("sha256").update(finalContent).digest("hex"),
      streamBytes: output.streamBytes,
      truncated: false,
    });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ message, conversation_id: conversationId }),
    );
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("multiply");
    expect(serialized).not.toContain('"result":42');
    expect(serialized).not.toContain(finalContent);
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("rejects a malformed tool result event with a stable product failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { event: "conversation_id", data: { conversation_id: conversationId } },
          {
            event: "tool_call",
            data: {
              id: "call-safe-1",
              name: "builtin-demo__calculator",
              arguments: { operation: "multiply", a: 6, b: 7 },
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-safe-1",
              name: "builtin-demo__calculator",
              result: { success: true, result: 42 },
            },
          },
        ]),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.invoke-safe",
        environment,
        {
          ...credentials,
          conversationId,
          message: "回归 ${run.id} 调用安全计算器",
          expectedText: "42",
          expectedToolName: "builtin-demo__calculator",
          expectedArgumentsJson: '{"operation":"multiply","a":6,"b":7}',
          expectedResultJson: '{"success":true,"result":42}',
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TOOL_TRACE_INVALID",
        classification: "product_failed",
      },
    });
  });

  it("links persisted tool history and public trace to the stream hashes", async () => {
    const marker = `spark-x-tool-${variables["run.id"]}:42`;
    const userContent = `回归 ${variables["run.id"]} 调用计算器并回复 ${marker}`;
    const assistantContent = `结果为 ${marker}`;
    const argumentsValue = { operation: "multiply", a: 6, b: 7 };
    const resultValue = { success: true, operation: "multiply", a: 6, b: 7, result: 42 };
    const argumentsHash = hashCanonical(argumentsValue);
    const resultHash = hashCanonical(resultValue);
    const assistantHash = createHash("sha256").update(assistantContent).digest("hex");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { role: "user", content: userContent, payload_truncated: false },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-safe-1",
                    type: "function",
                    function: {
                      name: "builtin-demo__calculator",
                      arguments: JSON.stringify({ b: 7, a: 6, operation: "multiply" }),
                    },
                  },
                ],
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_call",
                    id: "call-safe-1",
                    name: "builtin-demo__calculator",
                    arguments: argumentsValue,
                  },
                ],
              },
              {
                role: "tool",
                content: JSON.stringify(resultValue),
                tool_call_id: "call-safe-1",
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_result",
                    id: "call-safe-1",
                    name: "builtin-demo__calculator",
                    result: resultValue,
                    success: true,
                  },
                ],
              },
              {
                role: "assistant",
                content: assistantContent,
                finish_reason: "stop",
                payload_truncated: false,
                public_execution_trace: [{ kind: "terminal", status: "completed" }],
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.assert-history",
        environment,
        {
          ...credentials,
          conversationId,
          expectedUserText: "回归 ${run.id} 调用计算器并回复 spark-x-tool-${run.id}:42",
          expectedAssistantText: "spark-x-tool-${run.id}:42",
          expectedAssistantSha256: assistantHash,
          expectedToolName: "builtin-demo__calculator",
          expectedArgumentsSha256: argumentsHash,
          expectedResultSha256: resultHash,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      conversationId,
      messageCount: 4,
      userMessageCount: 1,
      assistantMessageCount: 2,
      toolMessageCount: 1,
      toolCallCount: 1,
      toolResultCount: 1,
      traceToolCallCount: 1,
      traceToolResultCount: 1,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      expectedToolNameMatched: true,
      argumentsSha256: argumentsHash,
      resultSha256: resultHash,
      assistantContentLength: assistantContent.length,
      assistantContentSha256: assistantHash,
      assistantFinishReason: "stop",
    });
  });

  it("creates a traceable private knowledge base with only hashed name evidence", async () => {
    const name = `spark-x-kb-${variables["run.id"]}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: knowledgeBaseId,
            name,
            status: "active",
            visibility: "private",
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/knowledge-base.create",
      environment,
      {
        ...credentials,
        name: "spark-x-kb-${run.id}",
        description: "fixed fixture",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      knowledgeBaseId,
      created: true,
      active: true,
      nameSha256: createHash("sha256").update(name).digest("hex"),
    });
    expect(urlOf(fetcher.mock.calls[1]?.[0] as URL | RequestInfo)).toBe(
      "http://192.168.110.136/trade-domain-api/knowledge-bases",
    );
    expect(JSON.stringify(output)).not.toContain(name);
  });

  it("uploads only the built-in PDF fixture and returns bounded hash evidence", async () => {
    let uploadedBytes: Uint8Array | undefined;
    let uploadedName: string | undefined;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const form = init?.body;
        expect(form).toBeInstanceOf(FormData);
        if (!(form instanceof FormData)) throw new Error("expected multipart form");
        const rawMetadata = form.get("metadata");
        const file = form.get("file");
        expect(typeof rawMetadata).toBe("string");
        expect(file).toBeInstanceOf(Blob);
        if (typeof rawMetadata !== "string" || !(file instanceof Blob)) {
          throw new Error("expected fixed fixture multipart body");
        }
        const metadata = JSON.parse(rawMetadata) as Readonly<Record<string, unknown>>;
        uploadedBytes = new Uint8Array(await file.arrayBuffer());
        uploadedName = (file as Blob & { readonly name?: string }).name;
        const contentSha256 = createHash("sha256").update(uploadedBytes).digest("hex");
        expect(metadata).toEqual({
          filename: uploadedName,
          mime_type: "application/pdf",
          size_bytes: uploadedBytes.byteLength,
          sha256: contentSha256,
          conversation_id: null,
          folder_id: null,
        });
        return jsonResponse({
          success: true,
          data: {
            id: uploadedDocumentId,
            name: uploadedName,
            size_bytes: uploadedBytes.byteLength,
            content_sha256: contentSha256,
          },
        });
      });

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/knowledge-base.upload-fixture",
      environment,
      { ...credentials, knowledgeBaseId },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(urlOf(fetcher.mock.calls[1]?.[0] as URL | RequestInfo)).toBe(
      "http://192.168.110.136/trade/api/documents/upload",
    );
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("idempotency-key")).toBe(
      knowledgeBaseId,
    );
    expect(uploadedName).toBe(`spark-x-kb-${knowledgeBaseId}.pdf`);
    expect(new TextDecoder().decode(uploadedBytes)).toContain("SPARK_X_KB_FIXTURE");
    expect(output).toMatchObject({
      knowledgeBaseId,
      uploadedDocumentId,
      uploaded: true,
      fixtureSizeBytes: uploadedBytes?.byteLength,
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("SPARK_X_KB_FIXTURE");
    expect(serialized).not.toContain("B2C-KB-001");
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("revalidates a fixture upload redirect before resending credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "http://attacker.invalid/collect" },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.upload-fixture",
        environment,
        { ...credentials, knowledgeBaseId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: { code: "TARGET_NOT_ALLOWED", classification: "test_failed" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the signed parser source in memory while attaching the uploaded fixture", async () => {
    const signedSource =
      "http://192.168.110.136:9000/parser/source.pdf?X-Amz-Signature=secret-value";
    const title = `spark-x-kb-${variables["run.id"]}.pdf`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { document_id: uploadedDocumentId, url: signedSource },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: knowledgeDocumentId,
            knowledge_base_id: knowledgeBaseId,
            rust_document_id: uploadedDocumentId,
            title,
            status: "pending",
            parse_job_id: "parse-job-1",
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/knowledge-base.attach-upload",
      environment,
      {
        ...credentials,
        knowledgeBaseId,
        uploadedDocumentId,
        title: "spark-x-kb-${run.id}.pdf",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    const attachBody = fetcher.mock.calls[2]?.[1]?.body;
    expect(typeof attachBody).toBe("string");
    if (typeof attachBody !== "string") throw new Error("expected JSON attach body");
    expect(JSON.parse(attachBody)).toEqual({
      rust_document_id: uploadedDocumentId,
      source_url: signedSource,
      title,
      metadata: { fixture: "spark-x-test-platform" },
    });
    expect(output).toMatchObject({
      knowledgeBaseId,
      knowledgeDocumentId,
      uploadedDocumentId,
      attached: true,
      parseJobPresent: true,
      documentStatus: "pending",
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(signedSource);
    expect(serialized).not.toContain("secret-value");
  });

  it("links the completed knowledge version to the fixed upload hash", async () => {
    const fixtureSha256 = "a".repeat(64);
    const title = `spark-x-kb-${variables["run.id"]}.pdf`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: knowledgeDocumentId,
            knowledge_base_id: knowledgeBaseId,
            title,
            status: "completed",
            current_version_id: "parser-version-1",
            current_version_number: 1,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: knowledgeBaseId,
            status: "active",
            document_count: 1,
            ready_document_count: 1,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                knowledge_document_id: knowledgeDocumentId,
                version_number: 1,
                status: "completed",
                content_hash: fixtureSha256,
                parser_version_id: "parser-version-1",
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.wait-ready",
        environment,
        {
          ...credentials,
          knowledgeBaseId,
          knowledgeDocumentId,
          expectedFixtureSha256: fixtureSha256,
          expectedTitle: "spark-x-kb-${run.id}.pdf",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
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
      fixtureSha256,
      pollAttempts: 1,
    });
  });

  it("binds one ready knowledge base and replays the exact immutable snapshot", async () => {
    const fixtureSha256 = "a".repeat(64);
    const scopeHash = "b".repeat(64);
    const snapshotHash = "c".repeat(64);
    const clientRequestId = variables["run.id"];
    const knowledgeBase = {
      id: knowledgeBaseId,
      name: "sensitive fixture title",
      status: "active",
      document_count: 1,
      ready_document_count: 1,
    };
    const savedScope = {
      id: knowledgeScopeId,
      conversation_id: conversationId,
      retrieval_policy: "required",
      status: "active",
      revision: 1,
      scope_hash: scopeHash,
      knowledge_base_ids: [knowledgeBaseId],
      knowledge_bases: [knowledgeBase],
      created_at: "2026-08-15T04:00:00.000Z",
      updated_at: "2026-08-15T04:00:00.000Z",
    };
    const snapshot = {
      id: knowledgeSnapshotId,
      conversation_id: conversationId,
      scope_id: knowledgeScopeId,
      scope_revision: 1,
      scope_hash: scopeHash,
      client_request_id: clientRequestId,
      turn_id: null,
      retrieval_policy: "required",
      status: "prepared",
      snapshot_hash: snapshotHash,
      knowledge_base_count: 1,
      ready_document_count: 1,
      excluded_document_count: 0,
      documents: [
        {
          knowledge_base_id: knowledgeBaseId,
          knowledge_document_id: knowledgeDocumentId,
          knowledge_version_id: knowledgeVersionId,
          rust_document_id: uploadedDocumentId,
          parser_document_id: "parser-document-secret",
          parser_version_id: "parser-version-secret",
          version_number: 1,
          title: "sensitive fixture title",
          source_filename: "sensitive-fixture.pdf",
          content_hash: fixtureSha256,
        },
      ],
      expires_at: "2026-08-16T04:00:00.000Z",
      attached_at: null,
      consumed_at: null,
      created_at: "2026-08-15T04:00:00.000Z",
      updated_at: "2026-08-15T04:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: null,
            conversation_id: conversationId,
            retrieval_policy: "auto",
            status: "active",
            revision: 0,
            scope_hash: null,
            knowledge_base_ids: [],
            knowledge_bases: [],
            created_at: null,
            updated_at: null,
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: savedScope }))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { ...snapshot, idempotent_replay: false } }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { ...snapshot, idempotent_replay: true } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: savedScope }));

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
      environment,
      {
        ...credentials,
        conversationId,
        knowledgeBaseId,
        knowledgeDocumentId,
        expectedFixtureSha256: fixtureSha256,
        clientRequestId: "${run.id}",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    const requests = fetcher.mock.calls.slice(1).map((call) => ({
      url: urlOf(call[0] as URL | RequestInfo),
      method: call[1]?.method,
      headers: new Headers(call[1]?.headers),
      body: typeof call[1]?.body === "string" ? (JSON.parse(call[1].body) as unknown) : undefined,
    }));
    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: `http://192.168.110.136/trade-domain-api/conversations/${conversationId}/knowledge-scope`,
        method: "GET",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/conversations/${conversationId}/knowledge-scope`,
        method: "PUT",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/conversations/${conversationId}/document-context-snapshots`,
        method: "POST",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/conversations/${conversationId}/document-context-snapshots`,
        method: "POST",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/conversations/${conversationId}/knowledge-scope`,
        method: "GET",
      },
    ]);
    expect(requests[1]?.body).toEqual({
      knowledge_base_ids: [knowledgeBaseId],
      retrieval_policy: "required",
      expected_revision: 0,
    });
    for (const request of requests.slice(2, 4)) {
      expect(request.headers.get("idempotency-key")).toBe(clientRequestId);
      expect(request.body).toEqual({
        client_request_id: clientRequestId,
        expected_scope_revision: 1,
        expected_scope_hash: scopeHash,
      });
    }
    expect(output).toEqual({
      conversationId,
      knowledgeBaseId,
      knowledgeDocumentId,
      retrievalPolicy: "required",
      scopeRevision: 1,
      scopeHash,
      scopeKnowledgeBaseCount: 1,
      scopeDocumentCount: 1,
      scopeReadyDocumentCount: 1,
      snapshotId: knowledgeSnapshotId,
      snapshotStatus: "prepared",
      snapshotHash,
      snapshotKnowledgeBaseCount: 1,
      snapshotReadyDocumentCount: 1,
      snapshotExcludedDocumentCount: 0,
      snapshotDocumentCount: 1,
      scopeMatched: true,
      documentMatched: true,
      contentHashMatched: true,
      firstCreated: true,
      idempotentReplay: true,
      snapshotIdentityMatched: true,
      scopeStable: true,
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("sensitive fixture title");
    expect(serialized).not.toContain("sensitive-fixture.pdf");
    expect(serialized).not.toContain("parser-document-secret");
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("preserves a snapshot replay identity mismatch as the root test failure", async () => {
    const fixtureSha256 = "a".repeat(64);
    const scopeHash = "b".repeat(64);
    const snapshotHash = "c".repeat(64);
    const clientRequestId = variables["run.id"];
    const savedScope = {
      conversation_id: conversationId,
      retrieval_policy: "required",
      status: "active",
      revision: 1,
      scope_hash: scopeHash,
      knowledge_base_ids: [knowledgeBaseId],
      knowledge_bases: [
        {
          id: knowledgeBaseId,
          status: "active",
          document_count: 1,
          ready_document_count: 1,
        },
      ],
    };
    const snapshot = {
      id: knowledgeSnapshotId,
      conversation_id: conversationId,
      scope_id: knowledgeScopeId,
      scope_revision: 1,
      scope_hash: scopeHash,
      client_request_id: clientRequestId,
      retrieval_policy: "required",
      status: "prepared",
      snapshot_hash: snapshotHash,
      knowledge_base_count: 1,
      ready_document_count: 1,
      excluded_document_count: 0,
      documents: [
        {
          knowledge_base_id: knowledgeBaseId,
          knowledge_document_id: knowledgeDocumentId,
          knowledge_version_id: knowledgeVersionId,
          rust_document_id: uploadedDocumentId,
          parser_document_id: "parser-document-1",
          parser_version_id: "parser-version-1",
          version_number: 1,
          content_hash: fixtureSha256,
        },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            conversation_id: conversationId,
            retrieval_policy: "auto",
            status: "active",
            revision: 0,
            scope_hash: null,
            knowledge_base_ids: [],
            knowledge_bases: [],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: savedScope }))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { ...snapshot, idempotent_replay: false } }, 201),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            ...snapshot,
            id: "00000000-0000-4000-8000-000000000299",
            idempotent_replay: true,
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.assert-conversation-scope",
        environment,
        {
          ...credentials,
          conversationId,
          knowledgeBaseId,
          knowledgeDocumentId,
          expectedFixtureSha256: fixtureSha256,
          clientRequestId: "${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_SNAPSHOT_REPLAY_ASSERTION_FAILED",
        classification: "test_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("classifies parser runtime failures as environment failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false }, 500));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.wait-ready",
        environment,
        {
          ...credentials,
          knowledgeBaseId,
          knowledgeDocumentId,
          expectedFixtureSha256: "a".repeat(64),
          expectedTitle: "spark-x-kb-${run.id}.pdf",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_REFRESH_FAILED",
        classification: "environment_failed",
      },
    });
  });

  it("deletes knowledge documents and raw upload before archiving the registered base", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { items: [{ id: knowledgeDocumentId, status: "completed" }] },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: {} }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            id: uploadedDocumentId,
            name: "fixture.pdf",
            size_bytes: 100,
            content_sha256: "a".repeat(64),
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: {} }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: {} }));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.cleanup",
        environment,
        { ...credentials, knowledgeBaseId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      knowledgeBaseId,
      cleaned: true,
      knowledgeDocumentDeleteCount: 1,
      rawDocumentDeleted: true,
      knowledgeBaseArchived: true,
    });
    expect(
      fetcher.mock.calls.slice(1).map((call) => ({
        url: urlOf(call[0] as URL | RequestInfo),
        method: call[1]?.method,
      })),
    ).toEqual([
      {
        url: `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents?include_archived=true`,
        method: "GET",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents/${knowledgeDocumentId}`,
        method: "DELETE",
      },
      {
        url: `http://192.168.110.136/trade/api/documents/upload-status/${knowledgeBaseId}`,
        method: "GET",
      },
      {
        url: `http://192.168.110.136/trade/api/documents/${uploadedDocumentId}`,
        method: "DELETE",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}`,
        method: "DELETE",
      },
    ]);
  });

  it("creates an immediate no-Skill automation with only hashed goal evidence", async () => {
    const nextFireAt = new Date().toISOString();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          definition_id: automationId,
          state_version: 1,
          status: "enabled",
          next_fire_at: nextFireAt,
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/automation.create",
      environment,
      {
        ...credentials,
        conversationId,
        name: "spark-x-auto-${run.id}",
        goal: "自动任务回归标识 spark-x-auto-${run.id}。请只回复这个标识，不要调用任何工具或 Skill。",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      automationId,
      conversationId,
      created: true,
      enabled: true,
      stateVersion: 1,
      intervalSeconds: 300,
      selectedSkillAbsent: true,
      nextFireAt,
      nameSha256: createHash("sha256").update(automationName).digest("hex"),
      goalSha256: createHash("sha256").update(automationGoal).digest("hex"),
    });
    const request = fetcher.mock.calls[1]?.[1];
    const requestBody = request?.body;
    if (typeof requestBody !== "string") throw new Error("expected JSON request body");
    const body = JSON.parse(requestBody) as Readonly<Record<string, unknown>>;
    expect(body).toMatchObject({
      conversation_id: conversationId,
      name: automationName,
      goal: automationGoal,
      selected_skill_id: null,
      interval_seconds: 300,
    });
    expect(Date.parse(String(body.first_fire_at))).toBeGreaterThan(Date.now() - 2_000);
    expect(JSON.stringify(output)).not.toContain(automationGoal);
    expect(JSON.stringify(output)).not.toContain("memory-only-access-token-value");
    expect(JSON.stringify(output)).not.toContain(variables["case.admin-password"]);
  });

  it("links one scheduler fire to one no-tool conversation turn without returning content", async () => {
    const assistantContent = `已完成：${automationMarker}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [automationProjection()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { role: "user", content: automationGoal, payload_truncated: false },
              {
                role: "assistant",
                content: assistantContent,
                finish_reason: "stop",
                tool_calls: [],
                public_execution_trace: [],
                payload_truncated: false,
              },
            ],
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/automation.wait-fired",
      environment,
      {
        ...credentials,
        automationId,
        conversationId,
        expectedName: "spark-x-auto-${run.id}",
        expectedGoal:
          "自动任务回归标识 spark-x-auto-${run.id}。请只回复这个标识，不要调用任何工具或 Skill。",
        expectedAssistantText: "spark-x-auto-${run.id}",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      automationId,
      conversationId,
      fired: true,
      singleFireObserved: true,
      enabled: true,
      stateVersion: 2,
      lastFireAt: "2026-08-15T04:00:00.000Z",
      nextFireAt: "2026-08-15T04:05:00.000Z",
      scheduleAdvancedBySeconds: 300,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolMessageCount: 0,
      toolCallCount: 0,
      toolTraceEventCount: 0,
      userContentSha256: createHash("sha256").update(automationGoal).digest("hex"),
      assistantContentSha256: createHash("sha256").update(assistantContent).digest("hex"),
      assistantContentLength: assistantContent.length,
      selectedSkillAbsent: true,
      expectedAssistantTextMatched: true,
      assistantFinishReason: "stop",
      pollAttempts: 1,
    });
    const evidence = JSON.stringify(output);
    expect(evidence).not.toContain(automationGoal);
    expect(evidence).not.toContain(assistantContent);
    expect(evidence).not.toContain("memory-only-access-token-value");
  });

  it("rejects duplicate scheduler turns as a stable product failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [automationProjection()] }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { role: "user", content: automationGoal },
              { role: "assistant", content: automationMarker, finish_reason: "stop" },
              { role: "user", content: automationGoal },
              { role: "assistant", content: automationMarker, finish_reason: "stop" },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/automation.wait-fired",
        environment,
        {
          ...credentials,
          automationId,
          conversationId,
          expectedName: automationName,
          expectedGoal: automationGoal,
          expectedAssistantText: automationMarker,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_AUTOMATION_SINGLE_FIRE_FAILED",
        classification: "product_failed",
      },
    });
  });

  it("refreshes the optimistic state version before idempotent automation cleanup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [automationProjection({ state_version: 4 })] }))
      .mockResolvedValueOnce(
        jsonResponse({
          definition_id: automationId,
          state_version: 5,
          status: "disabled",
          next_fire_at: null,
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/automation.cleanup",
        environment,
        { ...credentials, automationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      automationId,
      cleaned: true,
      deleted: true,
      conflictCount: 0,
      deletedStateVersion: 5,
    });
    const request = fetcher.mock.calls[2]?.[1];
    expect(request?.method).toBe("DELETE");
    const requestBody = request?.body;
    if (typeof requestBody !== "string") throw new Error("expected JSON request body");
    expect(JSON.parse(requestBody)).toEqual({ expected_version: 4 });
  });

  it("treats an absent automation as successful idempotent cleanup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [] }));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/automation.cleanup",
        environment,
        { ...credentials, automationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      automationId,
      cleaned: true,
      deleted: false,
      conflictCount: 0,
      alreadyMissing: true,
    });
  });

  it("classifies an unavailable automation runtime as an environment failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { code: "unavailable" } }, 503));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/automation.create",
        environment,
        {
          ...credentials,
          conversationId,
          name: automationName,
          goal: automationGoal,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_AUTOMATION_CREATE_FAILED",
        classification: "environment_failed",
      },
    });
  });

  it("matches a trusted Skill across user and admin projections without returning its prompt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: [trustedSkillProjection(skillPrompt, false)] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: trustedSkillProjection(skillPrompt, false) }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [trustedSkillProjection(skillPrompt, false)],
            total: 1,
            page: 1,
            per_page: 100,
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/skill.assert-trusted-publication",
      environment,
      { ...credentials, expectedPublicationSha256: skillPromptSha256 },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      skillId,
      skillName: "trade-port-daily-brief",
      available: true,
      enabled: true,
      builtin: false,
      durableAgentTask: true,
      userAdminProjectionMatched: true,
      publicationHashMatched: true,
      promptSha256: skillPromptSha256,
      promptSizeBytes: new TextEncoder().encode(skillPrompt).byteLength,
      assetRootPresent: false,
      mainAssetPresent: false,
      mainFileSha256: skillPromptSha256,
    });
    expect(fetcher.mock.calls.slice(1).map((call) => urlOf(call[0] as URL | RequestInfo))).toEqual([
      "http://192.168.110.136/trade/api/skills",
      "http://192.168.110.136/trade/api/skills/trade-port-daily-brief",
      "http://192.168.110.136/trade/api/admin/skills?page=1&per_page=100",
    ]);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(skillPrompt);
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("classifies a missing trusted Skill as an environment failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/skill.assert-trusted-publication",
        environment,
        { ...credentials, expectedPublicationSha256: skillPromptSha256 },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TRUSTED_SKILL_UNAVAILABLE",
        classification: "environment_failed",
      },
    });
  });

  it("preserves a trusted Skill publication hash mismatch as a test failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [trustedSkillProjection()] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: trustedSkillProjection() }))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { items: [trustedSkillProjection()], total: 1, page: 1, per_page: 100 },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/skill.assert-trusted-publication",
        environment,
        { ...credentials, expectedPublicationSha256: "a".repeat(64) },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_SKILL_PUBLICATION_HASH_MISMATCH",
        classification: "test_failed",
      },
    });
  });

  it("classifies a trusted Skill runtime 5xx as an environment failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false }, 503));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/skill.assert-trusted-publication",
        environment,
        { ...credentials, expectedPublicationSha256: skillPromptSha256 },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_SKILL_LIST_FAILED",
        classification: "environment_failed",
      },
    });
  });

  it("revalidates redirects before sending credentials to a new target", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://attacker.invalid/collect" },
      }),
    );

    let caught: unknown;
    try {
      await executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.delete",
        environment,
        { ...credentials, conversationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExecutorFailure);
    if (!(caught instanceof ExecutorFailure)) throw new Error("expected ExecutorFailure");
    expect(caught.failure.code).toBe("TARGET_NOT_ALLOWED");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("treats an already missing conversation as successful idempotent cleanup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { token: "memory-only-access-token-value" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false }, 404));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.delete",
        environment,
        { ...credentials, conversationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({ conversationId, deleted: true, alreadyMissing: true });
  });
});
