import { randomUUID } from "node:crypto";
import type { QueueEnvelope } from "../domain/delivery.js";
import { transaction, type Db } from "./connect.js";
import { failGeneration } from "./attempts.js";
export interface OutboxClaim {
  id: string;
  fence: string;
  leaseUntil: Date;
  deadlineAt: Date;
  envelope: QueueEnvelope;
}
export async function claimOutbox(db: Db, now: Date): Promise<OutboxClaim[]> {
  return transaction(db, async (client) => {
    const expired = await client.query(
      "select tenant_id,delivery_id,generation,attempts from app.generations where state not in ('delivered','failed') and deadline_at<=$1 for update skip locked",
      [now],
    );
    for (const row of expired.rows)
      await failGeneration(
        client,
        {
          tenantId: row.tenant_id,
          deliveryId: row.delivery_id,
          generation: row.generation,
        },
        row.attempts > 0 ? "delivery_unconfirmed" : "deadline_exceeded",
        now,
      );
    await client.query(
      "update app.outbox o set state=case when g.state='delivered' then 'published' else 'failed' end,fence=null,lease_until=null from app.generations g where g.tenant_id=o.tenant_id and g.delivery_id=o.delivery_id and g.generation=o.generation and g.state in ('delivered','failed') and o.state in ('pending','publishing')",
    );
    const { rows } = await client.query(
      "select o.id,o.tenant_id,o.delivery_id,o.generation,e.business_sha256,g.deadline_at from app.outbox o join app.events e on e.tenant_id=o.tenant_id and e.delivery_id=o.delivery_id and e.current_generation=o.generation join app.generations g on g.tenant_id=o.tenant_id and g.delivery_id=o.delivery_id and g.generation=o.generation where g.state not in ('delivered','failed') and g.deadline_at>$1 and o.next_attempt_at<=$1 and (o.state='pending' or (o.state='publishing' and o.lease_until<=$1)) order by o.next_attempt_at limit 10 for update of o skip locked",
      [now],
    );
    const claims: OutboxClaim[] = [];
    for (const row of rows) {
      const fence = randomUUID();
      await client.query(
        "update app.outbox set state='publishing',fence=$2,lease_until=$3::timestamptz+interval '30 seconds' where id=$1",
        [row.id, fence, now],
      );
      claims.push({
        id: row.id,
        fence,
        leaseUntil: new Date(now.getTime() + 30000),
        deadlineAt: row.deadline_at,
        envelope: {
          schemaVersion: 1,
          tenantId: row.tenant_id,
          deliveryId: row.delivery_id,
          generation: row.generation,
          businessSha256: row.business_sha256,
        },
      });
    }
    return claims;
  });
}
export async function completePublish(
  db: Db,
  claim: OutboxClaim,
  now: Date,
  success: boolean,
): Promise<boolean> {
  return transaction(db, async (client) => {
    if (success) {
      const result = await client.query(
        "update app.outbox set state='published',lease_until=null where id=$1 and fence=$2 and state='publishing' and lease_until>$3",
        [claim.id, claim.fence, now],
      );
      return !!result.rowCount;
    }
    const { rows } = await client.query(
      "update app.outbox set failures=failures+1,state=case when failures+1>=5 then 'failed' else 'pending' end,lease_until=null,fence=null,next_attempt_at=$3::timestamptz+interval '2 seconds' where id=$1 and fence=$2 and state='publishing' and lease_until>$3 returning failures,tenant_id,delivery_id,generation",
      [claim.id, claim.fence, now],
    );
    if (!rows[0]) return false;
    if (rows[0].failures === 5) {
      const ref = rows[0];
      await failGeneration(
        client,
        {
          tenantId: ref.tenant_id,
          deliveryId: ref.delivery_id,
          generation: ref.generation,
        },
        "queue_publish_failed",
        now,
      );
    }
    return true;
  });
}
