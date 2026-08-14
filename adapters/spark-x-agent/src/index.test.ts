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
      pathPrefixes: ["/trade/"],
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

describe("spark-x-agent adapter", () => {
  it("declares the controlled conversation capabilities", () => {
    expect(sparkXAgentAdapterManifest).toMatchObject({
      key: "spark-x-agent",
      version: "0.3.0",
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
