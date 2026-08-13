import { randomUUID } from "node:crypto";

import { platformVersion, type TestRunJob } from "@spark-x-test/contracts";
import {
  createServiceApplication,
  listen,
  TestRunStore,
  writeServiceHeartbeat,
} from "@spark-x-test/service-runtime";
import { Worker } from "bullmq";

import { executeRunJob } from "./run-executor.js";

const application = createServiceApplication("worker");
const port = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? "4102", 10);
const instanceId = application.config.workerIdentity ?? randomUUID();
const concurrency = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);
const queueName = `${application.config.queueName}-control`;
const runQueueName = `${application.config.queueName}-runs`;
const configuredImageDigest = process.env.WORKER_IMAGE_DIGEST?.trim();
const workerImageDigest =
  configuredImageDigest === undefined || configuredImageDigest === ""
    ? `git:${process.env.PLATFORM_RELEASE_COMMIT ?? platformVersion}`
    : configuredImageDigest;
const runStore = new TestRunStore(
  application.dependencies.postgres,
  process.env.PLATFORM_SECRET_ENCRYPTION_KEY,
);
const workerRegistration = {
  ...(application.config.workerIdentity === undefined
    ? {}
    : { identity: application.config.workerIdentity }),
  imageDigest: workerImageDigest,
  executorVersion: platformVersion,
  concurrencySlots: concurrency,
  capabilities: ["http:request", "finally", "diagnostic-retry"],
} as const;

await runStore.registerWorker(instanceId, workerRegistration);

const controlWorker = new Worker(
  queueName,
  async (job) => {
    if (job.name !== "platform.heartbeat") {
      throw new Error(`Unsupported M1 control job: ${job.name}`);
    }
    await Promise.all([
      writeServiceHeartbeat(application.dependencies, "worker", instanceId, {
        queue: queueName,
        workerIdentityConfigured: application.config.workerIdentity !== undefined,
        schedulerJobId: job.id,
      }),
      runStore.registerWorker(instanceId, workerRegistration),
    ]);
    return { acknowledgedAt: new Date().toISOString() };
  },
  {
    connection: { url: application.config.redisUrl },
    concurrency,
  },
);

const runWorker = new Worker<TestRunJob>(
  runQueueName,
  async (job) => {
    if (job.name !== "run.execute") throw new Error(`Unsupported run job: ${job.name}`);
    return executeRunJob(job.data, instanceId, runStore);
  },
  {
    connection: { url: application.config.redisUrl },
    concurrency,
    lockDuration: 30_000,
    stalledInterval: 15_000,
    maxStalledCount: 1,
  },
);

await Promise.all([controlWorker.waitUntilReady(), runWorker.waitUntilReady()]);
await writeServiceHeartbeat(application.dependencies, "worker", instanceId, {
  queues: [queueName, runQueueName],
  concurrency,
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  application.app.log.info({ signal }, "shutting down worker service");
  await Promise.all([controlWorker.close(), runWorker.close(), application.app.close()]);
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await listen(application.app, port);
