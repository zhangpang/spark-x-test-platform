import { afterEach, describe, expect, it } from "vitest";

import { buildApiApplication } from "./app.js";

const environment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  REDIS_URL: "redis://127.0.0.1:1/0",
  MINIO_ENDPOINT: "127.0.0.1",
  MINIO_PORT: "1",
  MINIO_USE_SSL: "false",
  MINIO_ACCESS_KEY: "unused",
  MINIO_SECRET_KEY: "unused",
  MINIO_BUCKET: "unused",
};

const applications: ReturnType<typeof buildApiApplication>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async ({ app }) => app.close()));
});

describe("API service", () => {
  it("serves liveness without requiring external dependencies", async () => {
    const application = buildApiApplication(environment);
    applications.push(application);
    const response = await application.app.inject({ method: "GET", url: "/api/v1/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "api", version: "0.1.0" });
  });

  it("exposes immutable build identity", async () => {
    const application = buildApiApplication(environment);
    applications.push(application);
    const response = await application.app.inject({ method: "GET", url: "/api/v1" });
    expect(response.json()).toMatchObject({
      name: "spark-x-test-platform",
      phase: "M1-engineering-foundation",
    });
  });

  it("returns a bounded 503 response when dependencies are unavailable", async () => {
    const application = buildApiApplication(environment);
    applications.push(application);
    const response = await application.app.inject({ method: "GET", url: "/api/v1/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      dependencies: {
        postgres: { status: "error" },
        redis: { status: "error" },
        minio: { status: "error" },
      },
    });
  });
});
