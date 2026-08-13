import { afterEach, describe, expect, it } from "vitest";

import type { ControlPlaneRepository, JsonObject } from "./control-plane/model.js";
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
      phase: "M2-test-asset-control-plane",
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

  it("creates systems through the versioned control-plane API", async () => {
    const repository = {
      createSystem: (input: Readonly<Record<string, unknown>>) =>
        Promise.resolve({
          ...input,
          id: "00000000-0000-4000-8000-000000000001",
          description: "",
          status: "active",
          concurrencyLimit: 5,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
    } as unknown as ControlPlaneRepository;
    const application = buildApiApplication(environment, { repository });
    applications.push(application);
    const response = await application.app.inject({
      method: "POST",
      url: "/api/v1/systems",
      payload: { key: "sample-system", name: "Sample System" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ key: "sample-system", status: "active" });
  });

  it("rejects plaintext secrets before a case draft reaches persistence", async () => {
    let createCalled = false;
    const repository = {
      getModule: () =>
        Promise.resolve({
          id: "00000000-0000-4000-8000-000000000010",
          systemId: "00000000-0000-4000-8000-000000000011",
          key: "order",
          name: "Order",
          sortOrder: 0,
          createdAt: new Date(0).toISOString(),
        }),
      getSystem: () =>
        Promise.resolve({
          id: "00000000-0000-4000-8000-000000000011",
          key: "sample-system",
          name: "Sample",
          description: "",
          status: "active",
          concurrencyLimit: 5,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        }),
      createCase: () => {
        createCalled = true;
        return Promise.reject(new Error("must not persist"));
      },
    } as unknown as ControlPlaneRepository;
    const application = buildApiApplication(environment, { repository });
    applications.push(application);
    const definition: JsonObject = {
      metadata: { name: "unsafe" },
      steps: [{ params: { password: "plain-password" } }],
    };
    const response = await application.app.inject({
      method: "POST",
      url: "/api/v1/test-cases",
      payload: {
        moduleId: "00000000-0000-4000-8000-000000000010",
        definition,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    expect(createCalled).toBe(false);
  });
});
