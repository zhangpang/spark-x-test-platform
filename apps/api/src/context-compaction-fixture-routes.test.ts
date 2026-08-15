import { afterEach, describe, expect, it } from "vitest";

import { buildApiApplication } from "./app.js";
import {
  contextCompactionFixtureApiKey,
  contextCompactionFixtureModel,
  contextCompactionFixturePath,
} from "./context-compaction-fixture-routes.js";

const runId = "00000000-0000-4000-8000-000000000505";
const endpoint = `/api/v1${contextCompactionFixturePath}`;
const environment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  REDIS_URL: "redis://127.0.0.1:1/0",
  MINIO_ENDPOINT: "127.0.0.1",
  MINIO_PORT: "1",
  MINIO_USE_SSL: "false",
  MINIO_ACCESS_KEY: "unused",
  MINIO_SECRET_KEY: "unused",
  MINIO_BUCKET: "unused",
  PLATFORM_CONTEXT_COMPACTION_FIXTURE_ENABLED: "true",
};
const applications: ReturnType<typeof buildApiApplication>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async ({ app }) => app.close()));
});

function application(enabled = true): ReturnType<typeof buildApiApplication> {
  const result = buildApiApplication({
    ...environment,
    PLATFORM_CONTEXT_COMPACTION_FIXTURE_ENABLED: enabled ? "true" : "false",
  });
  applications.push(result);
  return result;
}

