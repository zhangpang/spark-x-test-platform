import type {
  CaseResult,
  GateResult,
  RunFailure,
  RunStatus,
  RunSummary,
} from "@spark-x-test/contracts";

const transitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["preparing", "cancelling"],
  preparing: ["running", "cancelling", "interrupted"],
  running: ["cancelling", "cleaning", "interrupted"],
  cancelling: ["cleaning", "interrupted"],
  cleaning: ["completed", "compensation_pending", "interrupted"],
  interrupted: ["compensation_pending", "completed"],
  compensation_pending: ["completed"],
  completed: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return transitions[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}

const emptySummary: RunSummary = {
  total: 0,
  queued: 0,
  running: 0,
  passed: 0,
  productFailed: 0,
  testFailed: 0,
  environmentFailed: 0,
  infrastructureFailed: 0,
  flaky: 0,
  cancelled: 0,
  skipped: 0,
};

export function createEmptyRunSummary(total = 0): RunSummary {
  return { ...emptySummary, total, queued: total };
}

export function summarizeCaseResults(
  results: readonly (CaseResult | "queued" | "running")[],
): RunSummary {
  const summary = { ...emptySummary, total: results.length };
  for (const result of results) {
    switch (result) {
      case "queued":
        summary.queued += 1;
        break;
      case "running":
        summary.running += 1;
        break;
      case "passed":
        summary.passed += 1;
        break;
      case "product_failed":
        summary.productFailed += 1;
        break;
      case "test_failed":
        summary.testFailed += 1;
        break;
      case "environment_failed":
        summary.environmentFailed += 1;
        break;
      case "infrastructure_failed":
        summary.infrastructureFailed += 1;
        break;
      case "flaky":
        summary.flaky += 1;
        break;
      case "cancelled":
        summary.cancelled += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
    }
  }
  return summary;
}

export function gateResultForSummary(summary: RunSummary): GateResult {
  if (summary.productFailed > 0 || summary.testFailed > 0) return "blocked";
  if (
    summary.environmentFailed > 0 ||
    summary.infrastructureFailed > 0 ||
    summary.cancelled > 0 ||
    summary.skipped > 0
  ) {
    return "inconclusive";
  }
  return "passed";
}

const failurePriority: Readonly<Record<RunFailure["classification"], number>> = {
  infrastructure_failed: 1,
  environment_failed: 2,
  test_failed: 3,
  product_failed: 4,
};

export function choosePrimaryFailure(failures: readonly RunFailure[]): RunFailure | null {
  return (
    [...failures].sort(
      (left, right) => failurePriority[right.classification] - failurePriority[left.classification],
    )[0] ?? null
  );
}
