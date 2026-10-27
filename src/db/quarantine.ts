import { randomUUID } from "node:crypto";
import { sha256 } from "../domain/sale.js";
import type { QueueEnvelope } from "../domain/delivery.js";
import type { QueueMessage } from "../worker/queue.js";
import { transaction, type Db } from "./connect.js";
import { failGeneration } from "./attempts.js";
export async function persistQuarantine(
  db: Db,
  message: QueueMessage,
  code: string,
  ref?: QueueEnvelope,
  now: Date = new Date(),
): Promise<void> {
  await transaction(db, async (client) => {
    let trusted = false;
    if (ref) {
      const found = await client.query(
        "select 1 from app.events e join app.generations g on g.tenant_id=e.tenant_id and g.delivery_id=e.delivery_id and g.generation=$3 where e.tenant_id=$1 and e.delivery_id=$2 and e.business_sha256=$4",
        [ref.tenantId, ref.deliveryId, ref.generation, ref.businessSha256],
      );
      trusted = !!found.rowCount;
      if (!trusted) code = "invalid_reference";
    }
    await client.query(
      "insert into app.quarantine(id,message_id,body_sha256,code,tenant_id,delivery_id,generation) values($1,$2,$3,$4,$5,$6,$7) on conflict(message_id,body_sha256) do nothing",
      [
        randomUUID(),
        message.messageId.slice(0, 128),
        sha256(message.body),
        code,
        trusted ? ref!.tenantId : null,
        trusted ? ref!.deliveryId : null,
        trusted ? ref!.generation : null,
      ],
    );
    if (trusted && ref)
      await failGeneration(client, ref, "delivery_unconfirmed", now);
  });
}
