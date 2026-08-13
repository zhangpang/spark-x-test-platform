import { randomUUID } from "node:crypto";

import {
  createServiceApplication,
  listen,
  writeServiceHeartbeat,
} from "@spark-x-test/service-runtime";
import { Worker } from "bullmq";

const application = createServiceApplication("worker");
const port = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? "4102", 10);
const instanceId = application.config.workerIdentity ?? randomUUID();
const concurrency = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);
const queueName = `${application.config.queueName}-control`;

const controlWorker = new Worker(
  queueName,
  async (job) => {
    if (job.name !== "platform.heartbeat") {
      throw new Error(`Unsupported M1 control job: ${job.name}`);
    }
    await writeServiceHeartbeat(application.dependencies, "worker", instanceId, {
      queue: queueName,
      workerIdentityConfigured: application.config.workerIdentity !== undefined,
      schedulerJobId: job.id,
    });
    return { acknowledgedAt: new Date().toISOString() };
  },
  {
    connection: { url: application.config.redisUrl },
    concurrency,
  },
);

await controlWorker.waitUntilReady();
await writeServiceHeartbeat(application.dependencies, "worker", instanceId, {
  queue: queueName,
  concurrency,
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  application.app.log.info({ signal }, "shutting down worker service");
  await Promise.all([controlWorker.close(), application.app.close()]);
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await listen(application.app, port);
