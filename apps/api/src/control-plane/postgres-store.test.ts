import { describe, expect, it } from "vitest";

import type { AuditContext, CreateCaseCommand, JsonObject } from "./model.js";
import {
  PostgresControlPlaneRepository,
  type SqlExecutor,
  type SqlQueryResult,
} from "./postgres-store.js";

const createdAt = "2026-08-13T00:00:00.000Z";
const audit: AuditContext = {
  requestId: "request-1",
  sourceIp: "127.0.0.1",
  entrypoint: "POST /api/v1/test-cases",
};

class RecordingSqlExecutor implements SqlExecutor {
  readonly queries: string[] = [];
  transactionCount = 0;
  #insideTransaction = false;

  query<Row>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    if (!this.#insideTransaction) {
      throw new Error("Creation queries must execute inside a transaction.");
    }
    const normalized = text.replaceAll(/\s+/g, " ").trim();
    this.queries.push(normalized);

    let rows: readonly unknown[] = [];
    if (normalized.startsWith("update test_cases")) {
      rows = [
        {
          id: values[0],
          module_id: "00000000-0000-4000-8000-000000000101",
          name: "Case",
          status: "draft",
          current_draft_version_id: values[1],
          current_published_version_id: null,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ];
    } else if (normalized.startsWith("update datasets")) {
      rows = [
        {
          id: values[0],
          system_id: "00000000-0000-4000-8000-000000000102",
          name: "Dataset",
          current_version_id: values[1],
          created_at: createdAt,
          updated_at: createdAt,
        },
      ];
    } else if (normalized.startsWith("update shared_steps")) {
      rows = [
        {
          id: values[0],
          system_id: "00000000-0000-4000-8000-000000000102",
          name: "Shared step",
          current_version_id: values[1],
          current_published_version_id: null,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ];
    }
    return Promise.resolve({ rows: rows as readonly Row[], rowCount: rows.length });
  }

  transaction<Result>(work: (sql: SqlExecutor) => Promise<Result>): Promise<Result> {
    this.transactionCount += 1;
    this.#insideTransaction = true;
    return work(this).finally(() => {
      this.#insideTransaction = false;
    });
  }
}

describe("Postgres control-plane creation transactions", () => {
  it("creates a case, v1 pointer and audit sequentially in one transaction", async () => {
    const sql = new RecordingSqlExecutor();
    const repository = new PostgresControlPlaneRepository(sql);
    const definition: JsonObject = {
      schemaVersion: "1.0",
      metadata: { name: "Case" },
    };
    const command: CreateCaseCommand = {
      moduleId: "00000000-0000-4000-8000-000000000101",
      definition,
      contentHash: "a".repeat(64),
      changeNote: "Initial version",
    };

    const result = await repository.createCase(command, audit);

    expect(sql.transactionCount).toBe(1);
    expect(sql.queries.map((query) => query.split(" ").slice(0, 3).join(" "))).toEqual([
      "insert into test_cases",
      "insert into test_case_versions",
      "update test_cases set",
      "insert into operation_audits",
    ]);
    expect(result.currentDraftVersionId).not.toBeNull();
  });

  it.each(["dataset", "shared-step"] as const)(
    "creates %s resource, v1 pointer and audit sequentially in one transaction",
    async (kind) => {
      const sql = new RecordingSqlExecutor();
      const repository = new PostgresControlPlaneRepository(sql);

      const result = await repository.createDefinitionResource(
        kind,
        "00000000-0000-4000-8000-000000000102",
        kind === "dataset" ? "Dataset" : "Shared step",
        { value: 1 },
        "b".repeat(64),
        "Initial version",
        audit,
      );

      expect(sql.transactionCount).toBe(1);
      expect(sql.queries[0]).toContain(
        kind === "dataset" ? "insert into datasets" : "insert into shared_steps",
      );
      expect(sql.queries[1]).toContain(
        kind === "dataset" ? "insert into dataset_versions" : "insert into shared_step_versions",
      );
      expect(sql.queries[2]).toContain(
        kind === "dataset" ? "update datasets" : "update shared_steps",
      );
      expect(sql.queries[3]).toContain("insert into operation_audits");
      expect(result.currentVersionId).not.toBeNull();
    },
  );
});
