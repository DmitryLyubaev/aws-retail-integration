import { once } from "node:events";
import { openDb } from "../../src/db/connect.js";
import { createQueue, type QueueConfig } from "../../src/worker/queue.js";
import { consumeOnce } from "../../src/worker/consumer.js";
import { collectOnce } from "../../src/worker/collector.js";
const db = openDb(process.env.CHILD_DATABASE_URL!);
const actual = createQueue(
  JSON.parse(process.env.CHILD_QUEUE_CONFIG!) as QueueConfig,
);
let handle = "";
const queue = {
  ...actual,
  receive: async (kind: "source" | "dlq") => {
    const messages = await actual.receive(kind);
    handle = messages[0]?.receiptHandle ?? "";
    return messages;
  },
};
const count = await (
  process.env.COLLECTOR === "true" ? collectOnce : consumeOnce
)({
  db,
  queue,
  clock: { now: () => new Date() },
  receiverOrigin: process.env.RECEIVER_ORIGIN!,
  receiverTokens: new Map(JSON.parse(process.env.RECEIVER_TOKENS!)),
  fault: async (point) => {
    if (point === process.env.BARRIER) {
      process.send?.({ event: "barrier", point, handle });
      await once(process, "message");
    }
  },
});
process.send?.({ event: "done", count, handle });
queue.close();
await db.close();
process.disconnect();
