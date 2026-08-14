import { createHash } from "node:crypto";

import { ExecutorFailure, type HttpExecutionEnvironment } from "@spark-x-test/executors";
import { describe, expect, it, vi } from "vitest";

import { executeSparkXAgentAction, sparkXAgentAdapterManifest } from "./index.js";

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
      version: "0.5.0",
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
            key: "knowledge-base.cleanup",
            actionLevel: "dangerous",
          }),
          expect.objectContaining({
            key: "conversation.delete",
            actionLevel: "dangerous",
          }),
        ],
      },
    });
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

  it("asserts the new conversation at the first non-pinned recent position", async () => {
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
                message_count: 0,
              },
            ],
          },
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
