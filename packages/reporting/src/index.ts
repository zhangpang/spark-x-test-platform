import { caseResults, type CaseResult } from "@spark-x-test/contracts";

export type ResultSummary = Readonly<Record<CaseResult, number>>;

export function summarizeResults(results: readonly CaseResult[]): ResultSummary {
  const summary = Object.fromEntries(caseResults.map((result) => [result, 0])) as Record<
    CaseResult,
    number
  >;
  for (const result of results) {
    summary[result] += 1;
  }
  return summary;
}
