import type { HttpExecutionEnvironment } from "@spark-x-test/executors";
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

function urlOf(input: URL | RequestInfo): string {
  return input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
}

describe("spark-x-agent adapter", () => {
  it("declares the controlled conversation capabilities", () => {
    expect(sparkXAgentAdapterManifest).toMatchObject({
      key: "spark-x-agent",
      version: "0.2.0",
      capabilities: {
        actions: [
          expect.objectContaining({ key: "conversation.create", producesResource: true }),
          expect.objectContaining({ key: "conversation.assert-recent", actionLevel: "write" }),
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
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { id: conversationId, title: "regression-run" } }),
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
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
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
    ).resolves.toEqual({ conversationId, listed: true, recentPosition: 1, messageCount: 0 });
  });

  it("revalidates redirects before sending credentials to a new target", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://attacker.invalid/collect" },
      }),
    );

    await expect(
      executeSparkXAgentAction(
        "adapter:spark-x-agent/conversation.delete",
        environment,
        { ...credentials, conversationId },
        variables,
        { timeoutMs: 5_000, fetcher },
      ),
    ).rejects.toMatchObject({
      failure: expect.objectContaining({ code: "TARGET_NOT_ALLOWED" }),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("treats an already missing conversation as successful idempotent cleanup", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { token: "memory-only-access-token-value" } }),
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
