import type { FastifyInstance, FastifyRequest } from "fastify";

import { ControlPlaneError, badRequest } from "./control-plane/errors.js";

export const contextCompactionFixtureApiKey =
  "spark-x-test-platform-noncredential-context-compaction-fixture";
export const contextCompactionFixtureModel = "spark-x-test-platform-context-compaction-model";
export const contextCompactionFixturePath =
  "/fixtures/openai/context-compaction/v1/chat/completions";

const summaryPromptPrefix = "You summarize prior agent conversation state.";
const summaryCarrierStart = "[CONTEXT_COMPACTION_SUMMARY_V1]";
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const runMarkerPattern = /CHAT005_(?:TOOL|FILL|CONTINUE):([0-9a-f-]{36})/iu;
const maxFixtureMessages = 96;
const maxFixtureTextBytes = 900_000;

interface FixtureMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly unknown[];
}

interface FixtureRequest {
  readonly model: string;
  readonly messages: readonly FixtureMessage[];
  readonly stream: boolean;
  readonly max_tokens: number;
  readonly temperature: number;
  readonly tools?: readonly unknown[];
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function authorize(request: FastifyRequest): void {
  const authorization = headerValue(request.headers.authorization);
  if (authorization !== `Bearer ${contextCompactionFixtureApiKey}`) {
    throw new ControlPlaneError(
      "CONTEXT_COMPACTION_FIXTURE_UNAUTHORIZED",
      "上下文压缩夹具认证失败。",
      401,
    );
  }
}

function messageValue(value: unknown): FixtureMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("上下文压缩夹具消息必须是对象。");
  }
  const message = value as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(String(message.role))) {
    throw badRequest("上下文压缩夹具消息角色不受支持。");
  }
  if (
    message.content !== undefined &&
    message.content !== null &&
    typeof message.content !== "string"
  ) {
    throw badRequest("上下文压缩夹具消息内容必须是字符串或 null。");
  }
  if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") {
    throw badRequest("上下文压缩夹具工具结果标识必须是字符串。");
  }
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw badRequest("上下文压缩夹具工具调用必须是数组。");
  }
  return message as unknown as FixtureMessage;
}

function fixtureRequestValue(body: unknown): FixtureRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("上下文压缩夹具请求体必须是对象。");
  }
  const input = body as Record<string, unknown>;
  const allowedKeys = ["model", "messages", "stream", "max_tokens", "temperature", "tools"];
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw badRequest("上下文压缩夹具请求包含未支持字段。");
  }
  if (input.model !== contextCompactionFixtureModel) {
    throw badRequest("上下文压缩夹具模型不匹配。");
  }
  if (
    !Array.isArray(input.messages) ||
    input.messages.length === 0 ||
    input.messages.length > maxFixtureMessages
  ) {
    throw badRequest("上下文压缩夹具消息数量超出受控边界。");
  }
  if (typeof input.stream !== "boolean") {
    throw badRequest("上下文压缩夹具 stream 字段必须是布尔值。");
  }
  if (
    !Number.isInteger(input.max_tokens) ||
    (input.max_tokens as number) < 1 ||
    (input.max_tokens as number) > 65_536
  ) {
    throw badRequest("上下文压缩夹具 max_tokens 超出受控边界。");
  }
  if (typeof input.temperature !== "number" || !Number.isFinite(input.temperature)) {
    throw badRequest("上下文压缩夹具 temperature 字段无效。");
  }
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 64)) {
    throw badRequest("上下文压缩夹具工具定义超出受控边界。");
  }
  const messages = input.messages.map(messageValue);
  const textBytes = messages.reduce(
    (total, message) =>
      total +
      Buffer.byteLength(message.content ?? "", "utf8") +
      Buffer.byteLength(JSON.stringify(message.tool_calls ?? []), "utf8"),
    0,
  );
  if (textBytes > maxFixtureTextBytes) {
    throw badRequest("上下文压缩夹具消息内容超出受控边界。");
  }
  return {
    model: input.model,
    messages,
    stream: input.stream,
    max_tokens: input.max_tokens as number,
    temperature: input.temperature,
    ...(input.tools === undefined ? {} : { tools: input.tools }),
  };
}

