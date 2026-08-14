export const platformVersion = "0.1.0" as const;
export const apiVersion = "v1" as const;

export const serviceNames = ["api", "scheduler", "worker"] as const;
export type ServiceName = (typeof serviceNames)[number];

export const dependencyNames = ["postgres", "redis", "minio"] as const;
export type DependencyName = (typeof dependencyNames)[number];

export const dependencyStatuses = ["ok", "error"] as const;
export type DependencyStatus = (typeof dependencyStatuses)[number];

export interface DependencyHealth {
  readonly status: DependencyStatus;
  readonly latencyMs: number;
  readonly error?: string;
}

export interface HealthResponse {
  readonly status: "ok" | "degraded";
  readonly service: ServiceName;
  readonly version: string;
  readonly time: string;
  readonly uptimeSeconds: number;
  readonly dependencies?: Partial<Record<DependencyName, DependencyHealth>>;
}

export const runStatuses = [
  "queued",
  "preparing",
  "running",
  "cancelling",
  "cleaning",
  "interrupted",
  "compensation_pending",
  "completed",
] as const;
export type RunStatus = (typeof runStatuses)[number];

export const caseResults = [
  "passed",
  "product_failed",
  "test_failed",
  "environment_failed",
  "infrastructure_failed",
  "flaky",
  "cancelled",
  "skipped",
] as const;
export type CaseResult = (typeof caseResults)[number];

export const gateResults = ["passed", "blocked", "inconclusive"] as const;
export type GateResult = (typeof gateResults)[number];

export const queueNames = {
  testRuns: "test-runs",
  cleanup: "cleanup-jobs",
} as const;

export interface TestRunJob {
  readonly protocolVersion: "1.0";
  readonly runId: string;
  readonly queuedAt: string;
  readonly priority: number;
}

export const runCaseStatuses = ["queued", "running", "cleaning", "completed"] as const;
export type RunCaseStatus = (typeof runCaseStatuses)[number];

export const cleanupStatuses = ["pending", "not_required", "running", "passed", "failed"] as const;
export type CleanupStatus = (typeof cleanupStatuses)[number];

export interface RunSummary {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly passed: number;
  readonly productFailed: number;
  readonly testFailed: number;
  readonly environmentFailed: number;
  readonly infrastructureFailed: number;
  readonly flaky: number;
  readonly cancelled: number;
  readonly skipped: number;
}

export interface RunFailure {
  readonly code: string;
  readonly message: string;
  readonly classification: Exclude<CaseResult, "passed" | "flaky" | "cancelled" | "skipped">;
  readonly stepId?: string;
}

export interface TestRunRecord {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly triggerType: "manual" | "schedule" | "release" | "api";
  readonly triggerSource: string;
  readonly idempotencyKey: string;
  readonly priority: number;
  readonly systemId: string;
  readonly environmentId: string;
  readonly suiteId: string;
  readonly systemName: string;
  readonly environmentName: string;
  readonly suiteName: string;
  readonly testedVersion: string;
  readonly platformVersion: string;
  readonly status: RunStatus;
  readonly gateResult: GateResult | null;
  readonly summary: RunSummary;
  readonly cancellationRequested: boolean;
  readonly firstFailure: RunFailure | null;
  readonly workerId: string | null;
  readonly workerImageDigest: string | null;
  readonly executorVersion: string | null;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface TestRunCaseRecord {
  readonly id: string;
  readonly runId: string;
  readonly caseId: string;
  readonly caseVersionId: string;
  readonly caseName: string;
  readonly version: number;
  readonly iteration: number;
  readonly sortOrder: number;
  readonly status: RunCaseStatus;
  readonly result: CaseResult | null;
  readonly attempts: number;
  readonly flaky: boolean;
  readonly firstFailure: RunFailure | null;
  readonly cleanupStatus: CleanupStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

export interface StepRunRecord {
  readonly id: string;
  readonly runCaseId: string;
  readonly attempt: number;
  readonly stepPath: string;
  readonly stepId: string;
  readonly action: string;
  readonly phase: "main" | "finally";
  readonly status: "running" | "passed" | "failed" | "cancelled";
  readonly result: CaseResult | null;
  readonly inputSummary: Readonly<Record<string, unknown>>;
  readonly outputSummary: Readonly<Record<string, unknown>> | null;
  readonly error: RunFailure | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

export const artifactKinds = [
  "log",
  "screenshot",
  "trace",
  "http_exchange",
  "tool_call",
  "matched_document",
  "judge",
  "external_report",
] as const;
export type ArtifactKind = (typeof artifactKinds)[number];
export type ArtifactAvailability = "available" | "expired" | "missing";

export interface ArtifactRecord {
  readonly id: string;
  readonly runId: string;
  readonly runCaseId: string | null;
  readonly stepRunId: string | null;
  readonly attempt: number | null;
  readonly kind: ArtifactKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly redacted: boolean;
  readonly locked: boolean;
  readonly retainedUntil: string | null;
  readonly availability: ArtifactAvailability;
  readonly createdAt: string;
}

export interface ResourceLedgerRecord {
  readonly id: string;
  readonly runId: string;
  readonly runCaseId: string;
  readonly resourceType: string;
  readonly systemResourceId: string;
  readonly createdStepRunId: string | null;
  readonly cleanupDefinition: Readonly<Record<string, unknown>>;
  readonly cleanupStatus: "pending" | "running" | "passed" | "failed";
  readonly lastError: RunFailure | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const cleanupJobStatuses = ["queued", "running", "succeeded", "failed"] as const;
export type CleanupJobStatus = (typeof cleanupJobStatuses)[number];

export interface CleanupJobRecord {
  readonly id: string;
  readonly runId: string;
  readonly status: CleanupJobStatus;
  readonly attempts: number;
  readonly lastError: RunFailure | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

export interface RunCleanupJob {
  readonly protocolVersion: "1.0";
  readonly cleanupJobId: string;
  readonly runId: string;
  readonly queuedAt: string;
}

export interface TestRunDetail extends TestRunRecord {
  readonly cases: readonly TestRunCaseRecord[];
  readonly steps: readonly StepRunRecord[];
  readonly resources: readonly ResourceLedgerRecord[];
  readonly cleanupJob: CleanupJobRecord | null;
}

export interface RunEvent {
  readonly id: number;
  readonly runId: string;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}
