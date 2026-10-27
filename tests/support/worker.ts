import { withDb, tenantA, tokenA } from "./database.js";
import { withQueues } from "./queues.js";
import { openDb, type Db } from "../../src/db/connect.js";
import { startReceiver } from "../../src/receiver/server.js";
import { seedReceiverCredentials } from "../../src/receiver/store.js";
import type { WorkerDeps } from "../../src/worker/consumer.js";
import type { QueueConfig } from "../../src/worker/queue.js";
import type { SQSClient } from "@aws-sdk/client-sqs";
export const integrationToken = "integration-test-".padEnd(48, "i");
export async function withWorker<T>(
  run: (
    deps: WorkerDeps,
    admin: Db,
    extra: {
      config: QueueConfig;
      client: SQSClient;
      appUrl: string;
      receiverUrl: string;
    },
  ) => Promise<T>,
): Promise<T> {
  return withDb(async (admin, info) =>
    withQueues(async (queue, config, client) => {
      await seedReceiverCredentials(admin, [
        { ...tenantA, token: integrationToken, purpose: "integration" },
        { ...tenantA, token: tokenA, purpose: "operator" },
      ]);
      const receiverDb = openDb(info.receiverUrl);
      const db = openDb(info.appUrl);
      const server = await startReceiver({
        db: receiverDb,
        host: "127.0.0.1",
        port: 0,
        demoMode: true,
      });
      try {
        return await run(
          {
            db,
            queue,
            clock: { now: () => new Date() },
            receiverOrigin: server.origin,
            receiverTokens: new Map([[tenantA.tenantId, integrationToken]]),
          },
          admin,
          {
            config,
            client,
            appUrl: info.appUrl,
            receiverUrl: info.receiverUrl,
          },
        );
      } finally {
        await server.close();
        await receiverDb.close();
        await db.close();
      }
    }),
  );
}
