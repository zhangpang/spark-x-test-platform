import { describe, expect, it } from "vitest";

import type { EnvironmentRecord, JsonObject } from "./model.js";
import {
  contentHash,
  findPlaintextSecrets,
  redactSecrets,
  validateDefinition,
} from "./validation.js";

function definition(overrides: Readonly<Record<string, unknown>> = {}): JsonObject {
  return {
    schemaVersion: "1.0",
    kind: "automated",
    metadata: {
      name: "HTTP health",
      systemKey: "sample-system",
      moduleKey: "order",
      priority: "P0",
      classification: "blackbox",
      actionLevel: "read",
      tags: ["http"],
    },
    inputs: [],
    execution: {
      stepTimeoutMs: 1000,
      caseTimeoutMs: 5000,
      diagnosticRetries: 0,
    },
    resourceLocks: [],
    steps: [
      {
        id: "request",
        name: "read health",
        kind: "action",
        action: "http:request",
        params: { method: "GET", path: "/healthz" },
        assertions: [],
      },
    ],
    finally: [],
    ...overrides,
  } as JsonObject;
}

const environment: EnvironmentRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  systemId: "00000000-0000-4000-8000-000000000002",
  key: "test",
  name: "Test",
  kind: "test",
  baseUrl: "https://example.test/",
  actionLevel: "read",
  allowlist: [
    {
      protocol: "https",
      host: "example.test",
      ports: [443],
      pathPrefixes: ["/"],
    },
  ],
  timezone: "Asia/Shanghai",
  concurrencyLimit: 5,
  adapterConfig: {},
  status: "active",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("M2 asset validation", () => {
  it("hashes semantically identical JSON deterministically", () => {
    expect(contentHash({ alpha: 1, nested: { second: true, first: "x" } })).toBe(
      contentHash({ nested: { first: "x", second: true }, alpha: 1 }),
    );
  });

  it("rejects plaintext secrets while allowing secret references", () => {
    expect(
      findPlaintextSecrets({
        headers: { authorization: "Bearer real-token-value" },
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PLAINTEXT_SECRET" })]));
    expect(
      findPlaintextSecrets({
        headers: { authorization: "Bearer ${case.authToken}" },
      }),
    ).toEqual([]);

    const unsafeDefault = definition({
      inputs: [
        {
          name: "api-token",
          type: "string",
          required: true,
          default: "plain-value",
        },
      ],
    });
    expect(
      validateDefinition(unsafeDefault, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PLAINTEXT_SECRET" })]));
  });

  it("redacts secret-shaped fields and values from structured output", () => {
    expect(
      redactSecrets({
        token: "plain-value",
        nested: { note: "-----BEGIN PRIVATE KEY-----" },
      }),
    ).toEqual({ token: "[REDACTED]", nested: { note: "[REDACTED]" } });
  });

  it("accepts a valid relative HTTP target in an allowlisted environment", () => {
    expect(
      validateDefinition(definition(), {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects arbitrary absolute targets and duplicate step identifiers", () => {
    const invalid = definition({
      steps: [
        {
          id: "request",
          name: "first",
          kind: "action",
          action: "http:request",
          params: {
            method: "GET",
            path: "/healthz",
            url: "https://bypass.test",
          },
        },
        {
          id: "request",
          name: "second",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
        },
      ],
    });
    const result = validateDefinition(invalid, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["ARBITRARY_TARGET_FORBIDDEN", "DUPLICATE_STEP_ID"]),
    );
  });

  it("accepts declared browser navigation and rejects script-shaped browser input", () => {
    const browserDefinition = definition({
      metadata: {
        name: "Browser health",
        systemKey: "sample-system",
        moduleKey: "order",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "read",
        tags: ["browser"],
      },
      steps: [
        {
          id: "open",
          name: "open health",
          kind: "action",
          action: "browser:navigate",
          params: { path: "/healthz", expectedStatus: 200 },
        },
      ],
    });
    expect(
      validateDefinition(browserDefinition, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = definition({
      steps: [
        {
          id: "open",
          name: "unsafe",
          kind: "action",
          action: "browser:navigate",
          params: { path: "/healthz", evaluate: "document.cookie" },
        },
      ],
    });
    expect(
      validateDefinition(unsafe, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ARBITRARY_BROWSER_INPUT_FORBIDDEN" }),
      ]),
    );
  });

  it("accepts bounded HTTP polling and rejects arbitrary wait inputs", () => {
    const polling = definition({
      steps: [
        {
          id: "wait-index",
          name: "wait for index",
          kind: "action",
          action: "wait:http",
          timeoutMs: 5_000,
          params: {
            path: "/tasks/${run.id}",
            intervalMs: 250,
            condition: {
              path: "$.body.state",
              operator: "equals",
              expected: "ready",
            },
          },
        },
      ],
    });
    expect(
      validateDefinition(polling, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = definition({
      steps: [
        {
          id: "wait-index",
          name: "unsafe wait",
          kind: "action",
          action: "wait:http",
          params: {
            path: "https://bypass.test/tasks/1",
            method: "POST",
            script: "return response.body.ready",
            condition: { path: "$[0]", operator: "eval" },
          },
        },
      ],
    });
    const result = validateDefinition(unsafe, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "WAIT_HTTP_PATH_INVALID",
        "ARBITRARY_WAIT_INPUT_FORBIDDEN",
        "WAIT_CONDITION_INVALID",
      ]),
    );
  });

  it("accepts an ordered HTTP to JSON variable chain", () => {
    const jsonDefinition = definition({
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          capture: { "health-body": "$.body" },
        },
        {
          id: "extract-status",
          name: "extract status",
          kind: "action",
          action: "json:extract",
          params: { source: "${step.health-body}", path: "$.items[0].status" },
          capture: { "health-status": "$.value" },
        },
        {
          id: "assert-status",
          name: "assert status",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.health-body}",
            path: "$.items[0].status",
            operator: "equals",
            expected: "${step.health-status}",
          },
        },
      ],
    });
    expect(
      validateDefinition(jsonDefinition, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it("rejects unsafe JSON paths, unknown sources and arbitrary JSON inputs", () => {
    const unsafe = definition({
      steps: [
        {
          id: "unsafe-json",
          name: "unsafe json",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.future-body}",
            path: "$.items[?(@.ready)].status",
            operator: "eval",
            script: "return value",
          },
        },
      ],
    });
    const result = validateDefinition(unsafe, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "ARBITRARY_JSON_INPUT_FORBIDDEN",
        "JSON_SOURCE_REFERENCE_UNKNOWN",
        "JSON_PATH_INVALID",
        "JSON_OPERATOR_INVALID",
      ]),
    );
  });

  it("requires comparison values and rejects values on exists JSON assertions", () => {
    const invalid = definition({
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          capture: { body: "$.body" },
        },
        {
          id: "missing-expected",
          name: "missing expected",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.body}",
            path: "$.state",
            operator: "equals",
          },
        },
        {
          id: "unexpected-expected",
          name: "unexpected expected",
          kind: "action",
          action: "json:assert",
          params: {
            source: "${step.body}",
            path: "$.state",
            operator: "exists",
            expected: true,
          },
        },
      ],
    });
    expect(
      validateDefinition(invalid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining(["JSON_EXPECTED_VALUE_REQUIRED", "JSON_EXPECTED_VALUE_FORBIDDEN"]),
    );
  });

  it("rejects capture paths that the runtime cannot resolve", () => {
    const invalid = definition({
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          capture: { body: "$.items[0]" },
        },
      ],
    });
    expect(
      validateDefinition(invalid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CAPTURE_PATH_INVALID" })]));
  });

  it("validates ordered step references while allowing declared case defaults", () => {
    const valid = definition({
      inputs: [{ name: "region", type: "string", required: true, default: "cn" }],
      steps: [
        {
          id: "read-health",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/${case.region}/healthz" },
          capture: { status: "$.status" },
        },
        {
          id: "use-status",
          name: "use status",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/status/${step.status}" },
        },
      ],
    });
    expect(
      validateDefinition(valid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const invalid = definition({
      steps: [
        {
          id: "use-future",
          name: "use future",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/status/${step.future}" },
        },
      ],
    });
    expect(
      validateDefinition(invalid, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }).issues,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "VARIABLE_REFERENCE_UNKNOWN" })]),
    );
  });

  it("requires cleanup and sufficient environment privilege for write cases", () => {
    const writeDefinition = definition({
      metadata: {
        name: "create order",
        systemKey: "sample-system",
        moduleKey: "order",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "write",
        tags: ["http"],
      },
      steps: [
        {
          id: "request",
          name: "create",
          kind: "action",
          action: "http:request",
          params: { method: "POST", path: "/orders" },
        },
      ],
    });
    const result = validateDefinition(writeDefinition, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["ACTION_LEVEL_EXCEEDS_ENVIRONMENT", "CLEANUP_REQUIRED"]),
    );
  });

  it("accepts a fail-closed resource registration and rejects unsafe cleanup references", () => {
    const safe = definition({
      resourceLocks: ["knowledge-base:${run.id}"],
      steps: [
        {
          id: "request",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          resource: {
            type: "knowledge-base",
            id: "${run.id}",
            cleanup: {
              action: "http:request",
              params: {
                method: "GET",
                path: "/healthz?resource=${resource.id}",
              },
            },
          },
        },
      ],
      finally: [
        {
          id: "cleanup",
          name: "cleanup",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
        },
      ],
    });
    expect(
      validateDefinition(safe, {
        systemKey: "sample-system",
        moduleKey: "order",
        environment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = definition({
      resourceLocks: ["knowledge-base:${case.secret}"],
      steps: [
        {
          id: "request",
          name: "read health",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
          resource: {
            type: "knowledge-base",
            id: "${run.id}",
            cleanup: {
              action: "http:request",
              params: {
                method: "GET",
                path: "/healthz?resource=${step.untrusted}",
              },
            },
          },
        },
      ],
      finally: [
        {
          id: "cleanup",
          name: "cleanup",
          kind: "action",
          action: "http:request",
          params: { method: "GET", path: "/healthz" },
        },
      ],
    });
    const result = validateDefinition(unsafe, {
      systemKey: "sample-system",
      moduleKey: "order",
      environment,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CLEANUP_REFERENCE_FORBIDDEN", "RESOURCE_LOCK_REFERENCE_FORBIDDEN"]),
    );
  });

  it("accepts a traceable Spark X Agent conversation case with adapter compensation", () => {
    const sparkEnvironment: EnvironmentRecord = {
      ...environment,
      systemId: "00000000-0000-4000-8000-000000000010",
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
      adapterKey: "spark-x-agent",
    };
    const adapterDefinition = definition({
      metadata: {
        name: "CONV-001 recent conversation lifecycle",
        systemKey: "spark-x-agent",
        moduleKey: "recent-conversations",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "dangerous",
        tags: ["adapter", "core-smoke"],
      },
      inputs: [
        {
          name: "admin-username",
          type: "string",
          required: true,
          secretRef: "spark-x-agent-admin-username",
        },
        {
          name: "admin-password",
          type: "string",
          required: true,
          secretRef: "spark-x-agent-admin-password",
        },
      ],
      resourceLocks: ["spark-x-agent-conversation:${run.id}"],
      steps: [
        {
          id: "create-conversation",
          name: "create conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.create",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            title: "spark-x-regression-${run.id}",
          },
          capture: { "conversation-id": "$.conversationId" },
          resource: {
            type: "spark-x-agent-conversation",
            id: "${step.conversation-id}",
            cleanup: {
              action: "adapter:spark-x-agent/conversation.delete",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                conversationId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "assert-recent",
          name: "assert recent conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.assert-recent",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
            title: "spark-x-regression-${run.id}",
            expectedMessageCount: 0,
          },
        },
      ],
      finally: [
        {
          id: "delete-conversation",
          name: "delete conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.delete",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
          },
        },
      ],
    });

    expect(
      validateDefinition(adapterDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "recent-conversations",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = definition({
      metadata: adapterDefinition.metadata,
      inputs: adapterDefinition.inputs,
      steps: [
        {
          id: "create-conversation",
          name: "unsafe create",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.create",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            title: "untraceable",
            script: "return process.env",
          },
        },
      ],
      finally: adapterDefinition.finally,
    });
    expect(
      validateDefinition(unsafe, {
        systemKey: "spark-x-agent",
        moduleKey: "recent-conversations",
        environment: sparkEnvironment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "ARBITRARY_ADAPTER_INPUT_FORBIDDEN",
        "ADAPTER_RESOURCE_REGISTRATION_REQUIRED",
        "RUN_TRACEABILITY_REQUIRED",
      ]),
    );
  });

  it("accepts a traceable Spark X Agent chat lifecycle and rejects unregistered chat inputs", () => {
    const sparkEnvironment: EnvironmentRecord = {
      ...environment,
      systemId: "00000000-0000-4000-8000-000000000010",
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
      adapterKey: "spark-x-agent",
    };
    const inputs = [
      {
        name: "admin-username",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-password",
      },
    ];
    const chatDefinition = definition({
      metadata: {
        name: "CHAT-001 stream and history",
        systemKey: "spark-x-agent",
        moduleKey: "chat",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "dangerous",
        tags: ["adapter", "core-smoke"],
      },
      inputs,
      resourceLocks: ["spark-x-agent:admin:chat"],
      steps: [
        {
          id: "create-conversation",
          name: "create conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.create",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            title: "spark-x-chat-${run.id}",
          },
          capture: { "conversation-id": "$.conversationId" },
          resource: {
            type: "spark-x-agent-conversation",
            id: "${step.conversation-id}",
            cleanup: {
              action: "adapter:spark-x-agent/conversation.delete",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                conversationId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "ask",
          name: "ask",
          kind: "action",
          action: "adapter:spark-x-agent/chat.ask",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
            message: "自动化回归标识 spark-x-chat-${run.id}。请只回复这个标识。",
            expectedText: "spark-x-chat-${run.id}",
          },
          capture: { "assistant-sha256": "$.finalContentSha256" },
        },
        {
          id: "assert-history",
          name: "assert history",
          kind: "action",
          action: "adapter:spark-x-agent/chat.assert-history",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
            expectedUserText: "自动化回归标识 spark-x-chat-${run.id}。请只回复这个标识。",
            expectedAssistantText: "spark-x-chat-${run.id}",
            expectedAssistantSha256: "${step.assistant-sha256}",
          },
        },
      ],
      finally: [
        {
          id: "delete-conversation",
          name: "delete conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.delete",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
          },
        },
      ],
    });

    expect(
      validateDefinition(chatDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "chat",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const contextDefinition = definition({
      metadata: {
        name: "CHAT-002 two-turn context history",
        systemKey: "spark-x-agent",
        moduleKey: "chat",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "dangerous",
        tags: ["adapter", "core-smoke", "context"],
      },
      inputs,
      steps: [
        {
          id: "create-context-conversation",
          name: "create context conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.create",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            title: "spark-x-context-${run.id}",
          },
          capture: { "conversation-id": "$.conversationId" },
          resource: {
            type: "spark-x-agent-conversation",
            id: "${step.conversation-id}",
            cleanup: {
              action: "adapter:spark-x-agent/conversation.delete",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                conversationId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "assert-context-history",
          name: "assert context history",
          kind: "action",
          action: "adapter:spark-x-agent/chat.assert-context-history",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
            firstUserText: "请记住上下文标识 spark-x-context-${run.id}，并只回复这个标识。",
            firstAssistantSha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            secondUserText: "请只回复上一轮的上下文标识；本轮校验号 ${run.id}。",
            secondExpectedText: "spark-x-context-${run.id}",
            secondAssistantSha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            forbiddenText: "spark-x-decoy-${run.id}",
          },
        },
      ],
      finally: [
        {
          id: "delete-context-conversation",
          name: "delete context conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.delete",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
          },
        },
      ],
    });
    expect(
      validateDefinition(contextDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "chat",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafeContext = {
      ...contextDefinition,
      steps: [
        {
          ...(contextDefinition.steps as readonly JsonObject[])[1],
          params: {
            ...((contextDefinition.steps as readonly JsonObject[])[1]?.params as JsonObject),
            forbiddenText: "untraceable",
            script: "return process.env",
          },
        },
      ],
    } as JsonObject;
    expect(
      validateDefinition(unsafeContext, {
        systemKey: "spark-x-agent",
        moduleKey: "chat",
        environment: sparkEnvironment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining(["ARBITRARY_ADAPTER_INPUT_FORBIDDEN", "RUN_TRACEABILITY_REQUIRED"]),
    );

    const unsafe = definition({
      metadata: chatDefinition.metadata,
      inputs,
      steps: [
        {
          id: "ask",
          name: "unsafe ask",
          kind: "action",
          action: "adapter:spark-x-agent/chat.ask",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "00000000-0000-4000-8000-000000000014",
            message: "untraceable",
            expectedText: "answer",
            script: "return process.env",
          },
        },
      ],
      finally: [],
    });
    expect(
      validateDefinition(unsafe, {
        systemKey: "spark-x-agent",
        moduleKey: "chat",
        environment: sparkEnvironment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining(["ARBITRARY_ADAPTER_INPUT_FORBIDDEN", "RUN_TRACEABILITY_REQUIRED"]),
    );
  });

  it("accepts the bounded Spark X Agent safe-tool cases and rejects arbitrary or untraceable inputs", () => {
    const sparkEnvironment: EnvironmentRecord = {
      ...environment,
      systemId: "00000000-0000-4000-8000-000000000010",
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
      adapterKey: "spark-x-agent",
    };
    const inputs = [
      {
        name: "admin-username",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-password",
      },
    ];
    const catalogDefinition = definition({
      metadata: {
        name: "TOOL-001 safe tool catalog",
        systemKey: "spark-x-agent",
        moduleKey: "tools",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "read",
        tags: ["adapter", "core-smoke", "tool"],
      },
      inputs,
      steps: [
        {
          id: "assert-safe-catalog",
          name: "assert safe catalog",
          kind: "action",
          action: "adapter:spark-x-agent/tool.assert-safe-catalog",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
          },
        },
      ],
    });
    expect(
      validateDefinition(catalogDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "tools",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const invocationDefinition = definition({
      metadata: {
        name: "TOOL-002 safe tool invocation",
        systemKey: "spark-x-agent",
        moduleKey: "tools",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "dangerous",
        tags: ["adapter", "core-smoke", "tool"],
      },
      inputs,
      resourceLocks: ["spark-x-agent:admin:tools"],
      steps: [
        {
          id: "create-conversation",
          name: "create conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.create",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            title: "spark-x-tool-${run.id}",
          },
          capture: { "conversation-id": "$.conversationId" },
          resource: {
            type: "spark-x-agent-conversation",
            id: "${step.conversation-id}",
            cleanup: {
              action: "adapter:spark-x-agent/conversation.delete",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                conversationId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "assert-safe-tool-precondition",
          name: "assert safe tool precondition",
          kind: "action",
          action: "adapter:spark-x-agent/tool.assert-safe-catalog",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
          },
        },
        {
          id: "invoke-safe-tool",
          name: "invoke safe tool",
          kind: "action",
          action: "adapter:spark-x-agent/tool.invoke-safe",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
            message:
              "自动化回归 ${run.id}：只调用一次 builtin-demo__calculator 计算 6×7，并回复 spark-x-tool-${run.id}:42。",
            expectedText: "spark-x-tool-${run.id}:42",
            expectedToolName: "builtin-demo__calculator",
            expectedArgumentsJson: '{"operation":"multiply","a":6,"b":7}',
            expectedResultJson: '{"success":true,"operation":"multiply","a":6,"b":7,"result":42}',
          },
          capture: {
            "assistant-sha256": "$.finalContentSha256",
            "arguments-sha256": "$.argumentsSha256",
            "result-sha256": "$.resultSha256",
          },
        },
        {
          id: "assert-tool-history",
          name: "assert tool history",
          kind: "action",
          action: "adapter:spark-x-agent/tool.assert-history",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
            expectedUserText:
              "自动化回归 ${run.id}：只调用一次 builtin-demo__calculator 计算 6×7，并回复 spark-x-tool-${run.id}:42。",
            expectedAssistantText: "spark-x-tool-${run.id}:42",
            expectedAssistantSha256: "${step.assistant-sha256}",
            expectedToolName: "builtin-demo__calculator",
            expectedArgumentsSha256: "${step.arguments-sha256}",
            expectedResultSha256: "${step.result-sha256}",
          },
        },
      ],
      finally: [
        {
          id: "delete-conversation",
          name: "delete conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.delete",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
          },
        },
      ],
    });
    expect(
      validateDefinition(invocationDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "tools",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafeInvocation = {
      ...invocationDefinition,
      steps: [
        {
          ...(invocationDefinition.steps as readonly JsonObject[])[2],
          params: {
            ...((invocationDefinition.steps as readonly JsonObject[])[2]?.params as JsonObject),
            message: "只调用计算器计算 6×7。",
            script: "return process.env",
          },
        },
      ],
      finally: [],
    } as JsonObject;
    expect(
      validateDefinition(unsafeInvocation, {
        systemKey: "spark-x-agent",
        moduleKey: "tools",
        environment: sparkEnvironment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining(["ARBITRARY_ADAPTER_INPUT_FORBIDDEN", "RUN_TRACEABILITY_REQUIRED"]),
    );
  });

  it("accepts a fixed-fixture knowledge-base lifecycle and rejects arbitrary upload or cleanup scope", () => {
    const sparkEnvironment: EnvironmentRecord = {
      ...environment,
      systemId: "00000000-0000-4000-8000-000000000010",
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
      adapterKey: "spark-x-agent",
    };
    const inputs = [
      {
        name: "admin-username",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-password",
      },
    ];
    const knowledgeDefinition = definition({
      metadata: {
        name: "KB-001 fixed fixture lifecycle",
        systemKey: "spark-x-agent",
        moduleKey: "knowledge-base",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "dangerous",
        tags: ["adapter", "core-smoke", "knowledge-base"],
      },
      inputs,
      execution: {
        stepTimeoutMs: 180_000,
        caseTimeoutMs: 480_000,
        diagnosticRetries: 0,
      },
      resourceLocks: ["spark-x-agent:admin:knowledge-base"],
      steps: [
        {
          id: "create-knowledge-base",
          name: "create knowledge base",
          kind: "action",
          action: "adapter:spark-x-agent/knowledge-base.create",
          timeoutMs: 20_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            name: "spark-x-kb-${run.id}",
            description: "fixed fixture",
          },
          capture: { "knowledge-base-id": "$.knowledgeBaseId" },
          resource: {
            type: "spark-x-agent-knowledge-base",
            id: "${step.knowledge-base-id}",
            cleanup: {
              action: "adapter:spark-x-agent/knowledge-base.cleanup",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                knowledgeBaseId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "upload-fixture",
          name: "upload fixture",
          kind: "action",
          action: "adapter:spark-x-agent/knowledge-base.upload-fixture",
          timeoutMs: 180_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
          },
          capture: {
            "uploaded-document-id": "$.uploadedDocumentId",
            "fixture-sha256": "$.fixtureSha256",
          },
        },
        {
          id: "attach-fixture",
          name: "attach fixture",
          kind: "action",
          action: "adapter:spark-x-agent/knowledge-base.attach-upload",
          timeoutMs: 30_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
            uploadedDocumentId: "${step.uploaded-document-id}",
            title: "spark-x-kb-${run.id}.pdf",
          },
          capture: { "knowledge-document-id": "$.knowledgeDocumentId" },
        },
        {
          id: "wait-ready",
          name: "wait ready",
          kind: "action",
          action: "adapter:spark-x-agent/knowledge-base.wait-ready",
          timeoutMs: 180_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
            knowledgeDocumentId: "${step.knowledge-document-id}",
            expectedFixtureSha256: "${step.fixture-sha256}",
            expectedTitle: "spark-x-kb-${run.id}.pdf",
          },
        },
      ],
      finally: [
        {
          id: "cleanup-knowledge-base",
          name: "cleanup knowledge base",
          kind: "action",
          action: "adapter:spark-x-agent/knowledge-base.cleanup",
          timeoutMs: 180_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            knowledgeBaseId: "${step.knowledge-base-id}",
          },
        },
      ],
    });

    expect(
      validateDefinition(knowledgeDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "knowledge-base",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const steps = knowledgeDefinition.steps as readonly JsonObject[];
    const unsafe = {
      ...knowledgeDefinition,
      steps: [
        {
          ...steps[0],
          params: {
            ...(steps[0]?.params as JsonObject),
            name: "untraceable",
          },
          capture: { "knowledge-base-id": "$.wrongId" },
          resource: {
            ...(steps[0]?.resource as JsonObject),
            cleanup: {
              action: "adapter:spark-x-agent/knowledge-base.cleanup",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                knowledgeBaseId: "00000000-0000-4000-8000-000000000099",
              },
            },
          },
        },
        {
          ...steps[1],
          params: {
            ...(steps[1]?.params as JsonObject),
            file: "../../secret.txt",
            sourceUrl: "http://attacker.invalid/file",
            script: "return process.env",
          },
        },
      ],
      finally: [],
    } as JsonObject;
    expect(
      validateDefinition(unsafe, {
        systemKey: "spark-x-agent",
        moduleKey: "knowledge-base",
        environment: sparkEnvironment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "RUN_TRACEABILITY_REQUIRED",
        "ADAPTER_RESOURCE_ID_CAPTURE_REQUIRED",
        "CLEANUP_RESOURCE_SCOPE_REQUIRED",
        "ARBITRARY_ADAPTER_INPUT_FORBIDDEN",
      ]),
    );
  });

  it("accepts the registered automation lifecycle and rejects unscoped cleanup or arbitrary input", () => {
    const sparkEnvironment: EnvironmentRecord = {
      ...environment,
      systemId: "00000000-0000-4000-8000-000000000010",
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
      adapterKey: "spark-x-agent",
    };
    const inputs = [
      {
        name: "admin-username",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-username",
      },
      {
        name: "admin-password",
        type: "string",
        required: true,
        secretRef: "spark-x-agent-admin-password",
      },
    ];
    const automationDefinition = definition({
      metadata: {
        name: "AUTO-001 immediate automation lifecycle",
        systemKey: "spark-x-agent",
        moduleKey: "automations",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "dangerous",
        tags: ["adapter", "core-smoke", "automation"],
      },
      inputs,
      execution: {
        stepTimeoutMs: 180_000,
        caseTimeoutMs: 300_000,
        diagnosticRetries: 0,
      },
      resourceLocks: ["spark-x-agent:admin:automations"],
      steps: [
        {
          id: "create-conversation",
          name: "create conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.create",
          timeoutMs: 20_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            title: "spark-x-auto-${run.id}",
          },
          capture: { "conversation-id": "$.conversationId" },
          resource: {
            type: "spark-x-agent-conversation",
            id: "${step.conversation-id}",
            cleanup: {
              action: "adapter:spark-x-agent/conversation.delete",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                conversationId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "create-automation",
          name: "create automation",
          kind: "action",
          action: "adapter:spark-x-agent/automation.create",
          timeoutMs: 20_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
            name: "spark-x-auto-${run.id}",
            goal: "reply only with spark-x-auto-${run.id}",
          },
          capture: { "automation-id": "$.automationId" },
          resource: {
            type: "spark-x-agent-automation",
            id: "${step.automation-id}",
            cleanup: {
              action: "adapter:spark-x-agent/automation.cleanup",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                automationId: "${resource.id}",
              },
            },
          },
        },
        {
          id: "wait-fired",
          name: "wait fired",
          kind: "action",
          action: "adapter:spark-x-agent/automation.wait-fired",
          timeoutMs: 180_000,
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            automationId: "${step.automation-id}",
            conversationId: "${step.conversation-id}",
            expectedName: "spark-x-auto-${run.id}",
            expectedGoal: "reply only with spark-x-auto-${run.id}",
            expectedAssistantText: "spark-x-auto-${run.id}",
          },
        },
      ],
      finally: [
        {
          id: "cleanup-automation",
          name: "cleanup automation",
          kind: "action",
          action: "adapter:spark-x-agent/automation.cleanup",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            automationId: "${step.automation-id}",
          },
        },
        {
          id: "delete-conversation",
          name: "delete conversation",
          kind: "action",
          action: "adapter:spark-x-agent/conversation.delete",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            conversationId: "${step.conversation-id}",
          },
        },
      ],
    });

    expect(
      validateDefinition(automationDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "automations",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const steps = automationDefinition.steps as readonly JsonObject[];
    const unsafe = {
      ...automationDefinition,
      steps: [
        steps[0],
        {
          ...steps[1],
          params: {
            ...(steps[1]?.params as JsonObject),
            name: "untraceable",
            script: "return process.env",
          },
          capture: { "automation-id": "$.wrongId" },
          resource: {
            ...(steps[1]?.resource as JsonObject),
            cleanup: {
              action: "adapter:spark-x-agent/automation.cleanup",
              params: {
                username: "${case.admin-username}",
                password: "${case.admin-password}",
                automationId: "00000000-0000-4000-8000-000000000099",
              },
            },
          },
        },
        steps[2],
      ],
    } as JsonObject;
    expect(
      validateDefinition(unsafe, {
        systemKey: "spark-x-agent",
        moduleKey: "automations",
        environment: sparkEnvironment,
      }).issues.map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        "RUN_TRACEABILITY_REQUIRED",
        "ADAPTER_RESOURCE_ID_CAPTURE_REQUIRED",
        "CLEANUP_RESOURCE_SCOPE_REQUIRED",
        "ARBITRARY_ADAPTER_INPUT_FORBIDDEN",
      ]),
    );
  });

  it("accepts only the registered read-only trusted Skill publication assertion", () => {
    const sparkEnvironment: EnvironmentRecord = {
      ...environment,
      systemId: "00000000-0000-4000-8000-000000000010",
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
      adapterKey: "spark-x-agent",
    };
    const skillDefinition = definition({
      metadata: {
        name: "SKILL-001 trusted publication",
        systemKey: "spark-x-agent",
        moduleKey: "skills",
        priority: "P0",
        classification: "blackbox",
        actionLevel: "read",
        tags: ["adapter", "core-smoke", "skill", "trusted-publication"],
      },
      inputs: [
        {
          name: "admin-username",
          type: "string",
          required: true,
          secretRef: "spark-x-agent-admin-username",
        },
        {
          name: "admin-password",
          type: "string",
          required: true,
          secretRef: "spark-x-agent-admin-password",
        },
      ],
      steps: [
        {
          id: "assert-trusted-publication",
          name: "assert trusted publication",
          kind: "action",
          action: "adapter:spark-x-agent/skill.assert-trusted-publication",
          params: {
            username: "${case.admin-username}",
            password: "${case.admin-password}",
            expectedPublicationSha256:
              "a5de94a8db8803916c772c214ac22e6d2c8cdca3e1555d97f013fdf4585803cc",
          },
        },
      ],
    });

    expect(
      validateDefinition(skillDefinition, {
        systemKey: "spark-x-agent",
        moduleKey: "skills",
        environment: sparkEnvironment,
      }),
    ).toEqual({ valid: true, issues: [] });

    const unsafe = {
      ...skillDefinition,
      steps: [
        {
          ...(skillDefinition.steps as readonly JsonObject[])[0],
          params: {
            ...((skillDefinition.steps as readonly JsonObject[])[0]?.params as JsonObject),
            script: "return process.env",
            prompt: "arbitrary prompt",
          },
        },
      ],
    } as JsonObject;
    expect(
      validateDefinition(unsafe, {
        systemKey: "spark-x-agent",
        moduleKey: "skills",
        environment: sparkEnvironment,
      }).issues.map((issue) => issue.code),
    ).toContain("ARBITRARY_ADAPTER_INPUT_FORBIDDEN");
  });
});
