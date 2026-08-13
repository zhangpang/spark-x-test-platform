import type { FastifyInstance, FastifyRequest } from "fastify";

import { badRequest } from "./errors.js";
import type {
  ActionLevel,
  AuditContext,
  CaseStatus,
  EnvironmentInput,
  EnvironmentKind,
  EnvironmentPatch,
  EnvironmentStatus,
  JsonObject,
  JsonValue,
  ModuleInput,
  ResourceStatus,
  SuiteInput,
  SystemInput,
  SystemPatch,
  TargetRule,
} from "./model.js";
import { ControlPlaneService } from "./service.js";

const keyPattern = /^[a-z][a-z0-9-]+$/;
const secretKeyPattern = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${name} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown, name: string): JsonObject {
  return objectValue(value, name) as JsonObject;
}

function stringValue(
  value: unknown,
  name: string,
  options: Readonly<{ min?: number; max?: number; pattern?: RegExp }> = {},
): string {
  if (typeof value !== "string") throw badRequest(`${name} 必须是字符串。`);
  const min = options.min ?? 1;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (value.length < min || value.length > max) {
    throw badRequest(`${name} 长度必须在 ${min} 到 ${max} 之间。`);
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    throw badRequest(`${name} 格式不正确。`);
  }
  return value;
}

function optionalString(
  value: unknown,
  name: string,
  options?: Readonly<{ min?: number; max?: number; pattern?: RegExp }>,
): string | undefined {
  return value === undefined ? undefined : stringValue(value, name, options);
}

function numberValue(
  value: unknown,
  name: string,
  options: Readonly<{ min: number; max: number }>,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < options.min ||
    (value as number) > options.max
  ) {
    throw badRequest(`${name} 必须是 ${options.min} 到 ${options.max} 之间的整数。`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequest(`${name} 仅允许 ${allowed.join("、")}。`);
  }
  return value as T;
}

function uuid(value: unknown, name: string): string {
  return stringValue(value, name, { pattern: uuidPattern });
}

function params(request: FastifyRequest): Record<string, unknown> {
  return objectValue(request.params, "路径参数");
}

function query(request: FastifyRequest): Record<string, unknown> {
  return objectValue(request.query, "查询参数");
}

function audit(request: FastifyRequest): AuditContext {
  return {
    requestId: String(request.id),
    sourceIp: request.ip,
    entrypoint: `${request.method} ${request.routeOptions.url}`,
  };
}

function parseSystemInput(body: unknown): SystemInput {
  const input = objectValue(body, "请求体");
  return {
    key: stringValue(input.key, "key", { min: 2, max: 100, pattern: keyPattern }),
    name: stringValue(input.name, "name", { max: 200 }),
    ...(input.description === undefined
      ? {}
      : { description: stringValue(input.description, "description", { min: 0, max: 4000 }) }),
    ...(input.concurrencyLimit === undefined
      ? {}
      : {
          concurrencyLimit: numberValue(input.concurrencyLimit, "concurrencyLimit", {
            min: 1,
            max: 100,
          }),
        }),
  };
}

function parseSystemPatch(body: unknown): SystemPatch {
  const input = objectValue(body, "请求体");
  const patch: SystemPatch = {
    ...(input.name === undefined ? {} : { name: stringValue(input.name, "name", { max: 200 }) }),
    ...(input.description === undefined
      ? {}
      : { description: stringValue(input.description, "description", { min: 0, max: 4000 }) }),
    ...(input.status === undefined
      ? {}
      : { status: enumValue<ResourceStatus>(input.status, "status", ["active", "archived"]) }),
    ...(input.concurrencyLimit === undefined
      ? {}
      : {
          concurrencyLimit: numberValue(input.concurrencyLimit, "concurrencyLimit", {
            min: 1,
            max: 100,
          }),
        }),
  };
  if (Object.keys(patch).length === 0) throw badRequest("至少提供一个可更新字段。");
  return patch;
}

function parseModuleInput(body: unknown): ModuleInput {
  const input = objectValue(body, "请求体");
  return {
    key: stringValue(input.key, "key", { min: 2, max: 100, pattern: keyPattern }),
    name: stringValue(input.name, "name", { max: 200 }),
    ...(input.sortOrder === undefined
      ? {}
      : { sortOrder: numberValue(input.sortOrder, "sortOrder", { min: 0, max: 1_000_000 }) }),
  };
}

