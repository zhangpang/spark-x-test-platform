import { randomUUID } from "node:crypto";

import type {
  AuditContext,
  CaseTemplateRecord,
  ControlPlaneRepository,
  CreateCaseCommand,
  CreateVersionCommand,
  DefinitionResourceRecord,
  DefinitionVersionRecord,
  EnvironmentInput,
  EnvironmentPatch,
  EnvironmentRecord,
  EncryptedSecret,
  GenericVersionCommand,
  JsonObject,
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
  ValidationResult,
} from "./model.js";

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface SqlExecutor {
  query<Row>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  transaction<Result>(work: (sql: SqlExecutor) => Promise<Result>): Promise<Result>;
}

interface SystemRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly status: SystemRecord["status"];
  readonly concurrency_limit: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface ModuleRow {
  readonly id: string;
  readonly system_id: string;
  readonly key: string;
  readonly name: string;
  readonly sort_order: number;
  readonly created_at: Date | string;
}

interface EnvironmentRow {
  readonly id: string;
  readonly system_id: string;
  readonly key: string;
  readonly name: string;
  readonly kind: EnvironmentRecord["kind"];
  readonly base_url: string;
  readonly action_level: EnvironmentRecord["actionLevel"];
  readonly allowlist: EnvironmentRecord["allowlist"];
  readonly timezone: string;
  readonly concurrency_limit: number;
  readonly adapter_key: string | null;
  readonly adapter_config: JsonObject;
  readonly status: EnvironmentRecord["status"];
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface CaseRow {
  readonly id: string;
  readonly module_id: string;
  readonly name: string;
  readonly status: TestCaseRecord["status"];
  readonly current_draft_version_id: string | null;
  readonly current_published_version_id: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface SecretRow {
  readonly id: string;
  readonly system_id: string;
  readonly environment_id: string | null;
  readonly key: string;
  readonly version: number;
  readonly rotated_at: Date | string;
}

interface CaseVersionRow {
  readonly id: string;
  readonly case_id: string;
  readonly version: number;
  readonly schema_version: string;
  readonly definition: JsonObject;
  readonly content_hash: string;
  readonly change_note: string;
  readonly published_at: Date | string | null;
  readonly created_at: Date | string;
}

interface SuiteRow {
  readonly id: string;
  readonly system_id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly default_concurrency: number;
  readonly default_diagnostic_retries: number;
  readonly case_ids: readonly string[] | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface DefinitionResourceRow {
  readonly id: string;
  readonly system_id: string;
  readonly name: string;
  readonly current_version_id: string | null;
  readonly current_published_version_id?: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface DefinitionVersionRow {
  readonly id: string;
  readonly resource_id: string;
  readonly version: number;
  readonly definition: JsonObject;
  readonly content_hash: string;
  readonly change_note: string;
  readonly published_at?: Date | string | null;
  readonly created_at: Date | string;
}

interface CaseTemplateRow {
  readonly id: string;
  readonly system_id: string | null;
  readonly key: string;
  readonly name: string;
  readonly definition: JsonObject;
  readonly created_at: Date | string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function optionalTimestamp(value: Date | string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return timestamp(value);
}

function mapSystem(row: SystemRow): SystemRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    concurrencyLimit: row.concurrency_limit,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapModule(row: ModuleRow): ModuleRecord {
  return {
    id: row.id,
    systemId: row.system_id,
    key: row.key,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: timestamp(row.created_at),
  };
}

function mapEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.id,
    systemId: row.system_id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    actionLevel: row.action_level,
    allowlist: row.allowlist,
    timezone: row.timezone,
    concurrencyLimit: row.concurrency_limit,
    ...(row.adapter_key === null ? {} : { adapterKey: row.adapter_key }),
    adapterConfig: row.adapter_config,
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapCase(row: CaseRow): TestCaseRecord {
  return {
    id: row.id,
    moduleId: row.module_id,
    name: row.name,
    status: row.status,
    currentDraftVersionId: row.current_draft_version_id,
    currentPublishedVersionId: row.current_published_version_id,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapSecret(row: SecretRow): SecretMetadata {
  return {
    id: row.id,
    systemId: row.system_id,
    environmentId: row.environment_id,
    key: row.key,
    version: row.version,
    updatedAt: timestamp(row.rotated_at),
  };
}

function mapCaseVersion(row: CaseVersionRow): TestCaseVersionRecord {
  return {
    id: row.id,
    caseId: row.case_id,
    version: row.version,
    schemaVersion: row.schema_version,
    definition: row.definition,
    contentHash: row.content_hash,
    changeNote: row.change_note,
    publishedAt: optionalTimestamp(row.published_at) ?? null,
    createdAt: timestamp(row.created_at),
  };
}

function mapSuite(row: SuiteRow): TestSuiteRecord {
  return {
    id: row.id,
    systemId: row.system_id,
    key: row.key,
    name: row.name,
    description: row.description,
    caseIds: row.case_ids ?? [],
    defaultConcurrency: row.default_concurrency,
    defaultDiagnosticRetries: row.default_diagnostic_retries,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapDefinitionResource(row: DefinitionResourceRow): DefinitionResourceRecord {
  return {
    id: row.id,
    systemId: row.system_id,
    name: row.name,
    currentVersionId: row.current_version_id,
    ...(row.current_published_version_id === undefined
      ? {}
      : { currentPublishedVersionId: row.current_published_version_id }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapDefinitionVersion(row: DefinitionVersionRow): DefinitionVersionRecord {
  const publishedAt = optionalTimestamp(row.published_at);
  return {
    id: row.id,
    resourceId: row.resource_id,
    version: row.version,
    definition: row.definition,
    contentHash: row.content_hash,
    changeNote: row.change_note,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    createdAt: timestamp(row.created_at),
  };
}

function metadataName(definition: JsonObject): string {
  const metadata = definition.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
    return "未命名用例";
  const name = (metadata as JsonObject).name;
  return typeof name === "string" ? name : "未命名用例";
}

function definitionSchemaVersion(definition: JsonObject): string {
  return typeof definition.schemaVersion === "string" ? definition.schemaVersion : "unknown";
}

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async #audit(
    audit: AuditContext,
    objectType: string,
    objectId: string | null,
    action: string,
    beforeVersion?: number,
    afterVersion?: number,
    sql: SqlExecutor = this.#sql,
  ): Promise<void> {
    await sql.query(
      `insert into operation_audits
         (id, source_ip, request_id, entrypoint, object_type, object_id, action,
          before_version, after_version, result, details)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'succeeded', '{}'::jsonb)`,
      [
        randomUUID(),
        audit.sourceIp ?? null,
        audit.requestId,
        audit.entrypoint,
        objectType,
        objectId,
        action,
        beforeVersion ?? null,
        afterVersion ?? null,
      ],
    );
  }

  async listSystems(): Promise<readonly SystemRecord[]> {
    const result = await this.#sql.query<SystemRow>(
      "select * from systems order by created_at desc, id",
    );
    return result.rows.map(mapSystem);
  }

  async createSystem(input: SystemInput, audit: AuditContext): Promise<SystemRecord> {
    const id = randomUUID();
    const result = await this.#sql.query<SystemRow>(
      `insert into systems (id, key, name, description, concurrency_limit)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [id, input.key, input.name, input.description ?? "", input.concurrencyLimit ?? 5],
    );
    await this.#audit(audit, "system", id, "create");
    return mapSystem(result.rows[0] as SystemRow);
  }

  async getSystem(id: string): Promise<SystemRecord | null> {
    const result = await this.#sql.query<SystemRow>("select * from systems where id = $1", [id]);
    return result.rows[0] === undefined ? null : mapSystem(result.rows[0]);
  }

  async updateSystem(
    id: string,
    patch: SystemPatch,
    audit: AuditContext,
  ): Promise<SystemRecord | null> {
    const result = await this.#sql.query<SystemRow>(
      `update systems
       set name = coalesce($2, name),
           description = coalesce($3, description),
           status = coalesce($4, status),
           concurrency_limit = coalesce($5, concurrency_limit),
           updated_at = now()
       where id = $1
       returning *`,
      [
        id,
        patch.name ?? null,
        patch.description ?? null,
        patch.status ?? null,
        patch.concurrencyLimit ?? null,
      ],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(audit, "system", id, "update");
    return mapSystem(result.rows[0]);
  }

  async listModules(systemId: string): Promise<readonly ModuleRecord[]> {
    const result = await this.#sql.query<ModuleRow>(
      "select * from modules where system_id = $1 order by sort_order, created_at, id",
      [systemId],
    );
    return result.rows.map(mapModule);
  }

  async createModule(
    systemId: string,
    input: ModuleInput,
    audit: AuditContext,
  ): Promise<ModuleRecord> {
    const id = randomUUID();
    const result = await this.#sql.query<ModuleRow>(
      `insert into modules (id, system_id, key, name, sort_order)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [id, systemId, input.key, input.name, input.sortOrder ?? 0],
    );
    await this.#audit(audit, "module", id, "create");
    return mapModule(result.rows[0] as ModuleRow);
  }

  async getModule(id: string): Promise<ModuleRecord | null> {
    const result = await this.#sql.query<ModuleRow>("select * from modules where id = $1", [id]);
    return result.rows[0] === undefined ? null : mapModule(result.rows[0]);
  }

  async listEnvironments(systemId: string): Promise<readonly EnvironmentRecord[]> {
    const result = await this.#sql.query<EnvironmentRow>(
      "select * from environments where system_id = $1 order by created_at desc, id",
      [systemId],
    );
    return result.rows.map(mapEnvironment);
  }

  async createEnvironment(
    systemId: string,
    input: EnvironmentInput,
    audit: AuditContext,
  ): Promise<EnvironmentRecord> {
    const id = randomUUID();
    const result = await this.#sql.query<EnvironmentRow>(
      `insert into environments
         (id, system_id, key, name, kind, base_url, action_level, allowlist, timezone,
          concurrency_limit, adapter_key, adapter_config)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb)
       returning *`,
      [
        id,
        systemId,
        input.key,
        input.name,
        input.kind,
        input.baseUrl,
        input.actionLevel,
        JSON.stringify(input.allowlist),
        input.timezone,
        input.concurrencyLimit,
        input.adapterKey ?? null,
        JSON.stringify(input.adapterConfig ?? {}),
      ],
    );
    await this.#audit(audit, "environment", id, "create");
    return mapEnvironment(result.rows[0] as EnvironmentRow);
  }

  async getEnvironment(id: string): Promise<EnvironmentRecord | null> {
    const result = await this.#sql.query<EnvironmentRow>(
      "select * from environments where id = $1",
      [id],
    );
    return result.rows[0] === undefined ? null : mapEnvironment(result.rows[0]);
  }

  async updateEnvironment(
    id: string,
    patch: EnvironmentPatch,
    audit: AuditContext,
  ): Promise<EnvironmentRecord | null> {
    const result = await this.#sql.query<EnvironmentRow>(
      `update environments
       set name = coalesce($2, name),
           kind = coalesce($3, kind),
           base_url = coalesce($4, base_url),
           action_level = coalesce($5, action_level),
           allowlist = coalesce($6::jsonb, allowlist),
           timezone = coalesce($7, timezone),
           concurrency_limit = coalesce($8, concurrency_limit),
           adapter_key = coalesce($9, adapter_key),
           adapter_config = coalesce($10::jsonb, adapter_config),
           status = coalesce($11, status),
           updated_at = now()
       where id = $1
       returning *`,
      [
        id,
        patch.name ?? null,
        patch.kind ?? null,
        patch.baseUrl ?? null,
        patch.actionLevel ?? null,
        patch.allowlist === undefined ? null : JSON.stringify(patch.allowlist),
        patch.timezone ?? null,
        patch.concurrencyLimit ?? null,
        patch.adapterKey ?? null,
        patch.adapterConfig === undefined ? null : JSON.stringify(patch.adapterConfig),
        patch.status ?? null,
      ],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(audit, "environment", id, "update");
    return mapEnvironment(result.rows[0]);
  }

  async listSecretMetadata(): Promise<readonly SecretMetadata[]> {
    const result = await this.#sql.query<SecretRow>(
      `select id, system_id, environment_id, key, version, rotated_at
       from secrets
       order by rotated_at desc, id`,
    );
    return result.rows.map(mapSecret);
  }

  async upsertSecret(
    systemId: string,
    environmentId: string | null,
    key: string,
    encrypted: EncryptedSecret,
    audit: AuditContext,
  ): Promise<SecretMetadata> {
    const id = randomUUID();
    const result = await this.#sql.query<SecretRow>(
      `insert into secrets
         (id, system_id, environment_id, key, encrypted_value, encryption_iv, authentication_tag)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (system_id, environment_id, key)
       do update set encrypted_value = excluded.encrypted_value,
                     encryption_iv = excluded.encryption_iv,
                     authentication_tag = excluded.authentication_tag,
                     version = secrets.version + 1,
                     rotated_at = now()
       returning id, system_id, environment_id, key, version, rotated_at`,
      [
        id,
        systemId,
        environmentId,
        key,
        Buffer.from(encrypted.ciphertext),
        Buffer.from(encrypted.initializationVector),
        Buffer.from(encrypted.authenticationTag),
      ],
    );
    const metadata = mapSecret(result.rows[0] as SecretRow);
    await this.#audit(
      audit,
      "secret",
      metadata.id,
      "upsert",
      metadata.version - 1,
      metadata.version,
    );
    return metadata;
  }

  async listCases(filters: ListCaseFilters): Promise<readonly TestCaseRecord[]> {
    const result = await this.#sql.query<CaseRow>(
      `select c.*
       from test_cases c
       join modules m on m.id = c.module_id
       where ($1::uuid is null or m.system_id = $1)
         and ($2::text is null or c.status = $2)
       order by c.updated_at desc, c.id`,
      [filters.systemId ?? null, filters.status ?? null],
    );
    return result.rows.map(mapCase);
  }

  async createCase(command: CreateCaseCommand, audit: AuditContext): Promise<TestCaseRecord> {
    const caseId = randomUUID();
    const versionId = randomUUID();
    return this.#sql.transaction(async (sql) => {
      await sql.query(
        `insert into test_cases (id, module_id, name)
         values ($1, $2, $3)`,
        [caseId, command.moduleId, metadataName(command.definition)],
      );
      await sql.query(
        `insert into test_case_versions
           (id, case_id, version, schema_version, definition, content_hash, change_note)
         values ($1, $2, 1, $3, $4::jsonb, $5, $6)`,
        [
          versionId,
          caseId,
          definitionSchemaVersion(command.definition),
          JSON.stringify(command.definition),
          command.contentHash,
          command.changeNote,
        ],
      );
      const result = await sql.query<CaseRow>(
        `update test_cases
         set current_draft_version_id = $2, updated_at = now()
         where id = $1
         returning *`,
        [caseId, versionId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Created test case was not found inside transaction.");
      await this.#audit(audit, "test-case", caseId, "create", 0, 1, sql);
      return mapCase(row);
    });
  }

  async getCase(id: string): Promise<TestCaseRecord | null> {
    const result = await this.#sql.query<CaseRow>("select * from test_cases where id = $1", [id]);
    return result.rows[0] === undefined ? null : mapCase(result.rows[0]);
  }

  async updateCaseMetadata(
    id: string,
    patch: Readonly<{ name?: string; status?: TestCaseRecord["status"] }>,
    audit: AuditContext,
  ): Promise<TestCaseRecord | null> {
    const result = await this.#sql.query<CaseRow>(
      `update test_cases
       set name = coalesce($2, name), status = coalesce($3, status), updated_at = now()
       where id = $1
       returning *`,
      [id, patch.name ?? null, patch.status ?? null],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(audit, "test-case", id, "update-metadata");
    return mapCase(result.rows[0]);
  }

  async listCaseVersions(caseId: string): Promise<readonly TestCaseVersionRecord[]> {
    const result = await this.#sql.query<CaseVersionRow>(
      "select * from test_case_versions where case_id = $1 order by version desc",
      [caseId],
    );
    return result.rows.map(mapCaseVersion);
  }

