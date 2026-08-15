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
    {
      protocol: "http",
      host: "192.168.110.136",
      ports: [18121],
      pathPrefixes: ["/mcp/document"],
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
const secondConversationId = "00000000-0000-4000-8000-000000000203";
const thirdConversationId = "00000000-0000-4000-8000-000000000204";
const cancelledTurnId = "00000000-0000-4000-8000-000000000206";
const resumedTurnId = "00000000-0000-4000-8000-000000000207";
const cancelledMessageId = "00000000-0000-4000-8000-000000000208";
const resumedMessageId = "00000000-0000-4000-8000-000000000209";
const resumedAssistantMessageId = "00000000-0000-4000-8000-00000000020a";
const knowledgeBaseId = "00000000-0000-4000-8000-000000000210";
const uploadedDocumentId = "00000000-0000-4000-8000-000000000211";
const knowledgeDocumentId = "00000000-0000-4000-8000-000000000212";
const knowledgeVersionId = "00000000-0000-4000-8000-000000000215";
const knowledgeScopeId = "00000000-0000-4000-8000-000000000216";
const knowledgeSnapshotId = "00000000-0000-4000-8000-000000000217";
const knowledgeQueryTurnId = "00000000-0000-4000-8000-000000000218";
const knowledgeQueryMessageId = "00000000-0000-4000-8000-000000000219";
const knowledgeQueryAssistantMessageId = "00000000-0000-4000-8000-00000000021a";
const forbiddenKnowledgeBaseId = "00000000-0000-4000-8000-00000000021b";
const forbiddenKnowledgeDocumentId = "00000000-0000-4000-8000-00000000021c";
const knowledgeRetrievalId = "00000000-0000-4000-8000-00000000021d";
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

function kb006TableText(resourceId = knowledgeBaseId): string {
  return [
    "ROW_ID | RUN_RESOURCE_ID | ACCOUNT_CODE | AMOUNT_CNY",
    ...Array.from({ length: 96 }, (_, index) =>
      [
        `KB006-ROW-${String(index + 1).padStart(3, "0")}`,
        resourceId,
        `ACCT-${String(1001 + index)}`,
        String(10_000 + index * 37),
      ].join(" | "),
    ),
  ].join("\n");
}

function kb006ContinuationResponse(
  parserDocumentId: string,
  parserVersionId: string,
  fullText: string,
  pageNumber: number,
  start: number,
  end: number,
  final: boolean,
  nextCursor: string | null,
  overrides: Readonly<Record<string, unknown>> = {},
): Response {
  const text = fullText.slice(start, end);
  return jsonResponse({
    jsonrpc: "2.0",
    id: `spark-x-kb006-page-${pageNumber}`,
    result: {
      content: [],
      isError: false,
      structuredContent: {
        items: [
          {
            unit_id: `tables:${parserDocumentId}:${parserVersionId}:1`,
            kind: "table",
            document_id: parserDocumentId,
            version_id: parserVersionId,
            version_number: 1,
            text,
            text_segment: { start, end, unit_complete: final },
            table_index: 0,
            ...overrides,
          },
        ],
        coverage: {
          requested: "complete",
          source_complete: final,
          total_units: 1,
          completed_units: final ? 1 : 0,
          delivered_chars: end,
        },
        return_budget: {
          max_chars: 1_000,
          used_chars: text.length,
          max_units: 1,
          returned_items: 1,
        },
        has_more: !final,
        next_cursor: nextCursor,
      },
    },
  });
}

describe("spark-x-agent adapter", () => {
  it("declares the controlled conversation capabilities", () => {
    expect(sparkXAgentAdapterManifest).toMatchObject({
      key: "spark-x-agent",
      version: "0.20.0",
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
          expect.objectContaining({
            key: "conversation.rename-and-assert-pagination",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "conversation.assert-deleted-state",
            actionLevel: "read",
          }),
          expect.objectContaining({ key: "chat.ask", producesResource: false }),
          expect.objectContaining({
            key: "chat.cancel-and-resume",
            actionLevel: "write",
          }),
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
            key: "tool.invoke-failure-recovery",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "tool.assert-history",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "tool.assert-failure-recovery-history",
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
            key: "knowledge-base.assert-large-table-continuation",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.assert-conversation-scope",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.query-and-assert-evidence",
            actionLevel: "write",
          }),
          expect.objectContaining({
            key: "knowledge-base.assert-cleaned-state",
            actionLevel: "read",
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
            key: "automation.assert-no-duplicate-delivery",
            actionLevel: "write",
            producesResource: false,
          }),
          expect.objectContaining({
            key: "automation.assert-lifecycle",
            actionLevel: "dangerous",
            producesResource: false,
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
      occurrenceCount: 1,
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

  it("rejects a duplicate recent-list projection before reading history", async () => {
    const title = `regression-${variables["run.id"]}`;
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
              { id: conversationId, title, is_pinned: false },
              { id: conversationId, title, is_pinned: false },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.assert-recent",
        environment,
        { ...credentials, conversationId, title: "regression-${run.id}" },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_RECENT_CONVERSATION_ASSERTION_FAILED",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("renames one run conversation and proves two stable cross-page scans without leaking titles", async () => {
    const title = `renamed-${variables["run.id"]}`;
    const pageOne = {
      success: true,
      data: {
        items: [
          {
            id: conversationId,
            title,
            title_source: "manual",
            is_pinned: false,
          },
          { id: secondConversationId, is_pinned: false },
        ],
        total: 3,
        page: 1,
        per_page: 2,
      },
    };
    const pageTwo = {
      success: true,
      data: {
        items: [{ id: thirdConversationId, is_pinned: false }],
        total: 3,
        page: 2,
        per_page: 2,
      },
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
            id: conversationId,
            title,
            title_source: "manual",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(pageOne))
      .mockResolvedValueOnce(jsonResponse(pageTwo))
      .mockResolvedValueOnce(jsonResponse(pageOne))
      .mockResolvedValueOnce(jsonResponse(pageTwo));

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
      environment,
      {
        ...credentials,
        conversationId,
        title: "renamed-${run.id}",
        expectedOrder: ["${step.renamed-id}", "${step.newest-id}", "${step.middle-id}"],
      },
      {
        ...variables,
        "step.renamed-id": conversationId,
        "step.newest-id": secondConversationId,
        "step.middle-id": thirdConversationId,
      },
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      conversationId,
      renamed: true,
      titleSource: "manual",
      titleSha256: createHash("sha256").update(title).digest("hex"),
      pageSize: 2,
      expectedConversationCount: 3,
      firstSweepPages: 2,
      secondSweepPages: 2,
      distinctExpectedPages: 2,
      duplicateCount: 0,
      missingCount: 0,
      crossPage: true,
      orderStable: true,
    });
    expect(urlOf(fetcher.mock.calls[1]?.[0] as URL | RequestInfo)).toBe(
      `http://192.168.110.136/trade/api/conversations/${conversationId}`,
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(title);
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("preserves the first pagination failure when an item is repeated across pages", async () => {
    const title = `renamed-${variables["run.id"]}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: conversationId, title, title_source: "manual" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { id: conversationId, title, title_source: "manual" },
              { id: secondConversationId },
            ],
            total: 3,
            page: 1,
            per_page: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [{ id: secondConversationId }],
            total: 3,
            page: 2,
            per_page: 2,
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
        environment,
        {
          ...credentials,
          conversationId,
          title: "renamed-${run.id}",
          expectedOrder: [conversationId, secondConversationId, thirdConversationId],
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CONVERSATION_PAGINATION_DUPLICATE",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("fails when a run conversation is omitted by pagination", async () => {
    const title = `renamed-${variables["run.id"]}`;
    const unrelatedConversationId = "00000000-0000-4000-8000-000000000205";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: conversationId, title, title_source: "manual" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { id: conversationId, title, title_source: "manual" },
              { id: secondConversationId },
            ],
            total: 3,
            page: 1,
            per_page: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [{ id: unrelatedConversationId }],
            total: 3,
            page: 2,
            per_page: 2,
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
        environment,
        {
          ...credentials,
          conversationId,
          title: "renamed-${run.id}",
          expectedOrder: [conversationId, secondConversationId, thirdConversationId],
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CONVERSATION_PAGINATION_MISSING",
        classification: "product_failed",
      },
    });
  });

  it("fails when consecutive pagination sweeps move the run conversations", async () => {
    const title = `renamed-${variables["run.id"]}`;
    const unrelatedConversationId = "00000000-0000-4000-8000-000000000205";
    const page = (
      items: readonly Readonly<Record<string, unknown>>[],
      total: number,
      pageNumber: number,
    ) => ({
      success: true,
      data: { items, total, page: pageNumber, per_page: 2 },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: conversationId, title, title_source: "manual" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          page(
            [{ id: conversationId, title, title_source: "manual" }, { id: secondConversationId }],
            3,
            1,
          ),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(page([{ id: thirdConversationId }], 3, 2)))
      .mockResolvedValueOnce(
        jsonResponse(
          page(
            [
              { id: unrelatedConversationId },
              { id: conversationId, title, title_source: "manual" },
            ],
            4,
            1,
          ),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(page([{ id: secondConversationId }, { id: thirdConversationId }], 4, 2)),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
        environment,
        {
          ...credentials,
          conversationId,
          title: "renamed-${run.id}",
          expectedOrder: [conversationId, secondConversationId, thirdConversationId],
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CONVERSATION_PAGINATION_DRIFT",
        classification: "product_failed",
      },
    });
  });

  it("classifies an overfull pagination test account as an environment failure", async () => {
    const title = `renamed-${variables["run.id"]}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: conversationId, title, title_source: "manual" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              { id: conversationId, title, title_source: "manual" },
              { id: secondConversationId },
            ],
            total: 201,
            page: 1,
            per_page: 2,
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.rename-and-assert-pagination",
        environment,
        {
          ...credentials,
          conversationId,
          title: "renamed-${run.id}",
          expectedOrder: [conversationId, secondConversationId, thirdConversationId],
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CONVERSATION_PAGINATION_BOUND_EXCEEDED",
        classification: "environment_failed",
      },
    });
  });

  it("proves a soft-deleted conversation is absent from active and unique in deleted", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            conversation: { id: conversationId, status: "deleted" },
            messages: [],
            message_count: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { items: [], total: 0, page: 1, per_page: 100 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [{ id: conversationId, status: "deleted" }],
            total: 1,
            page: 1,
            per_page: 100,
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.assert-deleted-state",
        environment,
        { ...credentials, conversationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      conversationId,
      detailState: "deleted",
      activeOccurrences: 0,
      deletedOccurrences: 1,
      activePagesScanned: 1,
      deletedPagesScanned: 1,
      uniqueDeletedRecord: true,
    });
    expect(urlOf(fetcher.mock.calls[2]?.[0] as URL | RequestInfo)).toContain(
      "/conversations?page=1&per_page=100&status=active",
    );
    expect(urlOf(fetcher.mock.calls[3]?.[0] as URL | RequestInfo)).toContain(
      "/conversations?page=1&per_page=100&status=deleted",
    );
  });

  it("preserves the deleted-list cardinality failure and accepts a missing detail", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { items: [], total: 0, page: 1, per_page: 100 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [{ id: conversationId }, { id: conversationId }],
            total: 2,
            page: 1,
            per_page: 100,
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.assert-deleted-state",
        environment,
        { ...credentials, conversationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CONVERSATION_DELETE_CARDINALITY_FAILED",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("classifies an overfull conversation status list as an environment failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [],
            total: 1_001,
            page: 1,
            per_page: 100,
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.assert-deleted-state",
        environment,
        { ...credentials, conversationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_CONVERSATION_STATUS_LIST_BOUND_EXCEEDED",
        classification: "environment_failed",
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

  it("cancels one active Turn, records no ghost reply and completes the next Turn", async () => {
    const cancelMessage = `请持续生成长回答，取消标识 ${variables["run.id"]}`;
    const expectedText = `resume-${variables["run.id"]}`;
    const resumeMessage = `取消后续接，只回复 ${expectedText}`;
    const resumedContent = `已恢复：${expectedText}`;
    const runningSnapshot = {
      turn_id: cancelledTurnId,
      conversation_id: conversationId,
      status: "running",
      state_version: 2,
      cancel_requested_at: null,
      finished_at: null,
      assistant_message_id: null,
      finish_reason: null,
      failure_code: null,
      failure_retryable: null,
    };
    const cancelRequestedSnapshot = {
      ...runningSnapshot,
      status: "cancel_requested",
      state_version: 3,
      cancel_requested_at: "2026-08-15T06:00:00.000Z",
    };
    const cancelledSnapshot = {
      ...cancelRequestedSnapshot,
      status: "cancelled",
      state_version: 4,
      finished_at: "2026-08-15T06:00:00.100Z",
    };
    const completedSnapshot = {
      turn_id: resumedTurnId,
      conversation_id: conversationId,
      status: "completed",
      state_version: 4,
      cancel_requested_at: null,
      finished_at: "2026-08-15T06:00:01.000Z",
      assistant_message_id: resumedAssistantMessageId,
      finish_reason: "stop",
      failure_code: null,
      failure_retryable: null,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: cancelledTurnId,
          submission_id: "00000000-0000-4000-8000-00000000020b",
          message_id: cancelledMessageId,
          status: "queued",
          sequence_no: 1,
          queue_position: 1,
          state_version: 1,
          idempotent_replay: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(runningSnapshot))
      .mockResolvedValueOnce(
        jsonResponse({
          control_request_id: "00000000-0000-4000-8000-00000000020c",
          request_disposition: "requested",
          action_boundary: "none",
          idempotent_replay: false,
          snapshot: cancelRequestedSnapshot,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(cancelledSnapshot))
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: resumedTurnId,
          submission_id: "00000000-0000-4000-8000-00000000020d",
          message_id: resumedMessageId,
          status: "queued",
          sequence_no: 2,
          queue_position: 1,
          state_version: 1,
          idempotent_replay: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(completedSnapshot))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                id: cancelledMessageId,
                role: "user",
                content: cancelMessage,
                turn_id: cancelledTurnId,
                turn_status: "cancelled",
              },
              {
                id: resumedMessageId,
                role: "user",
                content: resumeMessage,
                turn_id: resumedTurnId,
                turn_status: "completed",
              },
              {
                id: resumedAssistantMessageId,
                role: "assistant",
                content: resumedContent,
                turn_id: resumedTurnId,
                turn_status: "completed",
                finish_reason: "stop",
              },
            ],
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/chat.cancel-and-resume",
      environment,
      {
        ...credentials,
        conversationId,
        requestId: "${run.id}",
        cancelMessage: "请持续生成长回答，取消标识 ${run.id}",
        resumeMessage: "取消后续接，只回复 resume-${run.id}",
        expectedText: "resume-${run.id}",
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      conversationId,
      cancelledTurnId,
      resumedTurnId,
      cancelRequested: true,
      cancelActionBoundary: "none",
      cancelledStatus: "cancelled",
      cancelledAssistantAbsent: true,
      resumeCompleted: true,
      messageCount: 3,
      cancelledUserMessageCount: 1,
      resumedUserMessageCount: 1,
      resumedAssistantMessageCount: 1,
      toolMessageCount: 0,
      ghostAssistantCount: 0,
      expectedTextMatched: true,
      cancelInputSha256: createHash("sha256").update(cancelMessage).digest("hex"),
      resumeInputSha256: createHash("sha256").update(resumeMessage).digest("hex"),
      resumeAssistantSha256: createHash("sha256").update(resumedContent).digest("hex"),
      resumeAssistantContentLength: resumedContent.length,
      activePollAttempts: 1,
      cancelPollAttempts: 1,
      resumePollAttempts: 1,
    });
    const firstEnqueueBody = fetcher.mock.calls[1]?.[1]?.body;
    expect(typeof firstEnqueueBody).toBe("string");
    if (typeof firstEnqueueBody !== "string") throw new Error("expected JSON enqueue body");
    const firstEnqueue = JSON.parse(firstEnqueueBody) as Record<string, unknown>;
    expect(firstEnqueue).toMatchObject({
      client_request_id: variables["run.id"],
      content: cancelMessage,
      attachments: [],
      skill_names: [],
      required_capabilities: null,
    });
    expect(new Headers(fetcher.mock.calls[3]?.[1]?.headers).get("idempotency-key")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(cancelMessage);
    expect(serialized).not.toContain(resumeMessage);
    expect(serialized).not.toContain(resumedContent);
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("returns inconclusive when the Turn completes before an active cancel window", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: cancelledTurnId,
          submission_id: "00000000-0000-4000-8000-00000000020b",
          message_id: cancelledMessageId,
          status: "queued",
          sequence_no: 1,
          queue_position: 1,
          state_version: 1,
          idempotent_replay: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: cancelledTurnId,
          conversation_id: conversationId,
          status: "completed",
          state_version: 3,
          cancel_requested_at: null,
          finished_at: "2026-08-15T06:00:00.000Z",
          assistant_message_id: resumedAssistantMessageId,
          finish_reason: "stop",
          failure_code: null,
          failure_retryable: null,
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/chat.cancel-and-resume",
        environment,
        {
          ...credentials,
          conversationId,
          requestId: "${run.id}",
          cancelMessage: "long ${run.id}",
          resumeMessage: "resume ${run.id}",
          expectedText: "${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TURN_CANCEL_WINDOW_MISSED",
        classification: "environment_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects an external-effect boundary for a no-tool Turn cancellation", async () => {
    const runningSnapshot = {
      turn_id: cancelledTurnId,
      conversation_id: conversationId,
      status: "running",
      state_version: 2,
      cancel_requested_at: null,
      finished_at: null,
      assistant_message_id: null,
      finish_reason: null,
      failure_code: null,
      failure_retryable: null,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: cancelledTurnId,
          submission_id: "00000000-0000-4000-8000-00000000020b",
          message_id: cancelledMessageId,
          status: "queued",
          sequence_no: 1,
          queue_position: 1,
          state_version: 1,
          idempotent_replay: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(runningSnapshot))
      .mockResolvedValueOnce(
        jsonResponse({
          control_request_id: "00000000-0000-4000-8000-00000000020c",
          request_disposition: "requested",
          action_boundary: "external_effect_in_flight",
          idempotent_replay: false,
          snapshot: {
            ...runningSnapshot,
            status: "cancel_requested",
            state_version: 3,
            cancel_requested_at: "2026-08-15T06:00:00.000Z",
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/chat.cancel-and-resume",
        environment,
        {
          ...credentials,
          conversationId,
          requestId: "${run.id}",
          cancelMessage: "long ${run.id}",
          resumeMessage: "resume ${run.id}",
          expectedText: "${run.id}",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TURN_CANCEL_BOUNDARY_FAILED",
        classification: "product_failed",
      },
    });
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
      writeToolsAbsent: true,
      reviewRequiredToolsAbsent: true,
      unsafeRiskToolsAbsent: true,
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

  it.each([
    ["write", { is_write: true }],
    ["review-required", { requires_review: true }],
    ["unsafe-risk", { risk_level: "high" }],
  ])("fails closed when the administrator catalog exposes a %s tool", async (_label, unsafe) => {
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
                name: "calculator",
                is_enabled: true,
                is_discovered: true,
                is_write: false,
                requires_review: false,
                risk_level: "low",
                ...unsafe,
              },
              {
                name: "echo",
                is_enabled: true,
                is_discovered: true,
                is_write: false,
                requires_review: false,
                risk_level: "low",
              },
              {
                name: "time",
                is_enabled: true,
                is_discovered: true,
                is_write: false,
                requires_review: false,
                risk_level: "low",
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
        code: "SPARK_X_AGENT_SAFE_TOOL_CATALOG_MISMATCH",
        classification: "test_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
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

  it("records one calculator failure followed by one echo recovery without payload leakage", async () => {
    const marker = `spark-x-tool-recovery-${variables["run.id"]}`;
    const message = `回归 ${variables["run.id"]}：先调用计算器做 7÷0；确认失败后调用 echo 回显 ${marker}，最终回复 ${marker}`;
    const failureArguments = { operation: "divide", a: 7, b: 0 };
    const failureResult = { success: false, error: "division by zero" };
    const recoveryArguments = { message: marker };
    const recoveryResult = { success: true, echo: { message: marker } };
    const finalContent = `计算失败已恢复：${marker}`;
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
              id: "call-failure-1",
              name: "builtin-demo__calculator",
              arguments: JSON.stringify({ b: 0, operation: "divide", a: 7 }),
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-failure-1",
              name: "builtin-demo__calculator",
              result: failureResult,
              success: false,
            },
          },
          {
            event: "tool_call",
            data: {
              id: "call-recovery-2",
              name: "builtin-demo__echo",
              arguments: recoveryArguments,
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-recovery-2",
              name: "builtin-demo__echo",
              result: recoveryResult,
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
      "adapter:spark-x-agent/tool.invoke-failure-recovery",
      environment,
      {
        ...credentials,
        conversationId,
        message,
        expectedText: marker,
        failureArgumentsJson: JSON.stringify(failureArguments),
        failureResultJson: JSON.stringify(failureResult),
        recoveryArgumentsJson: JSON.stringify(recoveryArguments),
        recoveryResultJson: JSON.stringify(recoveryResult),
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      conversationId,
      done: true,
      failureObserved: true,
      recoveryObserved: true,
      sequenceMatched: true,
      expectedTextMatched: true,
      toolCallCount: 2,
      toolResultCount: 2,
      failedToolResultCount: 1,
      successfulToolResultCount: 1,
      reviewEventCount: 0,
      failureCallIdSha256: createHash("sha256").update("call-failure-1").digest("hex"),
      recoveryCallIdSha256: createHash("sha256").update("call-recovery-2").digest("hex"),
      failureArgumentsSha256: hashCanonical(failureArguments),
      failureResultSha256: hashCanonical(failureResult),
      recoveryArgumentsSha256: hashCanonical(recoveryArguments),
      recoveryResultSha256: hashCanonical(recoveryResult),
      finalContentLength: finalContent.length,
      finalContentSha256: createHash("sha256").update(finalContent).digest("hex"),
      streamBytes: output.streamBytes,
      truncated: false,
    });
    const evidence = JSON.stringify(output);
    expect(evidence).not.toContain("division by zero");
    expect(evidence).not.toContain(marker);
    expect(evidence).not.toContain(finalContent);
    expect(evidence).not.toContain("memory-only-access-token-value");
  });

  it("rejects a recovery tool result that remains failed", async () => {
    const failureArguments = { operation: "divide", a: 7, b: 0 };
    const failureResult = { success: false, error: "division by zero" };
    const recoveryArguments = { message: "recover" };
    const recoveryResult = { success: false, error: "echo unavailable" };
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
              id: "call-failure-1",
              name: "builtin-demo__calculator",
              arguments: failureArguments,
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-failure-1",
              name: "builtin-demo__calculator",
              result: failureResult,
              success: false,
            },
          },
          {
            event: "tool_call",
            data: {
              id: "call-recovery-2",
              name: "builtin-demo__echo",
              arguments: recoveryArguments,
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-recovery-2",
              name: "builtin-demo__echo",
              result: recoveryResult,
              success: false,
            },
          },
          { event: "content", data: { content: "recover" } },
          { event: "done", data: { final_content: "recover", truncated: false } },
        ]),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.invoke-failure-recovery",
        environment,
        {
          ...credentials,
          conversationId,
          message: "回归 ${run.id} 先失败再恢复",
          expectedText: "recover",
          failureArgumentsJson: JSON.stringify(failureArguments),
          failureResultJson: JSON.stringify(failureResult),
          recoveryArgumentsJson: JSON.stringify(recoveryArguments),
          recoveryResultJson: JSON.stringify(recoveryResult),
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TOOL_RECOVERY_SEQUENCE_FAILED",
        classification: "test_failed",
      },
    });
  });

  it("rejects a recovery call emitted before the failed result was observed", async () => {
    const failureArguments = { operation: "divide", a: 7, b: 0 };
    const failureResult = { success: false, error: "division by zero" };
    const recoveryArguments = { message: "recover" };
    const recoveryResult = { success: true, echo: { message: "recover" } };
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
              id: "call-failure-1",
              name: "builtin-demo__calculator",
              arguments: failureArguments,
            },
          },
          {
            event: "tool_call",
            data: {
              id: "call-recovery-2",
              name: "builtin-demo__echo",
              arguments: recoveryArguments,
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-failure-1",
              name: "builtin-demo__calculator",
              result: failureResult,
              success: false,
            },
          },
          {
            event: "tool_result",
            data: {
              id: "call-recovery-2",
              name: "builtin-demo__echo",
              result: recoveryResult,
              success: true,
            },
          },
          { event: "content", data: { content: "recover" } },
          { event: "done", data: { final_content: "recover", truncated: false } },
        ]),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.invoke-failure-recovery",
        environment,
        {
          ...credentials,
          conversationId,
          message: "回归 ${run.id} 先失败再恢复",
          expectedText: "recover",
          failureArgumentsJson: JSON.stringify(failureArguments),
          failureResultJson: JSON.stringify(failureResult),
          recoveryArgumentsJson: JSON.stringify(recoveryArguments),
          recoveryResultJson: JSON.stringify(recoveryResult),
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TOOL_RECOVERY_SEQUENCE_FAILED",
        classification: "test_failed",
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

  it("links failed and recovered tool history to both streamed evidence pairs", async () => {
    const marker = `spark-x-tool-recovery-${variables["run.id"]}`;
    const userContent = `回归 ${variables["run.id"]} 先计算 7÷0，再用 echo 恢复 ${marker}`;
    const assistantContent = `已从失败中恢复：${marker}`;
    const failureArguments = { operation: "divide", a: 7, b: 0 };
    const failureResult = { success: false, error: "division by zero" };
    const recoveryArguments = { message: marker };
    const recoveryResult = { success: true, echo: { message: marker } };
    const failureArgumentsHash = hashCanonical(failureArguments);
    const failureResultHash = hashCanonical(failureResult);
    const recoveryArgumentsHash = hashCanonical(recoveryArguments);
    const recoveryResultHash = hashCanonical(recoveryResult);
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
                    id: "call-failure-1",
                    function: {
                      name: "builtin-demo__calculator",
                      arguments: failureArguments,
                    },
                  },
                ],
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_call",
                    id: "call-failure-1",
                    name: "builtin-demo__calculator",
                    arguments: failureArguments,
                  },
                ],
              },
              {
                role: "tool",
                content: JSON.stringify(failureResult),
                tool_call_id: "call-failure-1",
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_result",
                    id: "call-failure-1",
                    name: "builtin-demo__calculator",
                    result: failureResult,
                    success: false,
                  },
                ],
              },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-recovery-2",
                    function: {
                      name: "builtin-demo__echo",
                      arguments: recoveryArguments,
                    },
                  },
                ],
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_call",
                    id: "call-recovery-2",
                    name: "builtin-demo__echo",
                    arguments: recoveryArguments,
                  },
                ],
              },
              {
                role: "tool",
                content: JSON.stringify(recoveryResult),
                tool_call_id: "call-recovery-2",
                payload_truncated: false,
                public_execution_trace: [
                  {
                    kind: "tool_result",
                    id: "call-recovery-2",
                    name: "builtin-demo__echo",
                    result: recoveryResult,
                    success: true,
                  },
                ],
              },
              {
                role: "assistant",
                content: assistantContent,
                finish_reason: "stop",
                tool_calls: [],
                payload_truncated: false,
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.assert-failure-recovery-history",
        environment,
        {
          ...credentials,
          conversationId,
          expectedUserText: userContent,
          expectedAssistantText: marker,
          expectedAssistantSha256: assistantHash,
          failureArgumentsSha256: failureArgumentsHash,
          failureResultSha256: failureResultHash,
          recoveryArgumentsSha256: recoveryArgumentsHash,
          recoveryResultSha256: recoveryResultHash,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
      conversationId,
      messageCount: 6,
      userMessageCount: 1,
      assistantMessageCount: 3,
      toolMessageCount: 2,
      toolCallCount: 2,
      toolResultCount: 2,
      traceToolCallCount: 2,
      traceToolResultCount: 2,
      failureObserved: true,
      recoveryObserved: true,
      sequenceMatched: true,
      expectedUserTextMatched: true,
      expectedAssistantTextMatched: true,
      assistantContentLength: assistantContent.length,
      assistantContentSha256: assistantHash,
      assistantFinishReason: "stop",
    });
  });

  it("reports a stable trace mismatch when recovery history omits public trace events", async () => {
    const marker = `spark-x-tool-recovery-${variables["run.id"]}`;
    const userContent = `回归 ${variables["run.id"]} 先计算 7÷0，再用 echo 恢复 ${marker}`;
    const assistantContent = `已从失败中恢复：${marker}`;
    const failureArguments = { operation: "divide", a: 7, b: 0 };
    const failureResult = { success: false, error: "division by zero" };
    const recoveryArguments = { message: marker };
    const recoveryResult = { success: true, echo: { message: marker } };
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
                    id: "call-failure-1",
                    function: {
                      name: "builtin-demo__calculator",
                      arguments: failureArguments,
                    },
                  },
                ],
                payload_truncated: false,
              },
              {
                role: "tool",
                content: JSON.stringify(failureResult),
                tool_call_id: "call-failure-1",
                payload_truncated: false,
              },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-recovery-2",
                    function: {
                      name: "builtin-demo__echo",
                      arguments: recoveryArguments,
                    },
                  },
                ],
                payload_truncated: false,
              },
              {
                role: "tool",
                content: JSON.stringify(recoveryResult),
                tool_call_id: "call-recovery-2",
                payload_truncated: false,
              },
              {
                role: "assistant",
                content: assistantContent,
                finish_reason: "stop",
                tool_calls: [],
                payload_truncated: false,
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/tool.assert-failure-recovery-history",
        environment,
        {
          ...credentials,
          conversationId,
          expectedUserText: userContent,
          expectedAssistantText: marker,
          expectedAssistantSha256: createHash("sha256").update(assistantContent).digest("hex"),
          failureArgumentsSha256: hashCanonical(failureArguments),
          failureResultSha256: hashCanonical(failureResult),
          recoveryArgumentsSha256: hashCanonical(recoveryArguments),
          recoveryResultSha256: hashCanonical(recoveryResult),
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_TOOL_RECOVERY_HISTORY_TRACE_FAILED",
        classification: "test_failed",
      },
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
      fixtureKind: "order",
      fixtureSizeBytes: uploadedBytes?.byteLength,
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("SPARK_X_KB_FIXTURE");
    expect(serialized).not.toContain("B2C-KB-001");
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("uploads the fixed account-chart decoy without accepting arbitrary file content", async () => {
    let uploadedBytes: Uint8Array | undefined;
    let uploadedName: string | undefined;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const form = init?.body;
        if (!(form instanceof FormData)) throw new Error("expected multipart form");
        const file = form.get("file");
        if (!(file instanceof Blob)) throw new Error("expected fixed fixture file");
        uploadedBytes = new Uint8Array(await file.arrayBuffer());
        uploadedName = (file as Blob & { readonly name?: string }).name;
        return jsonResponse({
          success: true,
          data: {
            id: uploadedDocumentId,
            name: uploadedName,
            size_bytes: uploadedBytes.byteLength,
            content_sha256: createHash("sha256").update(uploadedBytes).digest("hex"),
          },
        });
      });

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/knowledge-base.upload-fixture",
      environment,
      { ...credentials, knowledgeBaseId, fixtureKind: "account-chart" },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(uploadedName).toBe(`spark-x-account-chart-${knowledgeBaseId}.pdf`);
    expect(new TextDecoder().decode(uploadedBytes)).toContain("SPARK_X_ACCOUNT_CHART_FIXTURE");
    expect(output).toMatchObject({
      knowledgeBaseId,
      uploadedDocumentId,
      uploaded: true,
      fixtureKind: "account-chart",
      fixtureSizeBytes: uploadedBytes?.byteLength,
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("ACCOUNT_CHART");
    expect(serialized).not.toContain("9900");
    expect(serialized).not.toContain("memory-only-access-token-value");
  });

  it("uploads a deterministic built-in XLSX large table without accepting arbitrary cells", async () => {
    let uploadedBytes: Uint8Array | undefined;
    let uploadedName: string | undefined;
    let uploadedType: string | undefined;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockImplementationOnce(async (_input, init) => {
        const form = init?.body;
        if (!(form instanceof FormData)) throw new Error("expected multipart form");
        const rawMetadata = form.get("metadata");
        const file = form.get("file");
        if (typeof rawMetadata !== "string" || !(file instanceof Blob)) {
          throw new Error("expected fixed large-table fixture");
        }
        uploadedBytes = new Uint8Array(await file.arrayBuffer());
        uploadedName = (file as Blob & { readonly name?: string }).name;
        uploadedType = file.type;
        const contentSha256 = createHash("sha256").update(uploadedBytes).digest("hex");
        expect(JSON.parse(rawMetadata)).toEqual({
          filename: uploadedName,
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
      { ...credentials, knowledgeBaseId, fixtureKind: "large-table" },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(uploadedName).toBe(`spark-x-large-table-${knowledgeBaseId}.xlsx`);
    expect(uploadedType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(uploadedBytes?.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const storedWorkbook = new TextDecoder().decode(uploadedBytes);
    expect(storedWorkbook).toContain("KB006_LARGE_TABLE");
    expect(storedWorkbook).toContain("KB006-ROW-001");
    expect(storedWorkbook).toContain("KB006-ROW-096");
    expect(output).toMatchObject({
      knowledgeBaseId,
      uploadedDocumentId,
      uploaded: true,
      fixtureKind: "large-table",
      fixtureSizeBytes: uploadedBytes?.byteLength,
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("KB006-ROW-001");
    expect(serialized).not.toContain("RUN_RESOURCE_ID");
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

  it("traverses the fixed large table with exact-version signed cursors and bounded evidence", async () => {
    const fixtureSha256 = "a".repeat(64);
    const parserDocumentId = "parser-document-kb006";
    const parserVersionId = "parser-version-kb006";
    const fullText = kb006TableText();
    const chunks = Array.from({ length: Math.ceil(fullText.length / 1_000) }, (_, index) => ({
      start: index * 1_000,
      end: Math.min(fullText.length, (index + 1) * 1_000),
    }));
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
            status: "completed",
            current_version_number: 1,
            parser_document_id: parserDocumentId,
            current_version_id: parserVersionId,
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
                parser_version_id: parserVersionId,
              },
            ],
          },
        }),
      );
    chunks.forEach((chunk, index) => {
      const final = index === chunks.length - 1;
      fetcher.mockResolvedValueOnce(
        kb006ContinuationResponse(
          parserDocumentId,
          parserVersionId,
          fullText,
          index + 1,
          chunk.start,
          chunk.end,
          final,
          final ? null : `opaque-signed-cursor-${index + 1}`,
        ),
      );
    });

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/knowledge-base.assert-large-table-continuation",
      environment,
      {
        ...credentials,
        knowledgeBaseId,
        knowledgeDocumentId,
        expectedFixtureSha256: fixtureSha256,
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(urlOf(fetcher.mock.calls[3]?.[0] as URL | RequestInfo)).toBe(
      "http://192.168.110.136:18121/mcp/document",
    );
    const firstBody = fetcher.mock.calls[3]?.[1]?.body;
    if (typeof firstBody !== "string") throw new Error("expected first MCP JSON body");
    expect(JSON.parse(firstBody)).toMatchObject({
      jsonrpc: "2.0",
      id: "spark-x-kb006-page-1",
      method: "tools/call",
      params: {
        name: "retrieve_parsed_documents",
        arguments: {
          coverage: "complete",
          targets: ["tables"],
          filters: {
            document_ids: [parserDocumentId],
            version_scope: "exact",
            version_id: parserVersionId,
          },
          max_return_chars: 1_000,
          max_units: 1,
        },
      },
    });
    const secondBody = fetcher.mock.calls[4]?.[1]?.body;
    if (typeof secondBody !== "string") throw new Error("expected continuation MCP JSON body");
    const secondArguments = (
      JSON.parse(secondBody) as Readonly<{
        params: Readonly<{ arguments: Readonly<Record<string, unknown>> }>;
      }>
    ).params.arguments;
    expect(secondArguments).toMatchObject({
      coverage: "complete",
      cursor: "opaque-signed-cursor-1",
      max_return_chars: 1_000,
      max_units: 1,
    });
    expect(secondArguments).not.toHaveProperty("filters");
    expect(output).toMatchObject({
      knowledgeBaseId,
      knowledgeDocumentId,
      fixtureSha256,
      pageCount: chunks.length,
      cursorCount: chunks.length - 1,
      tableUnitCount: 1,
      expectedRowCount: 96,
      recoveredRowCount: 96,
      headerDetected: true,
      segmentsContiguous: true,
      cursorChainUnique: true,
      sourceComplete: true,
      documentBindingMatched: true,
      versionBindingMatched: true,
      fixtureMarkerMatched: true,
    });
    expect(output.parserDocumentIdSha256).toBe(
      createHash("sha256").update(parserDocumentId).digest("hex"),
    );
    expect(output.parserVersionIdSha256).toBe(
      createHash("sha256").update(parserVersionId).digest("hex"),
    );
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("KB006-ROW-001");
    expect(serialized).not.toContain("opaque-signed-cursor");
    expect(serialized).not.toContain(parserDocumentId);
    expect(serialized).not.toContain(parserVersionId);
    expect(serialized).not.toContain("memory-only-access-token-value");
    expect(serialized).not.toContain(variables["case.admin-password"]);
  });

  it("fails at the exact root cause when a large-table cursor skips a text boundary", async () => {
    const fixtureSha256 = "a".repeat(64);
    const parserDocumentId = "parser-document-kb006";
    const parserVersionId = "parser-version-kb006";
    const fullText = kb006TableText();
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
            status: "completed",
            current_version_number: 1,
            parser_document_id: parserDocumentId,
            current_version_id: parserVersionId,
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
                parser_version_id: parserVersionId,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        kb006ContinuationResponse(
          parserDocumentId,
          parserVersionId,
          fullText,
          1,
          0,
          1_000,
          false,
          "opaque-signed-cursor-1",
        ),
      )
      .mockResolvedValueOnce(
        kb006ContinuationResponse(
          parserDocumentId,
          parserVersionId,
          fullText,
          2,
          1_001,
          2_000,
          false,
          "opaque-signed-cursor-2",
        ),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.assert-large-table-continuation",
        environment,
        {
          ...credentials,
          knowledgeBaseId,
          knowledgeDocumentId,
          expectedFixtureSha256: fixtureSha256,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_TABLE_SEGMENT_DISCONTINUITY",
        classification: "test_failed",
      },
    });
  });

  it("fails closed when a large-table continuation returns another parser document", async () => {
    const fixtureSha256 = "a".repeat(64);
    const parserDocumentId = "parser-document-kb006";
    const parserVersionId = "parser-version-kb006";
    const fullText = kb006TableText();
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
            status: "completed",
            current_version_number: 1,
            parser_document_id: parserDocumentId,
            current_version_id: parserVersionId,
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
                parser_version_id: parserVersionId,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        kb006ContinuationResponse(
          parserDocumentId,
          parserVersionId,
          fullText,
          1,
          0,
          1_000,
          false,
          "opaque-signed-cursor-1",
          { document_id: "different-parser-document" },
        ),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.assert-large-table-continuation",
        environment,
        {
          ...credentials,
          knowledgeBaseId,
          knowledgeDocumentId,
          expectedFixtureSha256: fixtureSha256,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_TABLE_DOCUMENT_BOUNDARY_FAILED",
        classification: "test_failed",
      },
    });
  });

  it("rejects a repeated signed continuation cursor before content assertions", async () => {
    const fixtureSha256 = "a".repeat(64);
    const parserDocumentId = "parser-document-kb006";
    const parserVersionId = "parser-version-kb006";
    const fullText = kb006TableText();
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
            status: "completed",
            current_version_number: 1,
            parser_document_id: parserDocumentId,
            current_version_id: parserVersionId,
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
                parser_version_id: parserVersionId,
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        kb006ContinuationResponse(
          parserDocumentId,
          parserVersionId,
          fullText,
          1,
          0,
          1_000,
          false,
          "repeated-signed-cursor",
        ),
      )
      .mockResolvedValueOnce(
        kb006ContinuationResponse(
          parserDocumentId,
          parserVersionId,
          fullText,
          2,
          1_000,
          2_000,
          false,
          "repeated-signed-cursor",
        ),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.assert-large-table-continuation",
        environment,
        {
          ...credentials,
          knowledgeBaseId,
          knowledgeDocumentId,
          expectedFixtureSha256: fixtureSha256,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_TABLE_CURSOR_REPEATED",
        classification: "test_failed",
      },
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

  it("links a real knowledge Turn answer to the allowed order evidence and excludes the chart", async () => {
    const fixtureSha256 = "a".repeat(64);
    const snapshotHash = "b".repeat(64);
    const packetHash = "c".repeat(64);
    const title = `spark-x-kb-query-${variables["run.id"]}.pdf`;
    const message = `自动化回归 ${variables["run.id"]}：仅根据知识库回答订单 B2C-KB-001 的订单号、客户代码、金额和状态，并保留知识引用。`;
    const answer = `B2C-KB-001 | SPARK-REGRESSION | 4200 | PAID | ${knowledgeBaseId} [K1]`;
    const locator = { page: 1 };
    const snippet = `ORDER_ID: B2C-KB-001 CUSTOMER_CODE: SPARK-REGRESSION AMOUNT_CNY: 4200 STATUS: PAID RUN_RESOURCE_ID: ${knowledgeBaseId}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            turn_id: knowledgeQueryTurnId,
            submission_id: "00000000-0000-4000-8000-00000000021e",
            message_id: knowledgeQueryMessageId,
            status: "queued",
            sequence_no: 1,
            queue_position: 1,
            state_version: 1,
            idempotent_replay: false,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: knowledgeQueryTurnId,
          conversation_id: conversationId,
          status: "completed",
          state_version: 4,
          cancel_requested_at: null,
          finished_at: "2026-08-15T05:00:00.000Z",
          assistant_message_id: knowledgeQueryAssistantMessageId,
          finish_reason: "stop",
          failure_code: null,
          failure_retryable: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                id: knowledgeQueryMessageId,
                role: "user",
                content: message,
                turn_id: knowledgeQueryTurnId,
                turn_status: "completed",
                payload_truncated: false,
              },
              {
                id: knowledgeQueryAssistantMessageId,
                role: "assistant",
                content: answer,
                turn_id: knowledgeQueryTurnId,
                turn_status: "completed",
                finish_reason: "stop",
                payload_truncated: false,
                document_context: {
                  provider: "caishui_knowledge",
                  snapshot_id: knowledgeSnapshotId,
                  snapshot_hash: snapshotHash,
                  retrieval_id: knowledgeRetrievalId,
                  packet_hash: packetHash,
                  cited_refs: ["K1"],
                  evidence_count: 1,
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            turn_id: knowledgeQueryTurnId,
            retrieval_id: knowledgeRetrievalId,
            snapshot_id: knowledgeSnapshotId,
            snapshot_hash: snapshotHash,
            retrieval_policy: "required",
            mode: "hybrid",
            truncated: false,
            warnings: [],
            evidence: [
              {
                ref: "K1",
                evidence_type: "block",
                document_id: knowledgeDocumentId,
                version_id: knowledgeVersionId,
                version_number: 1,
                content_hash: fixtureSha256,
                title,
                locator,
                snippet,
                score: 0.99,
                retrieval_mode: "hybrid",
                truncated: false,
              },
            ],
          },
        }),
      );

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
      environment,
      {
        ...credentials,
        conversationId,
        requestId: "${run.id}",
        snapshotId: knowledgeSnapshotId,
        snapshotHash,
        knowledgeDocumentId,
        forbiddenKnowledgeDocumentId,
        expectedFixtureSha256: fixtureSha256,
        expectedTitle: "spark-x-kb-query-${run.id}.pdf",
        expectedResourceMarker: knowledgeBaseId,
        forbiddenResourceMarker: forbiddenKnowledgeBaseId,
        message,
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    const enqueue = fetcher.mock.calls[1];
    expect(urlOf(enqueue?.[0] as URL | RequestInfo)).toBe(
      `http://192.168.110.136/trade/api/v5/conversations/${conversationId}/turns`,
    );
    expect(new Headers(enqueue?.[1]?.headers).get("idempotency-key")).toBe(variables["run.id"]);
    const enqueueBody = enqueue?.[1]?.body;
    if (typeof enqueueBody !== "string") throw new Error("expected knowledge Turn JSON body");
    expect(JSON.parse(enqueueBody)).toMatchObject({
      client_request_id: variables["run.id"],
      content: message,
      document_context: {
        provider: "caishui_knowledge",
        snapshot_id: knowledgeSnapshotId,
        snapshot_hash: snapshotHash,
      },
      required_capabilities: { tool_mode: "auto" },
    });
    expect(output).toMatchObject({
      conversationId,
      turnId: knowledgeQueryTurnId,
      knowledgeDocumentId,
      snapshotId: knowledgeSnapshotId,
      snapshotHash,
      retrievalId: knowledgeRetrievalId,
      packetHash,
      completed: true,
      expectedFactsMatched: true,
      resourceMarkerChecked: true,
      resourceMarkerMatched: true,
      citationSetMatched: true,
      forbiddenEvidenceAbsent: true,
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolMessageCount: 0,
      evidenceCount: 1,
      citedRefCount: 1,
      retrievalMode: "hybrid",
      answerLength: answer.length,
      answerSha256: createHash("sha256").update(answer).digest("hex"),
      pollAttempts: 1,
    });
    expect(output.evidenceSetSha256).toMatch(/^[0-9a-f]{64}$/u);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(snippet);
    expect(serialized).not.toContain(answer);
    expect(serialized).not.toContain("B2C-KB-001");
    expect(serialized).not.toContain("9900");
    expect(serialized).not.toContain("memory-only-access-token-value");
  });

  it("rejects an answer contaminated with the unbound knowledge-base marker", async () => {
    const snapshotHash = "b".repeat(64);
    const packetHash = "c".repeat(64);
    const message = `自动化回归 ${variables["run.id"]}：回答已绑定订单文件中的资源标识。`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            turn_id: knowledgeQueryTurnId,
            submission_id: "00000000-0000-4000-8000-00000000021e",
            message_id: knowledgeQueryMessageId,
            status: "queued",
            sequence_no: 1,
            queue_position: 1,
            state_version: 1,
            idempotent_replay: false,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: knowledgeQueryTurnId,
          conversation_id: conversationId,
          status: "completed",
          state_version: 4,
          cancel_requested_at: null,
          finished_at: "2026-08-15T05:00:00.000Z",
          assistant_message_id: knowledgeQueryAssistantMessageId,
          finish_reason: "stop",
          failure_code: null,
          failure_retryable: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                id: knowledgeQueryMessageId,
                role: "user",
                content: message,
                turn_id: knowledgeQueryTurnId,
                turn_status: "completed",
                payload_truncated: false,
              },
              {
                id: knowledgeQueryAssistantMessageId,
                role: "assistant",
                content: `B2C-KB-001 | SPARK-REGRESSION | 4200 | PAID | ${forbiddenKnowledgeBaseId} [K1]`,
                turn_id: knowledgeQueryTurnId,
                turn_status: "completed",
                finish_reason: "stop",
                payload_truncated: false,
                document_context: {
                  provider: "caishui_knowledge",
                  snapshot_id: knowledgeSnapshotId,
                  snapshot_hash: snapshotHash,
                  retrieval_id: knowledgeRetrievalId,
                  packet_hash: packetHash,
                  cited_refs: ["K1"],
                  evidence_count: 1,
                },
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
        environment,
        {
          ...credentials,
          conversationId,
          requestId: "${run.id}",
          snapshotId: knowledgeSnapshotId,
          snapshotHash,
          knowledgeDocumentId,
          forbiddenKnowledgeDocumentId,
          expectedFixtureSha256: "a".repeat(64),
          expectedTitle: "spark-x-kb-query-${run.id}.pdf",
          expectedResourceMarker: knowledgeBaseId,
          forbiddenResourceMarker: forbiddenKnowledgeBaseId,
          message,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_QUERY_ANSWER_FAILED",
        classification: "test_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("preserves a stable product failure when retrieval evidence points at the forbidden chart", async () => {
    const fixtureSha256 = "a".repeat(64);
    const snapshotHash = "b".repeat(64);
    const packetHash = "c".repeat(64);
    const title = `spark-x-kb-query-${variables["run.id"]}.pdf`;
    const message = `自动化回归 ${variables["run.id"]}：仅根据知识库回答订单 B2C-KB-001 的订单号、客户代码、金额和状态，并保留知识引用。`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            turn_id: knowledgeQueryTurnId,
            submission_id: "00000000-0000-4000-8000-00000000021e",
            message_id: knowledgeQueryMessageId,
            status: "queued",
            sequence_no: 1,
            queue_position: 1,
            state_version: 1,
            idempotent_replay: false,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          turn_id: knowledgeQueryTurnId,
          conversation_id: conversationId,
          status: "completed",
          state_version: 4,
          cancel_requested_at: null,
          finished_at: "2026-08-15T05:00:00.000Z",
          assistant_message_id: knowledgeQueryAssistantMessageId,
          finish_reason: "stop",
          failure_code: null,
          failure_retryable: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            items: [
              {
                id: knowledgeQueryMessageId,
                role: "user",
                content: message,
                turn_id: knowledgeQueryTurnId,
                turn_status: "completed",
                payload_truncated: false,
              },
              {
                id: knowledgeQueryAssistantMessageId,
                role: "assistant",
                content: `B2C-KB-001 | SPARK-REGRESSION | 4200 | PAID | ${knowledgeBaseId} [K1]`,
                turn_id: knowledgeQueryTurnId,
                turn_status: "completed",
                finish_reason: "stop",
                payload_truncated: false,
                document_context: {
                  provider: "caishui_knowledge",
                  snapshot_id: knowledgeSnapshotId,
                  snapshot_hash: snapshotHash,
                  retrieval_id: knowledgeRetrievalId,
                  packet_hash: packetHash,
                  cited_refs: ["K1"],
                  evidence_count: 1,
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            turn_id: knowledgeQueryTurnId,
            retrieval_id: knowledgeRetrievalId,
            snapshot_id: knowledgeSnapshotId,
            snapshot_hash: snapshotHash,
            retrieval_policy: "required",
            mode: "hybrid",
            truncated: false,
            warnings: [],
            evidence: [
              {
                ref: "K1",
                evidence_type: "block",
                document_id: forbiddenKnowledgeDocumentId,
                version_id: knowledgeVersionId,
                version_number: 1,
                content_hash: fixtureSha256,
                title,
                locator: { page: 1 },
                snippet: `ORDER_ID: B2C-KB-001 CUSTOMER_CODE: SPARK-REGRESSION AMOUNT_CNY: 4200 STATUS: PAID RUN_RESOURCE_ID: ${knowledgeBaseId}`,
                score: 0.99,
                retrieval_mode: "hybrid",
                truncated: false,
              },
            ],
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.query-and-assert-evidence",
        environment,
        {
          ...credentials,
          conversationId,
          requestId: "${run.id}",
          snapshotId: knowledgeSnapshotId,
          snapshotHash,
          knowledgeDocumentId,
          forbiddenKnowledgeDocumentId,
          expectedFixtureSha256: fixtureSha256,
          expectedTitle: "spark-x-kb-query-${run.id}.pdf",
          expectedResourceMarker: knowledgeBaseId,
          forbiddenResourceMarker: forbiddenKnowledgeBaseId,
          message,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_QUERY_DOCUMENT_BOUNDARY_FAILED",
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
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            document_id: knowledgeDocumentId,
            status: "deleted",
            deleted: true,
            parser: {
              document_id: knowledgeDocumentId,
              status: "deleted",
              deleted: true,
              already_absent: false,
              version_count: 1,
              job_count: 1,
            },
          },
        }),
      )
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
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: knowledgeBaseId, status: "archived" },
        }),
      );

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
      knowledgeDocumentAlreadyAbsentCount: 0,
      parserDeleteReceiptCount: 1,
      parserDeletedCount: 1,
      parserAlreadyAbsentCount: 0,
      parserVersionDeleteCount: 1,
      parserJobDeleteCount: 1,
      parserCleanupConfirmed: true,
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

  it("proves the archived base, domain document, parser scope and raw upload are absent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "inactive scope" }, 403))
      .mockResolvedValueOnce(
        jsonResponse({ success: false, error: { code: "UPLOAD_TERMINAL" } }, 410),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.assert-cleaned-state",
        environment,
        { ...credentials, knowledgeBaseId, knowledgeDocumentId, uploadedDocumentId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).resolves.toEqual({
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
    });
    expect(
      fetcher.mock.calls.slice(1).map((call) => ({
        url: urlOf(call[0] as URL | RequestInfo),
        method: call[1]?.method,
      })),
    ).toEqual([
      {
        url: `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}`,
        method: "GET",
      },
      {
        url: "http://192.168.110.136/trade-domain-api/knowledge-bases",
        method: "GET",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents/${knowledgeDocumentId}`,
        method: "GET",
      },
      {
        url: `http://192.168.110.136/trade-domain-api/knowledge-bases/${knowledgeBaseId}/documents/${knowledgeDocumentId}/versions`,
        method: "GET",
      },
      {
        url: "http://192.168.110.136/trade-domain-api/knowledge/search",
        method: "POST",
      },
      {
        url: `http://192.168.110.136/trade/api/documents/upload-status/${knowledgeBaseId}`,
        method: "GET",
      },
      {
        url: `http://192.168.110.136/trade/api/documents/${uploadedDocumentId}`,
        method: "GET",
      },
    ]);
  });

  it("preserves a stable failure when a cleaned knowledge base remains active", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { id: knowledgeBaseId, status: "active" } }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.assert-cleaned-state",
        environment,
        { ...credentials, knowledgeBaseId, knowledgeDocumentId, uploadedDocumentId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_BASE_REMAINS",
        classification: "test_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves a stable failure when the archived knowledge scope remains searchable", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { documents: [], total_documents: 0, total_hits: 0 },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.assert-cleaned-state",
        environment,
        { ...credentials, knowledgeBaseId, knowledgeDocumentId, uploadedDocumentId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_CLEANUP_SEARCH_REMAINS",
        classification: "test_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("rejects a cleanup receipt that does not prove parser index deletion", async () => {
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
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            document_id: knowledgeDocumentId,
            status: "deleted",
            deleted: true,
            parser: {
              document_id: knowledgeDocumentId,
              status: "deleted",
              deleted: false,
              already_absent: false,
              version_count: 1,
              job_count: 1,
            },
          },
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/knowledge-base.cleanup",
        environment,
        { ...credentials, knowledgeBaseId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_KNOWLEDGE_DOCUMENT_DELETE_RESPONSE_INVALID",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("replays cleanup idempotently after the base is missing and its upload ticket retired", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "missing" }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ success: false, error: { code: "UPLOAD_TERMINAL" } }, 410),
      );

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
      knowledgeDocumentDeleteCount: 0,
      knowledgeDocumentAlreadyAbsentCount: 0,
      parserDeleteReceiptCount: 0,
      parserDeletedCount: 0,
      parserAlreadyAbsentCount: 0,
      parserVersionDeleteCount: 0,
      parserJobDeleteCount: 0,
      parserCleanupConfirmed: true,
      rawDocumentDeleted: true,
      knowledgeBaseArchived: true,
      alreadyMissing: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
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

  it("creates a delayed lifecycle fixture without exposing its goal", async () => {
    const nextFireAt = new Date(Date.now() + 600_000).toISOString();
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
        firstFireDelaySeconds: 600,
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toMatchObject({
      automationId,
      conversationId,
      created: true,
      enabled: true,
      firstFireDelaySeconds: 600,
      nextFireAt,
    });
    const requestBody = fetcher.mock.calls[1]?.[1]?.body;
    if (typeof requestBody !== "string") throw new Error("expected JSON request body");
    const body = JSON.parse(requestBody) as Readonly<Record<string, unknown>>;
    expect(body.interval_seconds).toBe(300);
    expect(Date.parse(String(body.first_fire_at)) - Date.now()).toBeGreaterThan(598_000);
    expect(Date.parse(String(body.first_fire_at)) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(JSON.stringify(output)).not.toContain(automationGoal);
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
        expectedFirstFireAt: "2026-08-15T04:00:00.000Z",
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
      timezone: "Asia/Shanghai",
      utcOffsetMinutes: 480,
      scheduledFirstFireAt: "2026-08-15T04:00:00.000Z",
      observedFirstFireAt: "2026-08-15T04:00:00.000Z",
      observedFirstFireLocal: "2026-08-15T12:00:00.000+08:00",
      nextFireLocal: "2026-08-15T12:05:00.000+08:00",
      firstFireScheduleMatched: true,
      firstFireDriftSeconds: 0,
      localScheduleAdvancedBySeconds: 300,
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

  it("rejects a scheduler fire outside the bounded Asia/Shanghai trigger window", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            automationProjection({
              last_fire_at: "2026-08-15T04:02:00.000Z",
              next_fire_at: "2026-08-15T04:07:00.000Z",
            }),
          ],
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
          expectedFirstFireAt: "2026-08-15T04:00:00.000Z",
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_AUTOMATION_TIMEZONE_SCHEDULE_INVALID",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("proves one completed automation delivery stays stable across three observations", async () => {
    const assistantContent = `已完成：${automationMarker}`;
    const assistantSha256 = createHash("sha256").update(assistantContent).digest("hex");
    const historyResponse = () =>
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
      });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [automationProjection()] }))
      .mockResolvedValueOnce(historyResponse())
      .mockResolvedValueOnce(jsonResponse({ items: [automationProjection()] }))
      .mockResolvedValueOnce(historyResponse())
      .mockResolvedValueOnce(jsonResponse({ items: [automationProjection()] }))
      .mockResolvedValueOnce(historyResponse());

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/automation.assert-no-duplicate-delivery",
      environment,
      {
        ...credentials,
        automationId,
        conversationId,
        expectedName: automationName,
        expectedGoal: automationGoal,
        expectedAssistantText: automationMarker,
        expectedLastFireAt: "2026-08-15T04:00:00.000Z",
        expectedNextFireAt: "2026-08-15T04:05:00.000Z",
        expectedAssistantSha256: assistantSha256,
      },
      variables,
      { timeoutMs: 10_000, fetcher },
    );

    expect(output).toEqual({
      automationId,
      conversationId,
      duplicateDeliveryAbsent: true,
      stableScheduleObserved: true,
      observationCount: 3,
      stateVersion: 2,
      lastFireAt: "2026-08-15T04:00:00.000Z",
      nextFireAt: "2026-08-15T04:05:00.000Z",
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolMessageCount: 0,
      toolCallCount: 0,
      toolTraceEventCount: 0,
      expectedAssistantHashMatched: true,
      userContentSha256: createHash("sha256").update(automationGoal).digest("hex"),
      assistantContentSha256: assistantSha256,
    });
    expect(fetcher).toHaveBeenCalledTimes(7);
    const evidence = JSON.stringify(output);
    expect(evidence).not.toContain(automationGoal);
    expect(evidence).not.toContain(assistantContent);
    expect(evidence).not.toContain("memory-only-access-token-value");
  }, 15_000);

  it("fails on the first schedule change during duplicate-delivery observation", async () => {
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
      )
      .mockResolvedValueOnce(jsonResponse({ items: [automationProjection({ state_version: 3 })] }));

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/automation.assert-no-duplicate-delivery",
        environment,
        {
          ...credentials,
          automationId,
          conversationId,
          expectedName: automationName,
          expectedGoal: automationGoal,
          expectedAssistantText: automationMarker,
          expectedLastFireAt: "2026-08-15T04:00:00.000Z",
          expectedNextFireAt: "2026-08-15T04:05:00.000Z",
          expectedAssistantSha256: createHash("sha256").update(assistantContent).digest("hex"),
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_AUTOMATION_DUPLICATE_DELIVERY_DETECTED",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  }, 10_000);

  it("updates, disables, enables and deletes an untriggered automation with exact versions", async () => {
    const updatedName = `${automationName}-updated`;
    const updatedGoal = `${automationGoal} updated`;
    const baselineNextFireAt = new Date(Date.now() + 600_000).toISOString();
    let updatedNextFireAt = baselineNextFireAt;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            automationProjection({
              state_version: 1,
              next_fire_at: baselineNextFireAt,
              last_fire_at: null,
            }),
          ],
        }),
      )
      .mockImplementationOnce((_input, init) => {
        if (typeof init?.body !== "string") throw new Error("expected update JSON body");
        const body = JSON.parse(init.body) as Readonly<Record<string, unknown>>;
        updatedNextFireAt = String(body.next_fire_at);
        return Promise.resolve(
          jsonResponse({
            definition_id: automationId,
            state_version: 2,
            status: "enabled",
            next_fire_at: updatedNextFireAt,
          }),
        );
      })
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            items: [
              automationProjection({
                name: updatedName,
                goal: updatedGoal,
                interval_seconds: 600,
                state_version: 2,
                next_fire_at: updatedNextFireAt,
                last_fire_at: null,
              }),
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          definition_id: automationId,
          state_version: 3,
          status: "disabled",
          next_fire_at: null,
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            items: [
              automationProjection({
                name: updatedName,
                goal: updatedGoal,
                interval_seconds: 600,
                status: "disabled",
                state_version: 3,
                next_fire_at: updatedNextFireAt,
                last_fire_at: null,
              }),
            ],
          }),
        ),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          jsonResponse({
            definition_id: automationId,
            state_version: 4,
            status: "enabled",
            next_fire_at: updatedNextFireAt,
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          definition_id: automationId,
          state_version: 5,
          status: "disabled",
          next_fire_at: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [] }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { items: [] } }));

    const output = await executeSparkXAgentAction(
      "adapter:spark-x-agent/automation.assert-lifecycle",
      environment,
      {
        ...credentials,
        automationId,
        conversationId,
        expectedName: automationName,
        expectedGoal: automationGoal,
        updatedName,
        updatedGoal,
      },
      variables,
      { timeoutMs: 5_000, fetcher },
    );

    expect(output).toEqual({
      automationId,
      conversationId,
      updated: true,
      disabled: true,
      enabledAgain: true,
      deleted: true,
      absentAfterDelete: true,
      noTriggerMessages: true,
      initialStateVersion: 1,
      updatedStateVersion: 2,
      disabledStateVersion: 3,
      enabledStateVersion: 4,
      deletedStateVersion: 5,
      updatedIntervalSeconds: 600,
      selectedSkillAbsent: true,
      updatedNameSha256: createHash("sha256").update(updatedName).digest("hex"),
      updatedGoalSha256: createHash("sha256").update(updatedGoal).digest("hex"),
    });
    expect(fetcher.mock.calls.slice(2, 9).map((call) => call[1]?.method ?? "GET")).toEqual([
      "PUT",
      "GET",
      "POST",
      "GET",
      "POST",
      "DELETE",
      "GET",
    ]);
    const evidence = JSON.stringify(output);
    expect(evidence).not.toContain(updatedName);
    expect(evidence).not.toContain(updatedGoal);
    expect(evidence).not.toContain("memory-only-access-token-value");
  });

  it("preserves an already-fired lifecycle fixture before making any mutation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            automationProjection({
              state_version: 2,
              next_fire_at: new Date(Date.now() + 600_000).toISOString(),
              last_fire_at: new Date().toISOString(),
            }),
          ],
        }),
      );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/automation.assert-lifecycle",
        environment,
        {
          ...credentials,
          automationId,
          conversationId,
          expectedName: automationName,
          expectedGoal: automationGoal,
          updatedName: `${automationName}-updated`,
          updatedGoal: `${automationGoal} updated`,
        },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "SPARK_X_AGENT_AUTOMATION_LIFECYCLE_ALREADY_FIRED",
        classification: "product_failed",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