function parseAllowlist(value: unknown): readonly TargetRule[] {
  if (!Array.isArray(value) || value.length === 0) throw badRequest("allowlist 必须是非空数组。");
  return value.map((rawRule, index) => {
    const rule = objectValue(rawRule, `allowlist[${index}]`);
    if (!Array.isArray(rule.ports) || rule.ports.length === 0) {
      throw badRequest(`allowlist[${index}].ports 必须是非空数组。`);
    }
    const pathPrefixes =
      rule.pathPrefixes === undefined
        ? undefined
        : Array.isArray(rule.pathPrefixes)
          ? rule.pathPrefixes.map((path, pathIndex) =>
              stringValue(path, `allowlist[${index}].pathPrefixes[${pathIndex}]`, {
                max: 2048,
              }),
            )
          : (() => {
              throw badRequest(`allowlist[${index}].pathPrefixes 必须是数组。`);
            })();
    return {
      protocol: enumValue(rule.protocol, `allowlist[${index}].protocol`, ["http", "https"]),
      host: stringValue(rule.host, `allowlist[${index}].host`, { max: 253 }),
      ports: rule.ports.map((port, portIndex) =>
        numberValue(port, `allowlist[${index}].ports[${portIndex}]`, { min: 1, max: 65_535 }),
      ),
      ...(pathPrefixes === undefined ? {} : { pathPrefixes }),
    };
  });
}

function parseEnvironmentInput(body: unknown): EnvironmentInput {
  const input = objectValue(body, "请求体");
  return {
    key: stringValue(input.key, "key", { min: 2, max: 100, pattern: keyPattern }),
    name: stringValue(input.name, "name", { max: 200 }),
    kind: enumValue<EnvironmentKind>(input.kind, "kind", ["test", "staging", "production"]),
    baseUrl: stringValue(input.baseUrl, "baseUrl", { max: 2048 }),
    actionLevel: enumValue<ActionLevel>(input.actionLevel, "actionLevel", [
      "read",
      "write",
      "dangerous",
    ]),
    allowlist: parseAllowlist(input.allowlist),
    timezone: stringValue(input.timezone, "timezone", { max: 100 }),
    concurrencyLimit: numberValue(input.concurrencyLimit, "concurrencyLimit", {
      min: 1,
      max: 100,
    }),
    ...(input.adapterKey === undefined
      ? {}
      : { adapterKey: stringValue(input.adapterKey, "adapterKey", { max: 100 }) }),
    ...(input.adapterConfig === undefined
      ? {}
      : { adapterConfig: jsonObject(input.adapterConfig, "adapterConfig") }),
  };
}

function parseEnvironmentPatch(body: unknown): EnvironmentPatch {
  const input = objectValue(body, "请求体");
  const patch: EnvironmentPatch = {
    ...(input.name === undefined ? {} : { name: stringValue(input.name, "name", { max: 200 }) }),
    ...(input.kind === undefined
      ? {}
      : {
          kind: enumValue<EnvironmentKind>(input.kind, "kind", ["test", "staging", "production"]),
        }),
    ...(input.baseUrl === undefined
      ? {}
      : { baseUrl: stringValue(input.baseUrl, "baseUrl", { max: 2048 }) }),
    ...(input.actionLevel === undefined
      ? {}
      : {
          actionLevel: enumValue<ActionLevel>(input.actionLevel, "actionLevel", [
            "read",
            "write",
            "dangerous",
          ]),
        }),
    ...(input.allowlist === undefined ? {} : { allowlist: parseAllowlist(input.allowlist) }),
    ...(input.timezone === undefined
      ? {}
      : { timezone: stringValue(input.timezone, "timezone", { max: 100 }) }),
    ...(input.concurrencyLimit === undefined
      ? {}
      : {
          concurrencyLimit: numberValue(input.concurrencyLimit, "concurrencyLimit", {
            min: 1,
            max: 100,
          }),
        }),
    ...(input.adapterKey === undefined
      ? {}
      : { adapterKey: stringValue(input.adapterKey, "adapterKey", { max: 100 }) }),
    ...(input.adapterConfig === undefined
      ? {}
      : { adapterConfig: jsonObject(input.adapterConfig, "adapterConfig") }),
    ...(input.status === undefined
      ? {}
      : {
          status: enumValue<EnvironmentStatus>(input.status, "status", [
            "active",
            "disabled",
            "archived",
          ]),
        }),
  };
  if (Object.keys(patch).length === 0) throw badRequest("至少提供一个可更新字段。");
  return patch;
}

function parseCaseStatus(value: unknown): CaseStatus {
  return enumValue<CaseStatus>(value, "status", ["draft", "published", "disabled", "archived"]);
}

