export type ActionLevel = "read" | "write" | "dangerous";

export interface SystemRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly status: "active" | "archived";
  readonly concurrencyLimit: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModuleRecord {
  readonly id: string;
  readonly systemId: string;
  readonly key: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface EnvironmentRecord {
  readonly id: string;
  readonly systemId: string;
  readonly key: string;
  readonly name: string;
  readonly kind: "test" | "staging" | "production";
  readonly baseUrl: string;
  readonly actionLevel: ActionLevel;
  readonly status: "active" | "disabled" | "archived";
}

export interface TestCaseRecord {
  readonly id: string;
  readonly moduleId: string;
  readonly name: string;
  readonly status: "draft" | "published" | "disabled" | "archived";
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
  readonly definition: Readonly<Record<string, unknown>>;
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

export interface TestSuiteRecord {
  readonly id: string;
  readonly systemId: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly caseIds: readonly string[];
  readonly defaultConcurrency: number;
  readonly defaultDiagnosticRetries: number;
}

export interface SecretMetadata {
  readonly id: string;
  readonly systemId: string;
  readonly environmentId: string | null;
  readonly key: string;
  readonly version: number;
  readonly updatedAt: string;
}

interface Page<T> {
  readonly items: readonly T[];
}

interface ApiErrorPayload {
  readonly code?: string;
  readonly message?: string;
  readonly requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly requestId?: string;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message ?? `请求失败（HTTP ${status}）`);
    this.name = "ApiError";
    this.status = status;
    this.requestId = payload.requestId;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let payload: ApiErrorPayload = {};
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      payload = {};
    }
    throw new ApiError(response.status, payload);
  }
  return (await response.json()) as T;
}

export const controlPlaneApi = {
  async listSystems(): Promise<readonly SystemRecord[]> {
    return (await request<Page<SystemRecord>>("/systems")).items;
  },
  createSystem(input: Readonly<Record<string, unknown>>): Promise<SystemRecord> {
    return request("/systems", { method: "POST", body: JSON.stringify(input) });
  },
  listModules(systemId: string): Promise<readonly ModuleRecord[]> {
    return request(`/systems/${systemId}/modules`);
  },
  createModule(systemId: string, input: Readonly<Record<string, unknown>>): Promise<ModuleRecord> {
    return request(`/systems/${systemId}/modules`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  listEnvironments(systemId: string): Promise<readonly EnvironmentRecord[]> {
    return request(`/systems/${systemId}/environments`);
  },
  createEnvironment(
    systemId: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<EnvironmentRecord> {
    return request(`/systems/${systemId}/environments`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  listSecrets(): Promise<readonly SecretMetadata[]> {
    return request("/secrets");
  },
  upsertSecret(input: Readonly<Record<string, unknown>>): Promise<SecretMetadata> {
    return request("/secrets", { method: "POST", body: JSON.stringify(input) });
  },
  async listCases(systemId?: string): Promise<readonly TestCaseRecord[]> {
    const suffix = systemId === undefined ? "" : `?systemId=${encodeURIComponent(systemId)}`;
    return (await request<Page<TestCaseRecord>>(`/test-cases${suffix}`)).items;
  },
  createCase(
    moduleId: string,
    definition: Readonly<Record<string, unknown>>,
  ): Promise<TestCaseRecord> {
    return request("/test-cases", {
      method: "POST",
      body: JSON.stringify({ moduleId, definition, changeNote: "Created from HTTP editor" }),
    });
  },
  listCaseVersions(caseId: string): Promise<readonly TestCaseVersionRecord[]> {
    return request(`/test-cases/${caseId}/versions`);
  },
  validateVersion(versionId: string, environmentId?: string): Promise<ValidationResult> {
    return request(`/test-case-versions/${versionId}/validations`, {
      method: "POST",
      body: JSON.stringify(environmentId === undefined ? {} : { environmentId }),
    });
  },
  publishCase(caseId: string, versionId: string): Promise<TestCaseRecord> {
    return request(`/test-cases/${caseId}/publish`, {
      method: "POST",
      body: JSON.stringify({ versionId }),
    });
  },
  rollbackCase(caseId: string, sourceVersionId: string): Promise<TestCaseVersionRecord> {
    return request(`/test-cases/${caseId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ sourceVersionId }),
    });
  },
  async compareVersions(
    caseId: string,
    baseVersionId: string,
    targetVersionId: string,
  ): Promise<readonly Readonly<{ path: string; before?: unknown; after?: unknown }>[]> {
    const params = new URLSearchParams({ baseVersionId, targetVersionId });
    const result = await request<{
      readonly changes: readonly Readonly<{ path: string; before?: unknown; after?: unknown }>[];
    }>(`/test-cases/${caseId}/comparisons?${params.toString()}`);
    return result.changes;
  },
  async exportCases(caseIds: readonly string[], format: "json" | "yaml"): Promise<Blob> {
    const response = await fetch("/api/v1/test-cases/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caseIds, format }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as ApiErrorPayload;
      throw new ApiError(response.status, payload);
    }
    return response.blob();
  },
  importCases(
    systemId: string,
    format: "json" | "yaml",
    content: string,
    mode: "validate_only" | "create_drafts",
  ): Promise<ValidationResult> {
    return request("/test-cases/imports", {
      method: "POST",
      body: JSON.stringify({ systemId, format, content, mode }),
    });
  },
  async listSuites(): Promise<readonly TestSuiteRecord[]> {
    return (await request<Page<TestSuiteRecord>>("/test-suites")).items;
  },
  createSuite(input: Readonly<Record<string, unknown>>): Promise<TestSuiteRecord> {
    return request("/test-suites", { method: "POST", body: JSON.stringify(input) });
  },
};
