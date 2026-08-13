import { randomUUID } from "node:crypto";

import {
  createServiceApplication,
  listen,
  writeServiceHeartbeat,
} from "@spark-x-test/service-runtime";
import { Queue } from "bullmq";

const application = createServiceApplication("scheduler");
const port = Number.parseInt(process.env.SCHEDULER_HEALTH_PORT ?? "4101", 10);
const instanceId = randomUUID();
const controlQueue = new Queue(`${application.config.queueName}-control`, {
  connection: { url: application.config.redisUrl },
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

async function heartbeat(): Promise<void> {
  await writeServiceHeartbeat(application.dependencies, "scheduler", instanceId, {
    queue: controlQueue.name,
  });
}

await controlQueue.upsertJobScheduler(
  "platform-control-heartbeat",
  { every: 60_000 },
  {
    name: "platform.heartbeat",
    data: { protocolVersion: "1.0", scheduledBy: instanceId },
  },
);
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
heartbeatTimer.unref();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  clearInterval(heartbeatTimer);
  application.app.log.info({ signal }, "shutting down scheduler service");
  await Promise.all([controlQueue.close(), application.app.close()]);
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await listen(application.app, port);
