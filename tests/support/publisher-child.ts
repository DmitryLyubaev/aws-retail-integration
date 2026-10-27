import { openDb } from "../../src/db/connect.js";
import { acceptSale } from "../../src/db/accept.js";
import { parseSale } from "../../src/domain/sale.js";
import { publishOnce } from "../../src/worker/publisher.js";
import { createQueue, type QueueConfig } from "../../src/worker/queue.js";
import { fixture } from "./fixture.js";
import { tenantA } from "./database.js";
const db = openDb(process.env.CHILD_DATABASE_URL!);
const accepted = await acceptSale(
  db,
  tenantA,
  parseSale(Buffer.from(JSON.stringify(fixture()))),
);
async function barrier(point: string) {
  if (process.env.BARRIER === point) {
    console.log(
      JSON.stringify({ point, deliveryId: accepted.delivery.deliveryId }),
    );
    await new Promise(() => {});
  }
}
await barrier("after_accept_commit");
const queue = createQueue(
  JSON.parse(process.env.CHILD_QUEUE_CONFIG!) as QueueConfig,
);
await publishOnce({
  db,
  queue,
  clock: { now: () => new Date() },
  fault: barrier,
});
queue.close();
await db.close();
