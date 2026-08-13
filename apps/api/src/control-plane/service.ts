import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { badRequest, conflict, notFound } from "./errors.js";
import type {
  AuditContext,
  CaseTemplateRecord,
  CaseStatus,
  ControlPlaneRepository,
  DefinitionResourceRecord,
  DefinitionVersionRecord,
  EnvironmentInput,
  EnvironmentPatch,
  EnvironmentRecord,
  GenericVersionCommand,
  JsonObject,
  JsonValue,
  ListCaseFilters,
  ModuleInput,
  ModuleRecord,
  SecretMetadata,
  SuiteInput,
  SystemInput,
  SystemPatch,
  SystemRecord,
  TestCaseRecord,
  TestCaseVersionRecord,
  TestSuiteRecord,
  ValidationIssue,
  ValidationResult,
} from "./model.js";
import { SecretVault } from "./secrets.js";
import {
  collectSecretReferences,
  contentHash,
  findPlaintextSecrets,
  validateDefinition,
  validateEnvironmentInput,
} from "./validation.js";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectSecrets(value: JsonValue): void {
  const issues = findPlaintextSecrets(value);
  if (issues.length > 0) {
    throw badRequest("资产中检测到疑似明文密钥。", issues);
  }
}

function assertEnvironmentValid(input: EnvironmentInput): void {
  const result = validateEnvironmentInput(input);
  if (!result.valid) throw badRequest("环境目标或密钥配置不合法。", result.issues);
}

