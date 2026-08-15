import { readFile } from "node:fs/promises";

import { sparkXAgentAdapterManifest } from "@spark-x-test/adapter-spark-x-agent";
import { validateAdapterManifest } from "@spark-x-test/adapter-sdk";
import { validateTestCaseDefinition } from "@spark-x-test/case-schema";
import { parse } from "yaml";

const sampleCase = {
  schemaVersion: "1.0",
  kind: "automated",
  metadata: {
    name: "Contract validation sample",
    systemKey: "contract-system",
    moduleKey: "health",
    priority: "P0",
    classification: "blackbox",
    actionLevel: "read",
  },
  execution: {
    stepTimeoutMs: 10_000,
    caseTimeoutMs: 60_000,
    diagnosticRetries: 0,
  },
  steps: [
    {
      id: "check-health",
      name: "Check health",
      kind: "action",
      action: "http:get",
      params: { path: "/healthz" },
    },
  ],
  finally: [],
};

const caseResult = validateTestCaseDefinition(sampleCase);
if (!caseResult.valid) {
  throw new Error(
    `Test case schema rejected the contract sample: ${JSON.stringify(caseResult.errors)}`,
  );
}

const adapterManifest = JSON.parse(
  await readFile("adapters/spark-x-agent/adapter.manifest.json", "utf8"),
) as unknown;
const adapterResult = validateAdapterManifest(adapterManifest);
if (!adapterResult.valid) {
  throw new Error(
    `Adapter schema rejected the committed manifest: ${JSON.stringify(adapterResult.errors)}`,
  );
}
const committedSparkXAgentManifest = adapterManifest as {
  readonly key: string;
  readonly version: string;
  readonly capabilities: { readonly actions: readonly unknown[] };
};
if (
  committedSparkXAgentManifest.key !== sparkXAgentAdapterManifest.key ||
  committedSparkXAgentManifest.version !== sparkXAgentAdapterManifest.version ||
  JSON.stringify(committedSparkXAgentManifest.capabilities.actions) !==
    JSON.stringify(sparkXAgentAdapterManifest.capabilities.actions)
) {
  throw new Error(
    "Committed Spark X Agent adapter manifest must exactly match the runtime action contracts",
  );
}

const openapi = parse(await readFile("docs/api/openapi.yaml", "utf8")) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};
const operationIds: string[] = [];
for (const pathItem of Object.values(openapi.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) {
      continue;
    }
    if (operation.operationId === undefined)
      throw new Error(`OpenAPI ${method} operation lacks operationId`);
    operationIds.push(operation.operationId);
  }
}
if (new Set(operationIds).size !== operationIds.length) {
  throw new Error("OpenAPI operationId values must be unique");
}

console.info(
  `contracts valid: test-case schema, adapter manifest, ${operationIds.length} OpenAPI operations`,
);
