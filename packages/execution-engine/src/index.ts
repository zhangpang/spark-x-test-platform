import type { RunStatus } from "@spark-x-test/contracts";

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