function latestUserContent(messages: readonly FixtureMessage[]): string | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.role === "user" && typeof message.content === "string")?.content as
    | string
    | undefined;
}

function runIdFromMarker(value: string): string | undefined {
  const runId = runMarkerPattern.exec(value)?.[1];
  return runId !== undefined && runIdPattern.test(runId) ? runId.toLowerCase() : undefined;
}

interface FixtureToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

function toolCallIdentity(value: unknown): FixtureToolCall | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const call = value as Record<string, unknown>;
  if (typeof call.id === "string" && typeof call.name === "string") {
    return { id: call.id, name: call.name, arguments: call.arguments };
  }
  const functionValue = call.function;
  if (
    typeof call.id !== "string" ||
    typeof functionValue !== "object" ||
    functionValue === null ||
    Array.isArray(functionValue)
  ) {
    return undefined;
  }
  const name = (functionValue as Record<string, unknown>).name;
  return typeof name === "string"
    ? {
        id: call.id,
        name,
        arguments: (functionValue as Record<string, unknown>).arguments,
      }
    : undefined;
}

function structuredObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Readonly<Record<string, unknown>>)
    : undefined;
}

function summaryEvidence(messages: readonly FixtureMessage[]): Readonly<{
  runId?: string;
  toolStateComplete: boolean;
}> {
  const userMessage = messages.find(
    (message) => message.role === "user" && typeof message.content === "string",
  );
  const userPrompt = userMessage?.content;
  if (typeof userPrompt !== "string") return { toolStateComplete: false };
  let data: unknown;
  try {
    data = JSON.parse(userPrompt) as unknown;
  } catch {
    return { toolStateComplete: false };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { toolStateComplete: false };
  }
  const messagesToCompact = (data as Record<string, unknown>).messages_to_compact;
  if (!Array.isArray(messagesToCompact)) return { toolStateComplete: false };
  const compacted = messagesToCompact.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null && !Array.isArray(message),
  );
  const runId = compacted
    .map((message) =>
      typeof message.content === "string" ? runIdFromMarker(message.content) : undefined,
    )
    .find((value) => value !== undefined);
  if (runId === undefined) return { toolStateComplete: false };
  const rawToolCalls: unknown[] = [];
  for (const message of compacted) {
    const toolCalls: unknown = message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const toolCall of toolCalls) rawToolCalls.push(toolCall as unknown);
  }
  const toolCall = rawToolCalls.map(toolCallIdentity).find((call) => {
    const toolArguments = structuredObject(call?.arguments);
    return (
      call?.name === "document_search" &&
      toolArguments?.query === `spark-x-chat005-${runId}` &&
      Object.keys(toolArguments).length === 1
    );
  });
  const matchingResult =
    toolCall !== undefined &&
    compacted.some((message) => {
      if (
        message.role !== "tool" ||
        message.tool_call_id !== toolCall.id ||
        typeof message.content !== "string"
      ) {
        return false;
      }
      const result = structuredObject(message.content);
      return (
        result?.success === true &&
        Array.isArray(result.results) &&
        result.results.length === 0 &&
        result.message === "No relevant documents found" &&
        Object.keys(result).length === 3
      );
    });
  return { runId, toolStateComplete: matchingResult };
}

