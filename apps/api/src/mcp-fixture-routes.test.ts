import { afterEach, describe, expect, it } from "vitest";

import { buildApiApplication } from "./app.js";
import {
  mcpFixtureAuthorization,
  mcpFixturePathV1,
  mcpFixturePathV2,
  mcpFixtureToolName,
} from "./mcp-fixture-routes.js";

const runId = "00000000-0000-4000-8000-000000000602";
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
  PLATFORM_MCP_FIXTURE_ENABLED: "true",
};
const applications: ReturnType<typeof buildApiApplication>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async ({ app }) => app.close()));
});

function application(enabled = true): ReturnType<typeof buildApiApplication> {
  const result = buildApiApplication({
    ...environment,
    PLATFORM_MCP_FIXTURE_ENABLED: enabled ? "true" : "false",
  });
  applications.push(result);
  return result;
}

function headers(session?: string): Readonly<Record<string, string>> {
  return {
    authorization: mcpFixtureAuthorization,
    "x-spark-x-run-id": runId,
    ...(session === undefined ? {} : { "mcp-session-id": session }),
  };
}

function request(id: number, method: string, params?: Readonly<Record<string, unknown>>) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

async function initialize(path = mcpFixturePathV1) {
  const response = await application().app.inject({
    method: "POST",
    url: `/api/v1${path}`,
    headers: headers(),
    payload: request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "fixture-test", version: "1" },
    }),
  });
  return response;
}

describe("deterministic Streamable HTTP MCP fixture", () => {
  it("is absent unless the test-environment switch is explicitly enabled", async () => {
    const response = await application(false).app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: headers(),
      payload: request(1, "initialize"),
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects missing authorization before processing the JSON-RPC body", async () => {
    const response = await application().app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: { "x-spark-x-run-id": runId },
      payload: [],
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "MCP_FIXTURE_UNAUTHORIZED" });
  });

  it("requires one valid run identifier and rejects arbitrary JSON-RPC methods or fields", async () => {
    const missingRun = await application().app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: { authorization: mcpFixtureAuthorization },
      payload: request(1, "initialize"),
    });
    const arbitraryMethod = await application().app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: headers(),
      payload: { ...request(1, "arbitrary/forward"), target: "https://example.com" },
    });

    expect(missingRun.statusCode).toBe(400);
    expect(missingRun.json()).toMatchObject({ code: "MCP_FIXTURE_RUN_ID_REQUIRED" });
    expect(arbitraryMethod.statusCode).toBe(400);
    expect(arbitraryMethod.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("issues a run-bound session and returns a fixed initialization contract", async () => {
    const response = await initialize();

    expect(response.statusCode).toBe(200);
    expect(response.headers["mcp-session-id"]).toMatch(/^spark-x-mcp-v1-[0-9a-f]{32}$/u);
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "spark-x-test-platform-mcp-fixture-v1", version: "1.0.0" },
      },
    });
  });

  it("requires the exact issued session after initialization", async () => {
    const initialization = await initialize();
    const session = String(initialization.headers["mcp-session-id"]);
    const accepted = await applications[0]?.app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: headers(session),
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    const denied = await applications[0]?.app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: headers("wrong-session"),
      payload: request(2, "tools/list"),
    });

    expect(accepted?.statusCode).toBe(202);
    expect(denied?.statusCode).toBe(401);
    expect(denied?.json()).toMatchObject({ code: "MCP_FIXTURE_SESSION_INVALID" });
  });

  it("advertises one read-only deterministic tool without arbitrary capabilities", async () => {
    const initialization = await initialize();
    const response = await applications[0]?.app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: headers(String(initialization.headers["mcp-session-id"])),
      payload: request(2, "tools/list"),
    });

    expect(response?.statusCode).toBe(200);
    expect(response?.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: mcpFixtureToolName,
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
          },
        ],
      },
    });
    expect(response?.body).not.toContain("Authorization");
    expect(response?.body).not.toContain("forward");
  });

  it("executes only the fixed run-bound lookup arguments", async () => {
    const initialization = await initialize();
    const session = String(initialization.headers["mcp-session-id"]);
    const rejected = await applications[0]?.app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: headers(session),
      payload: request(2, "tools/call", {
        name: mcpFixtureToolName,
        arguments: { reference: "MCP-FIXTURE:other", limit: 1 },
      }),
    });
    const accepted = await applications[0]?.app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV1}`,
      headers: headers(session),
      payload: request(3, "tools/call", {
        name: mcpFixtureToolName,
        arguments: { reference: `MCP-FIXTURE:${runId}`, limit: 1 },
      }),
    });

    expect(rejected?.statusCode).toBe(400);
    expect(accepted?.statusCode).toBe(200);
    expect(accepted?.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        structuredContent: {
          success: true,
          fixture_version: "v1",
          reference: `MCP-FIXTURE:${runId}`,
          record_count: 1,
          record: { status: "stable", revision: 1 },
        },
        isError: false,
      },
    });
  });

  it("changes both descriptor and result revision only on the fixed v2 path", async () => {
    const initialization = await initialize(mcpFixturePathV2);
    const session = String(initialization.headers["mcp-session-id"]);
    const tools = await applications[0]?.app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV2}`,
      headers: headers(session),
      payload: request(2, "tools/list"),
    });
    const call = await applications[0]?.app.inject({
      method: "POST",
      url: `/api/v1${mcpFixturePathV2}`,
      headers: headers(session),
      payload: request(3, "tools/call", {
        name: mcpFixtureToolName,
        arguments: {
          reference: `MCP-FIXTURE:${runId}`,
          limit: 1,
          revision_hint: "v2",
        },
      }),
    });

    expect(tools?.json()).toMatchObject({
      result: {
        tools: [
          {
            description: "Read one deterministic fixture record (revision two).",
            inputSchema: { properties: { revision_hint: { const: "v2" } } },
          },
        ],
      },
    });
    expect(call?.json()).toMatchObject({
      result: {
        structuredContent: { fixture_version: "v2", record: { revision: 2 } },
      },
    });
  });
});
