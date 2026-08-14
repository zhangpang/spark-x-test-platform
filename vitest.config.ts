import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@spark-x-test/adapter-spark-x-agent": fileURLToPath(
        new URL("./adapters/spark-x-agent/src/index.ts", import.meta.url),
      ),
      "@spark-x-test/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@spark-x-test/case-schema": fileURLToPath(
        new URL("./packages/case-schema/src/index.ts", import.meta.url),
      ),
      "@spark-x-test/execution-engine": fileURLToPath(
        new URL("./packages/execution-engine/src/index.ts", import.meta.url),
      ),
      "@spark-x-test/executors": fileURLToPath(
        new URL("./packages/executors/src/index.ts", import.meta.url),
      ),
      "@spark-x-test/reporting": fileURLToPath(
        new URL("./packages/reporting/src/index.ts", import.meta.url),
      ),
      "@spark-x-test/service-runtime": fileURLToPath(
        new URL("./packages/service-runtime/src/index.ts", import.meta.url),
      ),
      "@spark-x-test/adapter-sdk": fileURLToPath(
        new URL("./packages/adapter-sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["{apps,packages,adapters}/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