function parseSuiteInput(body: unknown): SuiteInput {
  const input = objectValue(body, "请求体");
  if (!Array.isArray(input.caseIds)) throw badRequest("caseIds 必须是数组。");
  return {
    systemId: uuid(input.systemId, "systemId"),
    key: stringValue(input.key, "key", { min: 2, max: 100, pattern: keyPattern }),
    name: stringValue(input.name, "name", { max: 200 }),
    ...(input.description === undefined
      ? {}
      : { description: stringValue(input.description, "description", { min: 0, max: 4000 }) }),
    caseIds: input.caseIds.map((caseId, index) => uuid(caseId, `caseIds[${index}]`)),
    ...(input.defaultConcurrency === undefined
      ? {}
      : {
          defaultConcurrency: numberValue(input.defaultConcurrency, "defaultConcurrency", {
            min: 1,
            max: 100,
          }),
        }),
    ...(input.defaultDiagnosticRetries === undefined
      ? {}
      : {
          defaultDiagnosticRetries: numberValue(
            input.defaultDiagnosticRetries,
            "defaultDiagnosticRetries",
            { min: 0, max: 3 },
          ),
        }),
  };
}

function definitionDiff(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  path = "$",
): readonly Readonly<{ path: string; before?: JsonValue; after?: JsonValue }>[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  const leftObject =
    typeof left === "object" && left !== null && !Array.isArray(left) ? left : undefined;
  const rightObject =
    typeof right === "object" && right !== null && !Array.isArray(right) ? right : undefined;
  if (leftObject !== undefined && rightObject !== undefined) {
    const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
    return keys.flatMap((key) =>
      definitionDiff(leftObject[key], rightObject[key], `${path}.${key}`),
    );
  }
  return [
    {
      path,
      ...(left === undefined ? {} : { before: left }),
      ...(right === undefined ? {} : { after: right }),
    },
  ];
}