function fixtureHeaders(): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${contextCompactionFixtureApiKey}` };
}

function requestPayload(
  messages: readonly Readonly<Record<string, unknown>>[],
  stream = true,
): Readonly<Record<string, unknown>> {
  return {
    model: contextCompactionFixtureModel,
    messages,
    max_tokens: 4096,
    temperature: stream ? 0.7 : 0,
    stream,
    ...(stream
      ? {
          tools: [
            {
              type: "function",
              function: {
                name: "document_search",
                description: "fixed read-only tool",
                parameters: { type: "object" },
              },
            },
          ],
        }
      : {}),
  };
}

function ssePayloads(body: string): readonly unknown[] {
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as unknown);
}

describe("context compaction Provider fixture", () => {
  it("is absent unless the test-environment switch is explicitly enabled", async () => {
    const response = await application(false).app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload([{ role: "user", content: `CHAT005_FILL:${runId}:x` }]),
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects missing fixture authentication before processing the body", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      payload: requestPayload([{ role: "user", content: `CHAT005_FILL:${runId}:x` }]),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "CONTEXT_COMPACTION_FIXTURE_UNAUTHORIZED" });
  });

  it("rejects unsupported models and request fields instead of becoming a generic endpoint", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: {
        ...requestPayload([{ role: "user", content: `CHAT005_FILL:${runId}:x` }]),
        model: "arbitrary-model",
        forwardingTarget: "https://example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("emits exactly one real document_search call and then a bounded final answer", async () => {
    const app = application().app;
    const initial = await app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload([{ role: "user", content: `CHAT005_TOOL:${runId}` }]),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["content-type"]).toContain("text/event-stream");
    const initialEvents = JSON.stringify(ssePayloads(initial.body));
    expect(initialEvents).toContain('"finish_reason":"tool_calls"');
    expect(initialEvents).toContain(`"id":"call_chat005_${runId.replaceAll("-", "")}"`);
    expect(initialEvents).toContain('"name":"document_search"');
    expect(initialEvents).toContain(`spark-x-chat005-${runId}`);
    expect(initial.body.match(/data: \[DONE\]/gu)).toHaveLength(1);

    const afterTool = await app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload([
        { role: "user", content: `CHAT005_TOOL:${runId}` },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_chat005_${runId.replaceAll("-", "")}`,
              type: "function",
              function: { name: "document_search", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: `call_chat005_${runId.replaceAll("-", "")}`,
          content: '{"success":true,"results":[]}',
        },
      ]),
    });
    expect(afterTool.body).toContain(`CHAT005_TOOL_DONE:${runId}`);
    expect(afterTool.body.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });

  it("summarizes only a matched anchor plus completed tool pair without reflecting filler", async () => {
    const callId = `call_chat005_${runId.replaceAll("-", "")}`;
    const untrustedFiller = "DO_NOT_REFLECT_THIS_FILLER";
    const summaryPrompt = JSON.stringify({
      previous_summary: null,
      messages_to_compact: [
        { id: "user-1", role: "user", content: `CHAT005_TOOL:${runId}` },
        {
          id: "assistant-1",
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              name: "document_search",
              arguments: { query: `spark-x-chat005-${runId}` },
            },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          content: '{"success":true,"results":[],"message":"No relevant documents found"}',
          tool_call_id: callId,
        },
        { id: "user-2", role: "user", content: untrustedFiller },
      ],
      protected_context_reference: [],
    });
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload(
        [
          {
            role: "system",
            content: "You summarize prior agent conversation state. Return JSON.",
          },
          { role: "user", content: summaryPrompt },
        ],
        false,
      ),
    });

    expect(response.statusCode).toBe(200);
    const body: unknown = JSON.parse(response.body);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("expected fixture response object");
    }
    const choices = (body as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length !== 1) {
      throw new Error("expected one fixture response choice");
    }
    const choice: unknown = choices[0];
    if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
      throw new Error("expected fixture response choice object");
    }
    const message = (choice as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new Error("expected fixture response message object");
    }
    const content = (message as Record<string, unknown>).content;
    if (typeof content !== "string") throw new Error("expected fixture response message content");
    const summary: unknown = JSON.parse(content);
    expect(summary).toMatchObject({
      schema_version: 1,
      objective: `Continue CHAT-005 for run ${runId}`,
      tool_state: [`document_search completed before compaction for ${runId}`],
      critical_facts: [`CHAT005_ANCHOR:${runId}`, "CHAT005_TOOL_STATE_OK"],
    });
    expect(response.body).not.toContain(untrustedFiller);
  });

  it("does not accept a quoted success fragment as completed tool state", async () => {
    const callId = `call_chat005_${runId.replaceAll("-", "")}`;
    const summaryPrompt = JSON.stringify({
      previous_summary: null,
      messages_to_compact: [
        { role: "user", content: `CHAT005_TOOL:${runId}` },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              name: "document_search",
              arguments: { query: `spark-x-chat005-${runId}` },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: callId,
          content: '{"success":false,"message":"embedded \\"success\\":true"}',
        },
      ],
    });
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload(
        [
          { role: "system", content: "You summarize prior agent conversation state." },
          { role: "user", content: summaryPrompt },
        ],
        false,
      ),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("CHAT005_TOOL_STATE_MISSING");
    expect(response.body).not.toContain("CHAT005_TOOL_STATE_OK");
  });

  it("returns the success marker only when a durable summary carries anchor and tool state", async () => {
    const app = application().app;
    const continuation = (systemContent: string) =>
      app.inject({
        method: "POST",
        url: endpoint,
        headers: fixtureHeaders(),
        payload: requestPayload([
          { role: "user", content: systemContent },
          { role: "user", content: `CHAT005_CONTINUE:${runId}` },
        ]),
      });
    const missing = await continuation("ordinary system prompt");
    expect(missing.body).toContain(`CHAT005_CONTINUITY_MISSING:${runId}`);

    const complete = await continuation(
      `[CONTEXT_COMPACTION_SUMMARY_V1]\n${JSON.stringify({
        critical_facts: [`CHAT005_ANCHOR:${runId}`, "CHAT005_TOOL_STATE_OK"],
        tool_state: [`document_search completed before compaction for ${runId}`],
      })}\n[/CONTEXT_COMPACTION_SUMMARY_V1]`,
    );
    expect(complete.body).toContain(`CHAT005_CONTINUITY_OK:${runId}`);
    expect(complete.body).not.toContain("CHAT005_CONTINUITY_MISSING");
  });
});
