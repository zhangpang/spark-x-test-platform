import { afterEach, describe, expect, it } from "vitest";

import { buildApiApplication } from "./app.js";
import {
  skillInjectionFixtureApiKey,
  skillInjectionFixtureModel,
  skillInjectionFixturePath,
} from "./skill-injection-fixture-routes.js";

const runId = "00000000-0000-4000-8000-000000000502";
const endpoint = `/api/v1${skillInjectionFixturePath}`;
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
  PLATFORM_SKILL_INJECTION_FIXTURE_ENABLED: "true",
};
const applications: ReturnType<typeof buildApiApplication>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async ({ app }) => app.close()));
});

function application(enabled = true): ReturnType<typeof buildApiApplication> {
  const result = buildApiApplication({
    ...environment,
    PLATFORM_SKILL_INJECTION_FIXTURE_ENABLED: enabled ? "true" : "false",
  });
  applications.push(result);
  return result;
}

function fixtureHeaders(): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${skillInjectionFixtureApiKey}` };
}

function requestPayload(
  messages: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>> {
  return {
    model: skillInjectionFixtureModel,
    messages,
    max_tokens: 4096,
    temperature: 0.7,
    stream: true,
    tools: [],
  };
}

describe("selected Skill injection Provider fixture", () => {
  it("is absent unless the test-environment switch is explicitly enabled", async () => {
    const response = await application(false).app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload([{ role: "user", content: `SKILL002_USE:${runId}` }]),
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects missing fixture authentication before processing the body", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      payload: requestPayload([{ role: "user", content: `SKILL002_USE:${runId}` }]),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "SKILL_INJECTION_FIXTURE_UNAUTHORIZED" });
  });

  it("rejects unsupported models and request fields instead of becoming a generic endpoint", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: {
        ...requestPayload([{ role: "user", content: `SKILL002_USE:${runId}` }]),
        model: "arbitrary-model",
        forwardingTarget: "https://example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("returns a missing marker when only the public catalog names the Skill", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload([
        {
          role: "system",
          content: "可用技能：trade-port-daily-brief 与 import-original-manifest-generation",
        },
        { role: "user", content: `SKILL002_USE:${runId}` },
      ]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`SKILL002_INJECTION_MISSING:${runId}`);
    expect(response.body).not.toContain(`SKILL002_APPLIED:${runId}`);
  });

  it("rejects a second selected Skill body even when the trusted body is present", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload([
        {
          role: "system",
          content: "当前会话 active_skill = `trade-port-daily-brief`。",
        },
        {
          role: "system",
          content:
            "# 海关知识检索-快速\n唯一允许的网页工具是 `tencent-web-search__web_search`\n# 贸易与港口每日简报",
        },
        { role: "system", content: "# 进口原始舱单智能生成" },
        { role: "user", content: `SKILL002_USE:${runId}` },
      ]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`SKILL002_INJECTION_MISSING:${runId}`);
  });

  it("returns the applied marker only for one exact selected Skill body and active context", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: endpoint,
      headers: fixtureHeaders(),
      payload: requestPayload([
        { role: "system", content: "可用技能目录" },
        {
          role: "system",
          content: "当前会话 active_skill = `trade-port-daily-brief`。",
        },
        {
          role: "system",
          content:
            "# 海关知识检索-快速\n唯一允许的网页工具是 `tencent-web-search__web_search`\n# 贸易与港口每日简报",
        },
        { role: "user", content: `SKILL002_USE:${runId}` },
      ]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain(`SKILL002_APPLIED:${runId}`);
    expect(response.body).not.toContain("海关知识检索-快速");
    expect(response.body.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });
});
