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

const packageLock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
  packages: Record<string, { version?: string }>;
};
const playwrightVersion = packageLock.packages["node_modules/playwright"]?.version;
if (playwrightVersion !== "1.55.1") {
  throw new Error("Playwright resource contract must be reviewed when Playwright is upgraded");
}

const [
  workerDockerfile,
  playwrightBaseDockerfile,
  composeFile,
  releaseScript,
  resourceScript,
] = await Promise.all([
  readFile("infra/compose/Dockerfile.worker", "utf8"),
  readFile("infra/compose/Dockerfile.playwright-base", "utf8"),
  readFile("infra/compose/compose.yaml", "utf8"),
  readFile("infra/deploy/release.sh", "utf8"),
  readFile("infra/deploy/manage-playwright-base.sh", "utf8"),
]);
const expectedPlaywrightBase = `spark-x-test-platform-playwright-base:node22.18.0-pw${playwrightVersion}`;
if (
  !workerDockerfile.includes(`ARG PLAYWRIGHT_BASE_IMAGE=${expectedPlaywrightBase}`) ||
  workerDockerfile.includes("playwright install --with-deps") ||
  !playwrightBaseDockerfile.includes(`ARG PLAYWRIGHT_VERSION=${playwrightVersion}`) ||
  !composeFile.includes(`PLAYWRIGHT_BASE_IMAGE: \${PLAYWRIGHT_BASE_IMAGE:-${expectedPlaywrightBase}}`) ||
  !releaseScript.includes(`DEFAULT_PLAYWRIGHT_BASE_IMAGE="${expectedPlaywrightBase}"`) ||
  !releaseScript.includes("sha256sum -c") ||
  !releaseScript.includes("verify_playwright_base_image") ||
  !resourceScript.includes(`BASE_IMAGE="${expectedPlaywrightBase}"`) ||
  !resourceScript.includes("promote-worker") ||
  !resourceScript.includes("docker save")
) {
  throw new Error(
    "Worker releases must load a versioned, checksummed Playwright base resource instead of downloading browser dependencies",
  );
}

console.info(
  `contracts valid: test-case schema, adapter manifest, Playwright ${playwrightVersion} base resource, ${operationIds.length} OpenAPI operations`,
);
