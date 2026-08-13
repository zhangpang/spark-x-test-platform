export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ResourceStatus = "active" | "archived";
export type EnvironmentKind = "test" | "staging" | "production";
export type ActionLevel = "read" | "write" | "dangerous";
export type EnvironmentStatus = "active" | "disabled" | "archived";
export type CaseStatus = "draft" | "published" | "disabled" | "archived";

export interface TargetRule {
  readonly protocol: "http" | "https";
  readonly host: string;
  readonly ports: readonly number[];
  readonly pathPrefixes?: readonly string[];
}

export interface SystemInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly concurrencyLimit?: number;
}

export interface SystemPatch {
  readonly name?: string;
  readonly description?: string;
  readonly status?: ResourceStatus;
  readonly concurrencyLimit?: number;
}

export interface SystemRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly status: ResourceStatus;
  readonly concurrencyLimit: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModuleInput {
  readonly key: string;
  readonly name: string;
  readonly sortOrder?: number;
}

export interface ModuleRecord {
  readonly id: string;
  readonly systemId: string;
  readonly key: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly createdAt: string;
}

export interface EnvironmentInput {
  readonly key: string;
  readonly name: string;
  readonly kind: EnvironmentKind;
  readonly baseUrl: string;
  readonly actionLevel: ActionLevel;
  readonly allowlist: readonly TargetRule[];
  readonly timezone: string;
  readonly concurrencyLimit: number;
  readonly adapterKey?: string;
  readonly adapterConfig?: JsonObject;
}

export interface EnvironmentPatch {
  readonly name?: string;
  readonly kind?: EnvironmentKind;
  readonly baseUrl?: string;
  readonly actionLevel?: ActionLevel;
  readonly allowlist?: readonly TargetRule[];
  readonly timezone?: string;
  readonly concurrencyLimit?: number;
  readonly adapterKey?: string;
  readonly adapterConfig?: JsonObject;
  readonly status?: EnvironmentStatus;
}

