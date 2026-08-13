import { listen } from "@spark-x-test/service-runtime";

import { buildApiApplication } from "./app.js";

const application = buildApiApplication();
const port = Number.parseInt(process.env.API_PORT ?? "4100", 10);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  application.app.log.info({ signal }, "shutting down API service");
  await application.app.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await listen(application.app, port);
