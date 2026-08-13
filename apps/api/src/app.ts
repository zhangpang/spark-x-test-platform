import { apiVersion, platformVersion } from "@spark-x-test/contracts";
import { createServiceApplication } from "@spark-x-test/service-runtime";

export function buildApiApplication(environment: NodeJS.ProcessEnv = process.env) {
  const application = createServiceApplication("api", {
    environment,
    healthPrefix: `/api/${apiVersion}`,
    logger: environment.NODE_ENV !== "test",
  });

  application.app.get(`/api/${apiVersion}`, () => ({
    name: "spark-x-test-platform",
    version: platformVersion,
    apiVersion,
    phase: "M1-engineering-foundation",
  }));

  return application;
}