export function registerControlPlaneRoutes(
  app: FastifyInstance,
  service: ControlPlaneService,
  prefix: string,
): void {
  app.get(`${prefix}/systems`, async () => ({ items: await service.listSystems() }));
  app.post(`${prefix}/systems`, async (request, reply) => {
    const record = await service.createSystem(parseSystemInput(request.body), audit(request));
    return reply.code(201).send(record);
  });
  app.get(`${prefix}/systems/:systemId`, async (request) =>
    service.getSystem(uuid(params(request).systemId, "systemId")),
  );
  app.patch(`${prefix}/systems/:systemId`, async (request) =>
    service.updateSystem(
      uuid(params(request).systemId, "systemId"),
      parseSystemPatch(request.body),
      audit(request),
    ),
  );
  app.get(`${prefix}/systems/:systemId/modules`, async (request) =>
    service.listModules(uuid(params(request).systemId, "systemId")),
  );
  app.post(`${prefix}/systems/:systemId/modules`, async (request, reply) => {
    const record = await service.createModule(
      uuid(params(request).systemId, "systemId"),
      parseModuleInput(request.body),
      audit(request),
    );
    return reply.code(201).send(record);
  });
  app.get(`${prefix}/systems/:systemId/environments`, async (request) =>
    service.listEnvironments(uuid(params(request).systemId, "systemId")),
  );
  app.post(`${prefix}/systems/:systemId/environments`, async (request, reply) => {
    const record = await service.createEnvironment(
      uuid(params(request).systemId, "systemId"),
      parseEnvironmentInput(request.body),
      audit(request),
    );
    return reply.code(201).send(record);
  });
  app.get(`${prefix}/environments/:environmentId`, async (request) =>
    service.getEnvironment(uuid(params(request).environmentId, "environmentId")),
  );
  app.patch(`${prefix}/environments/:environmentId`, async (request) =>
    service.updateEnvironment(
      uuid(params(request).environmentId, "environmentId"),
      parseEnvironmentPatch(request.body),
      audit(request),
    ),
  );
  app.get(`${prefix}/secrets`, async () => service.listSecretMetadata());
  app.post(`${prefix}/secrets`, async (request) => {
    const body = objectValue(request.body, "请求体");
    return service.upsertSecret(
      uuid(body.systemId, "systemId"),
      body.environmentId === undefined ? undefined : uuid(body.environmentId, "environmentId"),
      stringValue(body.key, "key", { max: 100, pattern: secretKeyPattern }),
      stringValue(body.value, "value", { max: 65_536 }),
      audit(request),
    );
  });

  app.get(`${prefix}/test-cases`, async (request) => {
    const values = query(request);
    return {
      items: await service.listCases({
        ...(values.systemId === undefined ? {} : { systemId: uuid(values.systemId, "systemId") }),
        ...(values.status === undefined ? {} : { status: parseCaseStatus(values.status) }),
      }),
    };
  });
  app.post(`${prefix}/test-cases`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    const record = await service.createCase(
      uuid(body.moduleId, "moduleId"),
      jsonObject(body.definition, "definition"),
      optionalString(body.changeNote, "changeNote", { min: 0, max: 1000 }) ?? "",
      audit(request),
    );
    return reply.code(201).send(record);
  });
  app.get(`${prefix}/test-cases/:caseId`, async (request) =>
    service.getCase(uuid(params(request).caseId, "caseId")),
  );
  app.patch(`${prefix}/test-cases/:caseId`, async (request) => {
    const body = objectValue(request.body, "请求体");
    return service.updateCaseMetadata(
      uuid(params(request).caseId, "caseId"),
      {
        ...(body.name === undefined ? {} : { name: stringValue(body.name, "name", { max: 200 }) }),
        ...(body.status === undefined ? {} : { status: parseCaseStatus(body.status) }),
      },
      audit(request),
    );
  });
  app.get(`${prefix}/test-cases/:caseId/versions`, async (request) =>
    service.listCaseVersions(uuid(params(request).caseId, "caseId")),
  );
  app.post(`${prefix}/test-cases/:caseId/versions`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    const version = await service.createCaseVersion(
      uuid(params(request).caseId, "caseId"),
      jsonObject(body.definition, "definition"),
      numberValue(body.expectedBaseVersion, "expectedBaseVersion", { min: 0, max: 1_000_000 }),
      optionalString(body.changeNote, "changeNote", { min: 0, max: 1000 }) ?? "",
      audit(request),
    );
    return reply.code(201).send(version);
  });
  app.post(`${prefix}/test-case-versions/:versionId/validations`, async (request) => {
    const body = request.body === undefined ? {} : objectValue(request.body, "请求体");
    return service.validateCaseVersion(
      uuid(params(request).versionId, "versionId"),
      body.environmentId === undefined ? undefined : uuid(body.environmentId, "environmentId"),
    );
  });
  app.post(`${prefix}/test-cases/:caseId/publish`, async (request) => {
    const body = objectValue(request.body, "请求体");
    return service.publishCaseVersion(
      uuid(params(request).caseId, "caseId"),
      uuid(body.versionId, "versionId"),
      audit(request),
    );
  });
  app.post(`${prefix}/test-cases/:caseId/rollback`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    const version = await service.rollbackCase(
      uuid(params(request).caseId, "caseId"),
      uuid(body.sourceVersionId, "sourceVersionId"),
      audit(request),
    );
    return reply.code(201).send(version);
  });
  app.get(`${prefix}/test-cases/:caseId/comparisons`, async (request) => {
    const caseId = uuid(params(request).caseId, "caseId");
    const values = query(request);
    const baseVersionId = uuid(values.baseVersionId, "baseVersionId");
    const targetVersionId = uuid(values.targetVersionId, "targetVersionId");
    const versions = await service.listCaseVersions(caseId);
    const base = versions.find((version) => version.id === baseVersionId);
    const target = versions.find((version) => version.id === targetVersionId);
    if (base === undefined || target === undefined) throw badRequest("比较版本不属于指定用例。");
    return {
      caseId,
      baseVersionId,
      targetVersionId,
      changes: definitionDiff(base.definition, target.definition),
    };
  });
  app.post(`${prefix}/test-cases/exports`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    if (!Array.isArray(body.caseIds)) throw badRequest("caseIds 必须是数组。");
    const exported = await service.exportCases(
      body.caseIds.map((caseId, index) => uuid(caseId, `caseIds[${index}]`)),
      enumValue(body.format, "format", ["json", "yaml"]),
    );
    reply.header("content-type", exported.contentType);
    reply.header("content-disposition", `attachment; filename="${exported.filename}"`);
    return reply.send(exported.content);
  });
  app.post(`${prefix}/test-cases/imports`, async (request) => {
    const body = objectValue(request.body, "请求体");
    return service.importCases(
      uuid(body.systemId, "systemId"),
      enumValue(body.format, "format", ["json", "yaml"]),
      stringValue(body.content, "content", { max: 10_000_000 }),
      body.mode === undefined
        ? "validate_only"
        : enumValue(body.mode, "mode", ["validate_only", "create_drafts"]),
      audit(request),
    );
  });
  app.get(`${prefix}/case-templates`, async (request) => {
    const values = query(request);
    return service.listCaseTemplates(
      values.systemId === undefined ? undefined : uuid(values.systemId, "systemId"),
    );
  });

  app.get(`${prefix}/test-suites`, async () => ({ items: await service.listSuites() }));
  app.post(`${prefix}/test-suites`, async (request, reply) => {
    const suite = await service.createSuite(parseSuiteInput(request.body), audit(request));
    return reply.code(201).send(suite);
  });
  app.get(`${prefix}/test-suites/:suiteId`, async (request) =>
    service.getSuite(uuid(params(request).suiteId, "suiteId")),
  );
  app.patch(`${prefix}/test-suites/:suiteId`, async (request) =>
    service.updateSuite(
      uuid(params(request).suiteId, "suiteId"),
      parseSuiteInput(request.body),
      audit(request),
    ),
  );

  app.get(`${prefix}/datasets`, async (request) => {
    const values = query(request);
    return {
      items: await service.listDefinitionResources(
        "dataset",
        values.systemId === undefined ? undefined : uuid(values.systemId, "systemId"),
      ),
    };
  });
  app.post(`${prefix}/datasets`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) {
      throw badRequest("columns 和 rows 必须是数组。");
    }
    const record = await service.createDataset(
      uuid(body.systemId, "systemId"),
      stringValue(body.name, "name", { max: 200 }),
      body.columns.map((column, index) => stringValue(column, `columns[${index}]`, { max: 200 })),
      body.rows.map((row, index) => jsonObject(row, `rows[${index}]`)),
      optionalString(body.changeNote, "changeNote", { min: 0, max: 1000 }) ?? "",
      audit(request),
    );
    return reply.code(201).send(record);
  });
  app.get(`${prefix}/datasets/:datasetId/versions`, async (request) =>
    service.listDefinitionVersions("dataset", uuid(params(request).datasetId, "datasetId")),
  );
  app.post(`${prefix}/datasets/:datasetId/versions`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    const version = await service.createDefinitionVersion(
      "dataset",
      {
        resourceId: uuid(params(request).datasetId, "datasetId"),
        definition: jsonObject(body.definition, "definition"),
        expectedBaseVersion: numberValue(body.expectedBaseVersion, "expectedBaseVersion", {
          min: 0,
          max: 1_000_000,
        }),
        changeNote: optionalString(body.changeNote, "changeNote", { min: 0, max: 1000 }) ?? "",
      },
      audit(request),
    );
    return reply.code(201).send(version);
  });

  app.get(`${prefix}/shared-steps`, async (request) => {
    const values = query(request);
    return {
      items: await service.listDefinitionResources(
        "shared-step",
        values.systemId === undefined ? undefined : uuid(values.systemId, "systemId"),
      ),
    };
  });
  app.post(`${prefix}/shared-steps`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    const record = await service.createSharedStep(
      uuid(body.systemId, "systemId"),
      stringValue(body.name, "name", { max: 200 }),
      jsonObject(body.definition, "definition"),
      audit(request),
    );
    return reply.code(201).send(record);
  });
  app.get(`${prefix}/shared-steps/:sharedStepId/versions`, async (request) =>
    service.listDefinitionVersions(
      "shared-step",
      uuid(params(request).sharedStepId, "sharedStepId"),
    ),
  );
  app.post(`${prefix}/shared-steps/:sharedStepId/versions`, async (request, reply) => {
    const body = objectValue(request.body, "请求体");
    const version = await service.createDefinitionVersion(
      "shared-step",
      {
        resourceId: uuid(params(request).sharedStepId, "sharedStepId"),
        definition: jsonObject(body.definition, "definition"),
        expectedBaseVersion: numberValue(body.expectedBaseVersion, "expectedBaseVersion", {
          min: 0,
          max: 1_000_000,
        }),
        changeNote: optionalString(body.changeNote, "changeNote", { min: 0, max: 1000 }) ?? "",
      },
      audit(request),
    );
    return reply.code(201).send(version);
  });
  app.post(`${prefix}/shared-steps/:sharedStepId/publish`, async (request) => {
    const body = objectValue(request.body, "请求体");
    return service.publishSharedStep(
      uuid(params(request).sharedStepId, "sharedStepId"),
      uuid(body.versionId, "versionId"),
      audit(request),
    );
  });
}
