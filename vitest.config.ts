import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@spark-x-test/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
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