export interface EnvironmentRecord extends EnvironmentInput {
  readonly id: string;
  readonly systemId: string;
  readonly status: EnvironmentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TestCaseRecord {
  readonly id: string;
  readonly moduleId: string;
  readonly name: string;
  readonly status: CaseStatus;
  readonly currentDraftVersionId: string | null;
  readonly currentPublishedVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TestCaseVersionRecord {
  readonly id: string;
  readonly caseId: string;
  readonly version: number;
  readonly schemaVersion: string;
  readonly definition: JsonObject;
  readonly contentHash: string;
  readonly changeNote: string;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface SecretMetadata {
  readonly id: string;
  readonly systemId: string;
  readonly environmentId: string | null;
  readonly key: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface EncryptedSecret {
  readonly ciphertext: Uint8Array;
  readonly initializationVector: Uint8Array;
  readonly authenticationTag: Uint8Array;
}

export interface SuiteInput {
  readonly systemId: string;
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly caseIds: readonly string[];
  readonly defaultConcurrency?: number;
  readonly defaultDiagnosticRetries?: number;
}

export interface TestSuiteRecord {
  readonly id: string;
  readonly systemId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly caseIds: readonly string[];
  readonly defaultConcurrency: number;
  readonly defaultDiagnosticRetries: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DefinitionResourceRecord {
  readonly id: string;
  readonly systemId: string;
  readonly name: string;
  readonly currentVersionId: string | null;
  readonly currentPublishedVersionId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DefinitionVersionRecord {
  readonly id: string;
  readonly resourceId: string;
  readonly version: number;
  readonly definition: JsonObject;
  readonly contentHash: string;
  readonly changeNote: string;
  readonly publishedAt?: string | null;
  readonly createdAt: string;
}

export interface CaseTemplateRecord {
  readonly id: string;
  readonly systemId: string | null;
  readonly key: string;
  readonly name: string;
  readonly definition: JsonObject;
  readonly createdAt: string;
}

export interface AuditContext {
  readonly requestId: string;
  readonly sourceIp?: string;
  readonly entrypoint: string;
}

export interface ListCaseFilters {
  readonly systemId?: string;
  readonly status?: CaseStatus;
}

export interface CreateCaseCommand {
  readonly moduleId: string;
  readonly definition: JsonObject;
  readonly contentHash: string;
  readonly changeNote: string;
}

export interface CreateVersionCommand {
  readonly caseId: string;
  readonly definition: JsonObject;
  readonly contentHash: string;
  readonly expectedBaseVersion: number;
  readonly changeNote: string;
}

export interface GenericVersionCommand {
  readonly resourceId: string;
  readonly definition: JsonObject;
  readonly contentHash: string;
  readonly expectedBaseVersion: number;
  readonly changeNote: string;
}

export interface ControlPlaneRepository {
  listSystems(): Promise<readonly SystemRecord[]>;
  createSystem(input: SystemInput, audit: AuditContext): Promise<SystemRecord>;
  getSystem(id: string): Promise<SystemRecord | null>;
  updateSystem(id: string, patch: SystemPatch, audit: AuditContext): Promise<SystemRecord | null>;
  listModules(systemId: string): Promise<readonly ModuleRecord[]>;
  createModule(systemId: string, input: ModuleInput, audit: AuditContext): Promise<ModuleRecord>;
  getModule(id: string): Promise<ModuleRecord | null>;
  listEnvironments(systemId: string): Promise<readonly EnvironmentRecord[]>;
  createEnvironment(
    systemId: string,
    input: EnvironmentInput,
    audit: AuditContext,
  ): Promise<EnvironmentRecord>;
  getEnvironment(id: string): Promise<EnvironmentRecord | null>;
  updateEnvironment(
    id: string,
    patch: EnvironmentPatch,
    audit: AuditContext,
  ): Promise<EnvironmentRecord | null>;
  listSecretMetadata(): Promise<readonly SecretMetadata[]>;
  upsertSecret(
    systemId: string,
    environmentId: string | null,
    key: string,
    encrypted: EncryptedSecret,
    audit: AuditContext,
  ): Promise<SecretMetadata>;
  listCases(filters: ListCaseFilters): Promise<readonly TestCaseRecord[]>;
  createCase(command: CreateCaseCommand, audit: AuditContext): Promise<TestCaseRecord>;
  getCase(id: string): Promise<TestCaseRecord | null>;
  updateCaseMetadata(
    id: string,
    patch: Readonly<{ name?: string; status?: CaseStatus }>,
    audit: AuditContext,
  ): Promise<TestCaseRecord | null>;
  listCaseVersions(caseId: string): Promise<readonly TestCaseVersionRecord[]>;
  getCaseVersion(id: string): Promise<TestCaseVersionRecord | null>;
  createCaseVersion(
    command: CreateVersionCommand,
    audit: AuditContext,
  ): Promise<TestCaseVersionRecord | null>;
  saveValidation(versionId: string, result: ValidationResult): Promise<void>;
  publishCaseVersion(
    caseId: string,
    versionId: string,
    result: ValidationResult,
    audit: AuditContext,
  ): Promise<TestCaseRecord | null>;
  rollbackCase(
    caseId: string,
    sourceVersionId: string,
    audit: AuditContext,
  ): Promise<TestCaseVersionRecord | null>;
  listSuites(): Promise<readonly TestSuiteRecord[]>;
  createSuite(input: SuiteInput, audit: AuditContext): Promise<TestSuiteRecord>;
  getSuite(id: string): Promise<TestSuiteRecord | null>;
  updateSuite(id: string, input: SuiteInput, audit: AuditContext): Promise<TestSuiteRecord | null>;
  listDefinitionResources(
    kind: "dataset" | "shared-step",
    systemId?: string,
  ): Promise<readonly DefinitionResourceRecord[]>;
  createDefinitionResource(
    kind: "dataset" | "shared-step",
    systemId: string,
    name: string,
    definition: JsonObject,
    contentHash: string,
    changeNote: string,
    audit: AuditContext,
  ): Promise<DefinitionResourceRecord>;
  listDefinitionVersions(
    kind: "dataset" | "shared-step",
    resourceId: string,
  ): Promise<readonly DefinitionVersionRecord[]>;
  createDefinitionVersion(
    kind: "dataset" | "shared-step",
    command: GenericVersionCommand,
    audit: AuditContext,
  ): Promise<DefinitionVersionRecord | null>;
  publishSharedStep(
    resourceId: string,
    versionId: string,
    audit: AuditContext,
  ): Promise<DefinitionResourceRecord | null>;
  listCaseTemplates(systemId?: string): Promise<readonly CaseTemplateRecord[]>;
}
