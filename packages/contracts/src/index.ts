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