function requireName(definition: JsonObject): string {
  const metadata = definition.metadata;
  if (!isJsonObject(metadata) || typeof metadata.name !== "string" || metadata.name.trim() === "") {
    throw badRequest("用例 definition.metadata.name 不能为空。");
  }
  return metadata.name;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

interface PortableCase {
  readonly systemKey: string;
  readonly moduleKey: string;
  readonly caseId: string;
  readonly name: string;
  readonly versions: readonly Readonly<{
    version: number;
    definition: JsonObject;
    contentHash: string;
    changeNote: string;
    publishedAt: string | null;
  }>[];
}

interface PortableBundle {
  readonly formatVersion: "1.0";
  readonly exportedAt: string;
  readonly cases: readonly PortableCase[];
}

interface ImportBundle {
  readonly formatVersion?: unknown;
  readonly cases?: unknown;
}

export class ControlPlaneService {
  readonly #repository: ControlPlaneRepository;
  readonly #secretVault: SecretVault;

  constructor(repository: ControlPlaneRepository, secretVault = new SecretVault()) {
    this.#repository = repository;
    this.#secretVault = secretVault;
  }

  listSystems(): Promise<readonly SystemRecord[]> {
    return this.#repository.listSystems();
  }

  async createSystem(input: SystemInput, audit: AuditContext): Promise<SystemRecord> {
    return this.#repository.createSystem(input, audit);
  }

  async getSystem(id: string): Promise<SystemRecord> {
    const system = await this.#repository.getSystem(id);
    if (system === null) throw notFound("系统");
    return system;
  }

  async updateSystem(id: string, patch: SystemPatch, audit: AuditContext): Promise<SystemRecord> {
    const system = await this.#repository.updateSystem(id, patch, audit);
    if (system === null) throw notFound("系统");
    return system;
  }

  async listModules(systemId: string): Promise<readonly ModuleRecord[]> {
    await this.getSystem(systemId);
    return this.#repository.listModules(systemId);
  }

  async createModule(
    systemId: string,
    input: ModuleInput,
    audit: AuditContext,
  ): Promise<ModuleRecord> {
    await this.getSystem(systemId);
    return this.#repository.createModule(systemId, input, audit);
  }

  async listEnvironments(systemId: string): Promise<readonly EnvironmentRecord[]> {
    await this.getSystem(systemId);
    return this.#repository.listEnvironments(systemId);
  }

  async createEnvironment(
    systemId: string,
    input: EnvironmentInput,
    audit: AuditContext,
  ): Promise<EnvironmentRecord> {
    await this.getSystem(systemId);
    assertEnvironmentValid(input);
    return this.#repository.createEnvironment(systemId, input, audit);
  }

  async getEnvironment(id: string): Promise<EnvironmentRecord> {
    const environment = await this.#repository.getEnvironment(id);
    if (environment === null) throw notFound("环境");
    return environment;
  }

  async updateEnvironment(
    id: string,
    patch: EnvironmentPatch,
    audit: AuditContext,
  ): Promise<EnvironmentRecord> {
    const existing = await this.getEnvironment(id);
    const adapterKey = patch.adapterKey ?? existing.adapterKey;
    const merged: EnvironmentInput = {
      key: existing.key,
      name: patch.name ?? existing.name,
      kind: patch.kind ?? existing.kind,
      baseUrl: patch.baseUrl ?? existing.baseUrl,
      actionLevel: patch.actionLevel ?? existing.actionLevel,
      allowlist: patch.allowlist ?? existing.allowlist,
      timezone: patch.timezone ?? existing.timezone,
      concurrencyLimit: patch.concurrencyLimit ?? existing.concurrencyLimit,
      ...(adapterKey === undefined ? {} : { adapterKey }),
      adapterConfig: patch.adapterConfig ?? existing.adapterConfig ?? {},
    };
    assertEnvironmentValid(merged);
    const updated = await this.#repository.updateEnvironment(id, patch, audit);
    if (updated === null) throw notFound("环境");
    return updated;
  }

  listSecretMetadata(): Promise<readonly SecretMetadata[]> {
    return this.#repository.listSecretMetadata();
  }

  async upsertSecret(
    systemId: string,
    environmentId: string | undefined,
    key: string,
    value: string,
    audit: AuditContext,
  ): Promise<SecretMetadata> {
    await this.getSystem(systemId);
    if (environmentId !== undefined) {
      const environment = await this.getEnvironment(environmentId);
      if (environment.systemId !== systemId) throw badRequest("密钥环境与系统不匹配。");
    }
    const encrypted = this.#secretVault.encrypt(value);
    return this.#repository.upsertSecret(systemId, environmentId ?? null, key, encrypted, audit);
  }

  listCases(filters: ListCaseFilters): Promise<readonly TestCaseRecord[]> {
    return this.#repository.listCases(filters);
  }

  async createCase(
    moduleId: string,
    definition: JsonObject,
    changeNote: string,
    audit: AuditContext,
  ): Promise<TestCaseRecord> {
    await this.#getModuleContext(moduleId);
    requireName(definition);
    rejectSecrets(definition);
    return this.#repository.createCase(
      {
        moduleId,
        definition,
        contentHash: contentHash(definition),
        changeNote,
      },
      audit,
    );
  }

  async getCase(id: string): Promise<TestCaseRecord> {
    const testCase = await this.#repository.getCase(id);
    if (testCase === null) throw notFound("用例");
    return testCase;
  }

  async updateCaseMetadata(
    id: string,
    patch: Readonly<{ name?: string; status?: CaseStatus }>,
    audit: AuditContext,
  ): Promise<TestCaseRecord> {
    const testCase = await this.#repository.updateCaseMetadata(id, patch, audit);
    if (testCase === null) throw notFound("用例");
    return testCase;
  }

  async listCaseVersions(caseId: string): Promise<readonly TestCaseVersionRecord[]> {
    await this.getCase(caseId);
    return this.#repository.listCaseVersions(caseId);
  }

  async createCaseVersion(
    caseId: string,
    definition: JsonObject,
    expectedBaseVersion: number,
    changeNote: string,
    audit: AuditContext,
  ): Promise<TestCaseVersionRecord> {
    await this.getCase(caseId);
    requireName(definition);
    rejectSecrets(definition);
    const version = await this.#repository.createCaseVersion(
      {
        caseId,
        definition,
        contentHash: contentHash(definition),
        expectedBaseVersion,
        changeNote,
      },
      audit,
    );
    if (version === null) {
      throw conflict("用例版本已变化，请刷新历史后再提交。", [{ expectedBaseVersion }]);
    }
    return version;
  }

  async validateCaseVersion(versionId: string, environmentId?: string): Promise<ValidationResult> {
    const context = await this.#getVersionContext(versionId, environmentId);
    const result = validateDefinition(context.version.definition, {
      systemKey: context.system.key,
      moduleKey: context.module.key,
      ...(context.environment === undefined ? {} : { environment: context.environment }),
    });
    const metadata = await this.#repository.listSecretMetadata();
    const missingReferences = collectSecretReferences(context.version.definition).filter(
      (reference) =>
        !metadata.some(
          (secret) =>
            secret.systemId === context.system.id &&
            secret.key === reference &&
            (context.environment === undefined ||
              secret.environmentId === null ||
              secret.environmentId === context.environment.id),
        ),
    );
    if (missingReferences.length > 0) {
      const issues = [
        ...result.issues,
        ...missingReferences.map(
          (reference): ValidationIssue => ({
            severity: "error",
            code: "SECRET_REF_NOT_FOUND",
            path: "$.inputs",
            message: `密钥引用 ${reference} 尚未登记。`,
          }),
        ),
      ];
      const withSecretReferences: ValidationResult = { valid: false, issues };
      await this.#repository.saveValidation(versionId, withSecretReferences);
      return withSecretReferences;
    }
    await this.#repository.saveValidation(versionId, result);
    return result;
  }

  async publishCaseVersion(
    caseId: string,
    versionId: string,
    audit: AuditContext,
  ): Promise<TestCaseRecord> {
    const version = await this.#repository.getCaseVersion(versionId);
    if (version === null || version.caseId !== caseId) throw notFound("用例版本");
    const validation = await this.validateCaseVersion(versionId);
    if (!validation.valid) {
      throw conflict("用例静态校验未通过，不能发布。", validation.issues);
    }
    const testCase = await this.#repository.publishCaseVersion(
      caseId,
      versionId,
      validation,
      audit,
    );
    if (testCase === null) throw notFound("用例或版本");
    return testCase;
  }

  async rollbackCase(
    caseId: string,
    sourceVersionId: string,
    audit: AuditContext,
  ): Promise<TestCaseVersionRecord> {
    await this.getCase(caseId);
    const version = await this.#repository.rollbackCase(caseId, sourceVersionId, audit);
    if (version === null) throw notFound("历史版本");
    return version;
  }

  listSuites(): Promise<readonly TestSuiteRecord[]> {
    return this.#repository.listSuites();
  }

  async createSuite(input: SuiteInput, audit: AuditContext): Promise<TestSuiteRecord> {
    await this.#validateSuite(input);
    return this.#repository.createSuite(input, audit);
  }

  async getSuite(id: string): Promise<TestSuiteRecord> {
    const suite = await this.#repository.getSuite(id);
    if (suite === null) throw notFound("测试套件");
    return suite;
  }

  async updateSuite(id: string, input: SuiteInput, audit: AuditContext): Promise<TestSuiteRecord> {
    await this.#validateSuite(input);
    const suite = await this.#repository.updateSuite(id, input, audit);
    if (suite === null) throw notFound("测试套件");
    return suite;
  }

  listDefinitionResources(
    kind: "dataset" | "shared-step",
    systemId?: string,
  ): Promise<readonly DefinitionResourceRecord[]> {
    return this.#repository.listDefinitionResources(kind, systemId);
  }

  async createDataset(
    systemId: string,
    name: string,
    columns: readonly string[],
    rows: readonly JsonObject[],
    changeNote: string,
    audit: AuditContext,
  ): Promise<DefinitionResourceRecord> {
    await this.getSystem(systemId);
    if (columns.length === 0 || !unique(columns)) {
      throw badRequest("数据集 columns 必须非空且不能重复。");
    }
    const definition: JsonObject = { columns, rows };
    rejectSecrets(definition);
    return this.#repository.createDefinitionResource(
      "dataset",
      systemId,
      name,
      definition,
      contentHash(definition),
      changeNote,
      audit,
    );
  }

  async createSharedStep(
    systemId: string,
    name: string,
    definition: JsonObject,
    audit: AuditContext,
  ): Promise<DefinitionResourceRecord> {
    await this.getSystem(systemId);
    rejectSecrets(definition);
    return this.#repository.createDefinitionResource(
      "shared-step",
      systemId,
      name,
      definition,
      contentHash(definition),
      "Initial version",
      audit,
    );
  }

  listDefinitionVersions(
    kind: "dataset" | "shared-step",
    resourceId: string,
  ): Promise<readonly DefinitionVersionRecord[]> {
    return this.#repository.listDefinitionVersions(kind, resourceId);
  }

  async createDefinitionVersion(
    kind: "dataset" | "shared-step",
    command: Omit<GenericVersionCommand, "contentHash">,
    audit: AuditContext,
  ): Promise<DefinitionVersionRecord> {
    rejectSecrets(command.definition);
    const version = await this.#repository.createDefinitionVersion(
      kind,
      { ...command, contentHash: contentHash(command.definition) },
      audit,
    );
    if (version === null) throw conflict("资产版本已变化，请刷新后重试。");
    return version;
  }

  async publishSharedStep(
    resourceId: string,
    versionId: string,
    audit: AuditContext,
  ): Promise<DefinitionResourceRecord> {
    const resource = await this.#repository.publishSharedStep(resourceId, versionId, audit);
    if (resource === null) throw notFound("公共步骤或版本");
    return resource;
  }

  listCaseTemplates(systemId?: string): Promise<readonly CaseTemplateRecord[]> {
    return this.#repository.listCaseTemplates(systemId);
  }

  async exportCases(
    caseIds: readonly string[],
    format: "json" | "yaml",
  ): Promise<Readonly<{ content: string; filename: string; contentType: string }>> {
    if (caseIds.length === 0 || !unique(caseIds)) throw badRequest("caseIds 必须非空且不能重复。");
    const cases: PortableCase[] = [];
    for (const caseId of caseIds) {
      const testCase = await this.getCase(caseId);
      const context = await this.#getModuleContext(testCase.moduleId);
      const versions = await this.#repository.listCaseVersions(caseId);
      cases.push({
        systemKey: context.system.key,
        moduleKey: context.module.key,
        caseId,
        name: testCase.name,
        versions: versions.map((version) => ({
          version: version.version,
          definition: version.definition,
          contentHash: version.contentHash,
          changeNote: version.changeNote,
          publishedAt: version.publishedAt,
        })),
      });
    }
    const bundle: PortableBundle = {
      formatVersion: "1.0",
      exportedAt: new Date().toISOString(),
      cases,
    };
    return format === "json"
      ? {
          content: JSON.stringify(bundle, null, 2),
          filename: "spark-x-test-cases.json",
          contentType: "application/json; charset=utf-8",
        }
      : {
          content: stringifyYaml(bundle),
          filename: "spark-x-test-cases.yaml",
          contentType: "application/yaml; charset=utf-8",
        };
  }

  async importCases(
    systemId: string,
    format: "json" | "yaml",
    content: string,
    mode: "validate_only" | "create_drafts",
    audit: AuditContext,
  ): Promise<ValidationResult> {
    const system = await this.getSystem(systemId);
    let parsed: unknown;
    try {
      parsed = format === "json" ? JSON.parse(content) : parseYaml(content);
    } catch (error) {
      return {
        valid: false,
        issues: [
          {
            severity: "error",
            code: "IMPORT_PARSE_FAILED",
            path: "$",
            message: error instanceof Error ? error.message : "导入内容无法解析。",
          },
        ],
      };
    }
    if (!isJsonObject(parsed)) return this.#invalidBundle("导入根节点必须是对象。");
    const bundle = parsed as ImportBundle;
    if (bundle.formatVersion !== "1.0" || !Array.isArray(bundle.cases)) {
      return this.#invalidBundle("仅支持 formatVersion=1.0 且 cases 为数组的导出包。");
    }

    const modules = await this.#repository.listModules(systemId);
    const issues: ValidationIssue[] = [];
    const pending: Readonly<{ moduleId: string; definition: JsonObject; changeNote: string }>[] =
      [];
    for (const [index, item] of bundle.cases.entries()) {
      if (!isJsonObject(item) || !Array.isArray(item.versions) || item.versions.length === 0) {
        issues.push({
          severity: "error",
          code: "IMPORT_CASE_INVALID",
          path: `$.cases[${index}]`,
          message: "导入用例必须包含至少一个版本。",
        });
        continue;
      }
      const moduleKey = item.moduleKey;
      const module = modules.find((candidate) => candidate.key === moduleKey);
      if (module === undefined) {
        issues.push({
          severity: "error",
          code: "IMPORT_MODULE_NOT_FOUND",
          path: `$.cases[${index}].moduleKey`,
          message: `目标系统中不存在模块 ${String(moduleKey)}。`,
        });
        continue;
      }
      const newest = [...item.versions]
        .filter(isJsonObject)
        .sort((left, right) => Number(right.version) - Number(left.version))[0];
      if (newest === undefined || !isJsonObject(newest.definition)) {
        issues.push({
          severity: "error",
          code: "IMPORT_VERSION_INVALID",
          path: `$.cases[${index}].versions`,
          message: "导入版本缺少 definition。",
        });
        continue;
      }
      const definition = newest.definition;
      const validation = validateDefinition(definition, {
        systemKey: system.key,
        moduleKey: module.key,
      });
      issues.push(
        ...validation.issues.map((issue) => ({
          ...issue,
          path: `$.cases[${index}]${issue.path.slice(1)}`,
        })),
      );
      pending.push({
        moduleId: module.id,
        definition,
        changeNote: `Imported from ${String(item.caseId ?? "portable bundle")}`,
      });
    }
    const result: ValidationResult = {
      valid: issues.every((issue) => issue.severity !== "error"),
      issues,
    };
    if (result.valid && mode === "create_drafts") {
      for (const item of pending) {
        await this.createCase(item.moduleId, item.definition, item.changeNote, audit);
      }
    }
    return result;
  }

  async #getModuleContext(moduleId: string): Promise<{
    readonly module: ModuleRecord;
    readonly system: SystemRecord;
  }> {
    const module = await this.#repository.getModule(moduleId);
    if (module === null) throw notFound("模块");
    const system = await this.getSystem(module.systemId);
    return { module, system };
  }

  async #getVersionContext(
    versionId: string,
    environmentId?: string,
  ): Promise<{
    readonly version: TestCaseVersionRecord;
    readonly testCase: TestCaseRecord;
    readonly module: ModuleRecord;
    readonly system: SystemRecord;
    readonly environment?: EnvironmentRecord;
  }> {
    const version = await this.#repository.getCaseVersion(versionId);
    if (version === null) throw notFound("用例版本");
    const testCase = await this.getCase(version.caseId);
    const context = await this.#getModuleContext(testCase.moduleId);
    if (environmentId === undefined) {
      return { version, testCase, ...context };
    }
    const environment = await this.getEnvironment(environmentId);
    if (environment.systemId !== context.system.id) {
      throw badRequest("校验环境与用例不属于同一系统。");
    }
    return { version, testCase, ...context, environment };
  }

  async #validateSuite(input: SuiteInput): Promise<void> {
    await this.getSystem(input.systemId);
    if (!unique(input.caseIds)) throw badRequest("套件 caseIds 不能重复。");
    for (const caseId of input.caseIds) {
      const testCase = await this.getCase(caseId);
      const context = await this.#getModuleContext(testCase.moduleId);
      if (context.system.id !== input.systemId) {
        throw badRequest(`用例 ${caseId} 不属于套件系统。`);
      }
      if (testCase.currentPublishedVersionId === null) {
        throw badRequest(`用例 ${testCase.name} 尚未发布，不能加入套件。`);
      }
    }
  }

  #invalidBundle(message: string): ValidationResult {
    return {
      valid: false,
      issues: [{ severity: "error", code: "IMPORT_BUNDLE_INVALID", path: "$", message }],
    };
  }
}