  async getCaseVersion(id: string): Promise<TestCaseVersionRecord | null> {
    const result = await this.#sql.query<CaseVersionRow>(
      "select * from test_case_versions where id = $1",
      [id],
    );
    return result.rows[0] === undefined ? null : mapCaseVersion(result.rows[0]);
  }

  async createCaseVersion(
    command: CreateVersionCommand,
    audit: AuditContext,
  ): Promise<TestCaseVersionRecord | null> {
    const id = randomUUID();
    const result = await this.#sql.query<CaseVersionRow>(
      `with current_version as (
         select coalesce(max(version), 0)::integer as value
         from test_case_versions
         where case_id = $1
       ), inserted as (
         insert into test_case_versions
           (id, case_id, version, schema_version, definition, content_hash, change_note)
         select $2, $1, value + 1, $3, $4::jsonb, $5, $6
         from current_version
         where value = $7
           and exists (select 1 from test_cases where id = $1)
         returning *
       ), updated as (
         update test_cases
         set current_draft_version_id = (select id from inserted),
             name = $8,
             status = case when status = 'archived' then status else 'draft' end,
             updated_at = now()
         where id = $1 and exists (select 1 from inserted)
       )
       select * from inserted`,
      [
        command.caseId,
        id,
        definitionSchemaVersion(command.definition),
        JSON.stringify(command.definition),
        command.contentHash,
        command.changeNote,
        command.expectedBaseVersion,
        metadataName(command.definition),
      ],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(
      audit,
      "test-case",
      command.caseId,
      "create-version",
      command.expectedBaseVersion,
      result.rows[0].version,
    );
    return mapCaseVersion(result.rows[0]);
  }

  async saveValidation(versionId: string, result: ValidationResult): Promise<void> {
    await this.#sql.query(
      "update test_case_versions set validation_result = $2::jsonb where id = $1",
      [versionId, JSON.stringify(result)],
    );
  }

  async publishCaseVersion(
    caseId: string,
    versionId: string,
    validation: ValidationResult,
    audit: AuditContext,
  ): Promise<TestCaseRecord | null> {
    const result = await this.#sql.query<CaseRow>(
      `with published as (
         update test_case_versions
         set validation_result = $3::jsonb, published_at = coalesce(published_at, now())
         where id = $2 and case_id = $1
         returning id, version
       )
       update test_cases
       set current_published_version_id = (select id from published),
           status = 'published',
           updated_at = now()
       where id = $1 and exists (select 1 from published)
       returning *`,
      [caseId, versionId, JSON.stringify(validation)],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(audit, "test-case", caseId, "publish");
    return mapCase(result.rows[0]);
  }

  async rollbackCase(
    caseId: string,
    sourceVersionId: string,
    audit: AuditContext,
  ): Promise<TestCaseVersionRecord | null> {
    const id = randomUUID();
    const result = await this.#sql.query<CaseVersionRow>(
      `with source as (
         select v.*
         from test_case_versions v
         where v.case_id = $1 and v.id = $2
       ), latest as (
         select coalesce(max(version), 0)::integer as value
         from test_case_versions
         where case_id = $1
       ), inserted as (
         insert into test_case_versions
           (id, case_id, version, schema_version, definition, content_hash, change_note)
         select $3, source.case_id, latest.value + 1, schema_version, definition, content_hash,
                'Rollback from version ' || version
         from source cross join latest
         returning *
       ), updated as (
         update test_cases
         set current_draft_version_id = (select id from inserted),
             name = (select definition->'metadata'->>'name' from inserted),
             status = case when status = 'archived' then status else 'draft' end,
             updated_at = now()
         where id = $1 and exists (select 1 from inserted)
       )
       select * from inserted`,
      [caseId, sourceVersionId, id],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(audit, "test-case", caseId, "rollback", undefined, result.rows[0].version);
    return mapCaseVersion(result.rows[0]);
  }

  async listSuites(): Promise<readonly TestSuiteRecord[]> {
    const result = await this.#sql.query<SuiteRow>(
      `select s.*, coalesce(array_agg(sc.case_id order by sc.sort_order)
         filter (where sc.case_id is not null), '{}') as case_ids
       from test_suites s
       left join suite_cases sc on sc.suite_id = s.id
       group by s.id
       order by s.updated_at desc, s.id`,
    );
    return result.rows.map(mapSuite);
  }

  async createSuite(input: SuiteInput, audit: AuditContext): Promise<TestSuiteRecord> {
    const id = randomUUID();
    await this.#sql.query(
      `with inserted_suite as (
         insert into test_suites
           (id, system_id, key, name, description, default_concurrency, default_diagnostic_retries)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id
       )
       insert into suite_cases (suite_id, case_id, sort_order)
       select inserted_suite.id, members.case_id, members.ordinality - 1
       from inserted_suite,
            unnest($8::uuid[]) with ordinality as members(case_id, ordinality)`,
      [
        id,
        input.systemId,
        input.key,
        input.name,
        input.description ?? "",
        input.defaultConcurrency ?? 1,
        input.defaultDiagnosticRetries ?? 0,
        input.caseIds,
      ],
    );
    await this.#audit(audit, "test-suite", id, "create");
    return (await this.getSuite(id)) as TestSuiteRecord;
  }

  async getSuite(id: string): Promise<TestSuiteRecord | null> {
    const result = await this.#sql.query<SuiteRow>(
      `select s.*, coalesce(array_agg(sc.case_id order by sc.sort_order)
         filter (where sc.case_id is not null), '{}') as case_ids
       from test_suites s
       left join suite_cases sc on sc.suite_id = s.id
       where s.id = $1
       group by s.id`,
      [id],
    );
    return result.rows[0] === undefined ? null : mapSuite(result.rows[0]);
  }

  async updateSuite(
    id: string,
    input: SuiteInput,
    audit: AuditContext,
  ): Promise<TestSuiteRecord | null> {
    const result = await this.#sql.query<{ readonly id: string }>(
      `with updated_suite as (
         update test_suites
         set system_id = $2, key = $3, name = $4, description = $5,
             default_concurrency = $6, default_diagnostic_retries = $7, updated_at = now()
         where id = $1
         returning id
       ), removed as (
         delete from suite_cases where suite_id = $1 and exists (select 1 from updated_suite)
       ), inserted as (
         insert into suite_cases (suite_id, case_id, sort_order)
         select updated_suite.id, members.case_id, members.ordinality - 1
         from updated_suite,
              unnest($8::uuid[]) with ordinality as members(case_id, ordinality)
       )
       select id from updated_suite`,
      [
        id,
        input.systemId,
        input.key,
        input.name,
        input.description ?? "",
        input.defaultConcurrency ?? 1,
        input.defaultDiagnosticRetries ?? 0,
        input.caseIds,
      ],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(audit, "test-suite", id, "update");
    return this.getSuite(id);
  }

  async listDefinitionResources(
    kind: "dataset" | "shared-step",
    systemId?: string,
  ): Promise<readonly DefinitionResourceRecord[]> {
    if (kind === "dataset") {
      const result = await this.#sql.query<DefinitionResourceRow>(
        `select id, system_id, name, current_version_id, created_at, updated_at
         from datasets
         where ($1::uuid is null or system_id = $1)
         order by updated_at desc, id`,
        [systemId ?? null],
      );
      return result.rows.map(mapDefinitionResource);
    }
    const result = await this.#sql.query<DefinitionResourceRow>(
      `select id, system_id, name, current_draft_version_id as current_version_id,
              current_published_version_id, created_at, updated_at
       from shared_steps
       where ($1::uuid is null or system_id = $1)
       order by updated_at desc, id`,
      [systemId ?? null],
    );
    return result.rows.map(mapDefinitionResource);
  }

  async createDefinitionResource(
    kind: "dataset" | "shared-step",
    systemId: string,
    name: string,
    definition: JsonObject,
    hash: string,
    changeNote: string,
    audit: AuditContext,
  ): Promise<DefinitionResourceRecord> {
    const id = randomUUID();
    const versionId = randomUUID();
    return this.#sql.transaction(async (sql) => {
      if (kind === "dataset") {
        await sql.query(`insert into datasets (id, system_id, name) values ($1, $2, $3)`, [
          id,
          systemId,
          name,
        ]);
        await sql.query(
          `insert into dataset_versions
             (id, dataset_id, version, definition, content_hash, change_note)
           values ($1, $2, 1, $3::jsonb, $4, $5)`,
          [versionId, id, JSON.stringify(definition), hash, changeNote],
        );
        const result = await sql.query<DefinitionResourceRow>(
          `update datasets
           set current_version_id = $2, updated_at = now()
           where id = $1
           returning id, system_id, name, current_version_id, created_at, updated_at`,
          [id, versionId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("Created dataset was not found inside transaction.");
        await this.#audit(audit, "dataset", id, "create", 0, 1, sql);
        return mapDefinitionResource(row);
      }

      await sql.query(`insert into shared_steps (id, system_id, name) values ($1, $2, $3)`, [
        id,
        systemId,
        name,
      ]);
      await sql.query(
        `insert into shared_step_versions
           (id, shared_step_id, version, definition, content_hash, change_note)
         values ($1, $2, 1, $3::jsonb, $4, $5)`,
        [versionId, id, JSON.stringify(definition), hash, changeNote],
      );
      const result = await sql.query<DefinitionResourceRow>(
        `update shared_steps
         set current_draft_version_id = $2, updated_at = now()
         where id = $1
         returning id, system_id, name, current_draft_version_id as current_version_id,
                   current_published_version_id, created_at, updated_at`,
        [id, versionId],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new Error("Created shared step was not found inside transaction.");
      await this.#audit(audit, "shared-step", id, "create", 0, 1, sql);
      return mapDefinitionResource(row);
    });
  }

  async listDefinitionVersions(
    kind: "dataset" | "shared-step",
    resourceId: string,
  ): Promise<readonly DefinitionVersionRecord[]> {
    const table = kind === "dataset" ? "dataset_versions" : "shared_step_versions";
    const idColumn = kind === "dataset" ? "dataset_id" : "shared_step_id";
    const publishedColumn = kind === "dataset" ? "null::timestamptz" : "published_at";
    const result = await this.#sql.query<DefinitionVersionRow>(
      `select id, ${idColumn} as resource_id, version, definition, content_hash, change_note,
              ${publishedColumn} as published_at, created_at
       from ${table}
       where ${idColumn} = $1
       order by version desc`,
      [resourceId],
    );
    return result.rows.map(mapDefinitionVersion);
  }

  async createDefinitionVersion(
    kind: "dataset" | "shared-step",
    command: GenericVersionCommand,
    audit: AuditContext,
  ): Promise<DefinitionVersionRecord | null> {
    const id = randomUUID();
    const versionTable = kind === "dataset" ? "dataset_versions" : "shared_step_versions";
    const resourceTable = kind === "dataset" ? "datasets" : "shared_steps";
    const resourceIdColumn = kind === "dataset" ? "dataset_id" : "shared_step_id";
    const pointerColumn = kind === "dataset" ? "current_version_id" : "current_draft_version_id";
    const result = await this.#sql.query<DefinitionVersionRow>(
      `with current_version as (
         select coalesce(max(version), 0)::integer as value from ${versionTable}
         where ${resourceIdColumn} = $1
       ), inserted as (
         insert into ${versionTable}
           (id, ${resourceIdColumn}, version, definition, content_hash, change_note)
         select $2, $1, value + 1, $3::jsonb, $4, $5 from current_version
         where value = $6 and exists (select 1 from ${resourceTable} where id = $1)
         returning id, ${resourceIdColumn} as resource_id, version, definition, content_hash,
                   change_note, created_at
       ), updated as (
         update ${resourceTable}
         set ${pointerColumn} = (select id from inserted), updated_at = now()
         where id = $1 and exists (select 1 from inserted)
       )
       select * from inserted`,
      [
        command.resourceId,
        id,
        JSON.stringify(command.definition),
        command.contentHash,
        command.changeNote,
        command.expectedBaseVersion,
      ],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(
      audit,
      kind,
      command.resourceId,
      "create-version",
      command.expectedBaseVersion,
      result.rows[0].version,
    );
    return mapDefinitionVersion(result.rows[0]);
  }

  async publishSharedStep(
    resourceId: string,
    versionId: string,
    audit: AuditContext,
  ): Promise<DefinitionResourceRecord | null> {
    const result = await this.#sql.query<DefinitionResourceRow>(
      `with published as (
         update shared_step_versions
         set published_at = coalesce(published_at, now())
         where id = $2 and shared_step_id = $1
         returning id
       )
       update shared_steps
       set current_published_version_id = (select id from published), updated_at = now()
       where id = $1 and exists (select 1 from published)
       returning id, system_id, name, current_draft_version_id as current_version_id,
                 current_published_version_id, created_at, updated_at`,
      [resourceId, versionId],
    );
    if (result.rows[0] === undefined) return null;
    await this.#audit(audit, "shared-step", resourceId, "publish");
    return mapDefinitionResource(result.rows[0]);
  }

  async listCaseTemplates(systemId?: string): Promise<readonly CaseTemplateRecord[]> {
    const result = await this.#sql.query<CaseTemplateRow>(
      `select id, system_id, key, name, definition, created_at
       from case_templates
       where system_id is null or system_id = $1::uuid
       order by system_id nulls first, name, id`,
      [systemId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id,
      systemId: row.system_id,
      key: row.key,
      name: row.name,
      definition: row.definition,
      createdAt: timestamp(row.created_at),
    }));
  }
}