function summaryResponse(
  runId: string | undefined,
  toolStateComplete: boolean,
): Record<string, unknown> {
  const marker = runId ?? "missing-run-id";
  const summary = {
    schema_version: 1,
    objective: `Continue CHAT-005 for run ${marker}`,
    constraints: ["Preserve the run-scoped anchor and completed read-only tool state"],
    decisions: [],
    completed: toolStateComplete ? [`CHAT005_TOOL_DONE:${marker}`] : [],
    files_and_artifacts: [],
    tool_state: toolStateComplete
      ? [`document_search completed before compaction for ${marker}`]
      : [],
    open_items: ["Continue after the durable compaction cursor"],
    critical_facts: [
      `CHAT005_ANCHOR:${marker}`,
      toolStateComplete ? "CHAT005_TOOL_STATE_OK" : "CHAT005_TOOL_STATE_MISSING",
    ],
  };
  return {
    id: "chatcmpl-spark-x-context-summary",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(summary) },
        finish_reason: "stop",
      },
    ],
  };
}

function sseChunk(delta: Readonly<Record<string, unknown>>, finishReason: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-spark-x-context-stream",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\ndata: [DONE]\n\n`;
}

function toolCallResponse(runId: string): string {
  return sseChunk(
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_chat005_${runId.replaceAll("-", "")}`,
          type: "function",
          function: {
            name: "document_search",
            arguments: JSON.stringify({ query: `spark-x-chat005-${runId}` }),
          },
        },
      ],
    },
    "tool_calls",
  );
}

function textResponse(content: string): string {
  return sseChunk({ role: "assistant", content }, "stop");
}

function streamingResponse(input: FixtureRequest): string {
  const latestUser = latestUserContent(input.messages);
  if (latestUser === undefined) return textResponse("CHAT005_REQUEST_INVALID");
  const runId = runIdFromMarker(latestUser);
  if (runId === undefined) return textResponse("CHAT005_REQUEST_OUT_OF_SCOPE");
  const matchingToolResult = input.messages.some(
    (message) =>
      message.role === "tool" &&
      message.tool_call_id === `call_chat005_${runId.replaceAll("-", "")}`,
  );
  if (latestUser.startsWith(`CHAT005_TOOL:${runId}`)) {
    return matchingToolResult
      ? textResponse(`CHAT005_TOOL_DONE:${runId}`)
      : toolCallResponse(runId);
  }
  if (latestUser.startsWith(`CHAT005_FILL:${runId}:`)) {
    return textResponse(`CHAT005_FILL_ACK:${runId}`);
  }
  if (latestUser === `CHAT005_CONTINUE:${runId}`) {
    const context = input.messages
      .filter((message) => typeof message.content === "string")
      .map((message) => message.content ?? "")
      .join("\n");
    const durableSummaryPresent =
      context.includes(summaryCarrierStart) &&
      context.includes(`CHAT005_ANCHOR:${runId}`) &&
      context.includes(`document_search completed before compaction for ${runId}`) &&
      context.includes("CHAT005_TOOL_STATE_OK");
    return textResponse(
      durableSummaryPresent
        ? `CHAT005_CONTINUITY_OK:${runId}`
        : `CHAT005_CONTINUITY_MISSING:${runId}`,
    );
  }
  return textResponse("CHAT005_REQUEST_OUT_OF_SCOPE");
}

export function registerContextCompactionFixtureRoutes(
  app: FastifyInstance,
  enabled: boolean,
  prefix: string,
): void {
  if (!enabled) return;
  app.post(
    `${prefix}${contextCompactionFixturePath}`,
    { bodyLimit: 1_000_000 },
    async (request, reply) => {
      authorize(request);
      const input = fixtureRequestValue(request.body);
      const systemPrompt = input.messages.find(
        (message) => message.role === "system" && typeof message.content === "string",
      )?.content;
      if (!input.stream) {
        if (systemPrompt?.startsWith(summaryPromptPrefix) !== true) {
          throw badRequest("上下文压缩夹具只接受受控摘要请求。");
        }
        const evidence = summaryEvidence(input.messages);
        return reply.code(200).send(summaryResponse(evidence.runId, evidence.toolStateComplete));
      }
      return reply
        .code(200)
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache, no-transform")
        .send(streamingResponse(input));
    },
  );
}
