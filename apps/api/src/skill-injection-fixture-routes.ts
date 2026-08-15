import type { FastifyInstance, FastifyRequest } from "fastify";

import { ControlPlaneError, badRequest } from "./control-plane/errors.js";

export const skillInjectionFixtureApiKey =
  "spark-x-test-platform-noncredential-skill-injection-fixture";
export const skillInjectionFixtureModel = "spark-x-test-platform-skill-injection-model";
export const skillInjectionFixturePath = "/fixtures/openai/skill-injection/v1/chat/completions";

const runMarkerPattern = /^SKILL002_USE:([0-9a-f-]{36})$/iu;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const selectedSkillName = "trade-port-daily-brief";
const activeSkillMarker = `active_skill = \`${selectedSkillName}\``;
const selectedSkillMarkers = [
  "# 海关知识检索-快速",
  "唯一允许的网页工具是 `tencent-web-search__web_search`",
  "# 贸易与港口每日简报",
] as const;
const unselectedSkillBodyMarker = "# 进口原始舱单智能生成";

interface FixtureMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly unknown[];
}

interface FixtureRequest {
  readonly model: string;
  readonly messages: readonly FixtureMessage[];
  readonly stream: true;
  readonly max_tokens: number;
  readonly temperature: number;
  readonly tools?: readonly unknown[];
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function authorize(request: FastifyRequest): void {
  const authorization = headerValue(request.headers.authorization);
  if (authorization !== `Bearer ${skillInjectionFixtureApiKey}`) {
    throw new ControlPlaneError(
      "SKILL_INJECTION_FIXTURE_UNAUTHORIZED",
      "Skill 注入夹具认证失败。",
      401,
    );
  }
}

function messageValue(value: unknown): FixtureMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("Skill 注入夹具消息必须是对象。");
  }
  const message = value as Record<string, unknown>;
  if (!["system", "user", "assistant", "tool"].includes(String(message.role))) {
    throw badRequest("Skill 注入夹具消息角色不受支持。");
  }
  if (
    message.content !== undefined &&
    message.content !== null &&
    typeof message.content !== "string"
  ) {
    throw badRequest("Skill 注入夹具消息内容必须是字符串或 null。");
  }
  if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") {
    throw badRequest("Skill 注入夹具工具结果标识必须是字符串。");
  }
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
    throw badRequest("Skill 注入夹具工具调用必须是数组。");
  }
  return message as unknown as FixtureMessage;
}

function fixtureRequestValue(body: unknown): FixtureRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("Skill 注入夹具请求体必须是对象。");
  }
  const input = body as Record<string, unknown>;
  const allowedKeys = ["model", "messages", "stream", "max_tokens", "temperature", "tools"];
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw badRequest("Skill 注入夹具请求包含未支持字段。");
  }
  if (input.model !== skillInjectionFixtureModel) {
    throw badRequest("Skill 注入夹具模型不匹配。");
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 64) {
    throw badRequest("Skill 注入夹具消息数量超出受控边界。");
  }
  if (input.stream !== true) {
    throw badRequest("Skill 注入夹具只接受流式请求。");
  }
  if (
    !Number.isInteger(input.max_tokens) ||
    (input.max_tokens as number) < 1 ||
    (input.max_tokens as number) > 65_536
  ) {
    throw badRequest("Skill 注入夹具 max_tokens 超出受控边界。");
  }
  if (typeof input.temperature !== "number" || !Number.isFinite(input.temperature)) {
    throw badRequest("Skill 注入夹具 temperature 字段无效。");
  }
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 64)) {
    throw badRequest("Skill 注入夹具工具定义超出受控边界。");
  }
  const messages = input.messages.map(messageValue);
  const textBytes = messages.reduce(
    (total, message) =>
      total +
      Buffer.byteLength(message.content ?? "", "utf8") +
      Buffer.byteLength(JSON.stringify(message.tool_calls ?? []), "utf8"),
    0,
  );
  if (textBytes > 500_000) {
    throw badRequest("Skill 注入夹具消息内容超出受控边界。");
  }
  return {
    model: input.model,
    messages,
    stream: true,
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

function selectedSkillInjectionMatches(messages: readonly FixtureMessage[]): boolean {
  const systemContents = messages
    .filter((message) => message.role === "system" && typeof message.content === "string")
    .map((message) => message.content ?? "");
  const activeContextCount = systemContents.filter((content) =>
    content.includes(activeSkillMarker),
  ).length;
  const selectedBodyMatches = systemContents.filter((content) =>
    selectedSkillMarkers.every((marker) => content.includes(marker)),
  );
  const unselectedBodyCount = systemContents.filter((content) =>
    content.includes(unselectedSkillBodyMarker),
  ).length;
  return activeContextCount === 1 && selectedBodyMatches.length === 1 && unselectedBodyCount === 0;
}

function textResponse(content: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-spark-x-skill-injection",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
}

function streamingResponse(input: FixtureRequest): string {
  const latestUser = latestUserContent(input.messages);
  if (latestUser === undefined) return textResponse("SKILL002_REQUEST_INVALID");
  const runId = runMarkerPattern.exec(latestUser)?.[1];
  if (runId === undefined || !runIdPattern.test(runId)) {
    return textResponse("SKILL002_REQUEST_OUT_OF_SCOPE");
  }
  return textResponse(
    selectedSkillInjectionMatches(input.messages)
      ? `SKILL002_APPLIED:${runId.toLowerCase()}`
      : `SKILL002_INJECTION_MISSING:${runId.toLowerCase()}`,
  );
}

export function registerSkillInjectionFixtureRoutes(
  app: FastifyInstance,
  enabled: boolean,
  prefix: string,
): void {
  if (!enabled) return;
  app.post(
    `${prefix}${skillInjectionFixturePath}`,
    { bodyLimit: 750_000 },
    async (request, reply) => {
      authorize(request);
      const input = fixtureRequestValue(request.body);
      return reply
        .code(200)
        .header("Content-Type", "text/event-stream; charset=utf-8")
        .header("Cache-Control", "no-cache, no-transform")
        .send(streamingResponse(input));
    },
  );
}
