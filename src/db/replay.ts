import { randomUUID } from "node:crypto";
import type { TenantContext, DeliveryView } from "../domain/delivery.js";
import { DomainError } from "../domain/errors.js";
import { transaction, type Db } from "./connect.js";
import { requirePermission } from "./credentials.js";
import { deliveryView, uuidPattern } from "./deliveries.js";
export async function replayDelivery(
  db: Db,
  ctx: TenantContext,
  id: string,
  expectedGeneration: number,
  requestId: string,
): Promise<DeliveryView> {
  requirePermission(ctx, "replay");
  if (!uuidPattern.test(id)) throw new DomainError("not_found", 404);
  if (
    !Number.isInteger(expectedGeneration) ||
    expectedGeneration < 1 ||
    expectedGeneration >= 2147483647 ||
    typeof requestId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(requestId)
  )
    throw new DomainError("invalid_replay", 400);
  try {
    return await transaction(db, async (client) => {
      const args = [ctx.tenantId, id];
      const event = (
        await client.query(
          "select current_generation,sale_reference from app.events where tenant_id=$1 and delivery_id=$2 for update",
          args,
        )
      ).rows[0];
      if (!event) throw new DomainError("not_found", 404);
      const prior = (
        await client.query(
          "select * from app.replay_requests where tenant_id=$1 and request_id=$2",
          [ctx.tenantId, requestId],
        )
      ).rows[0];
      let generation: number;
      if (prior) {
        if (
          prior.delivery_id !== id ||
          prior.expected_generation !== expectedGeneration
        )
          throw new DomainError("replay_conflict", 409);
        generation = prior.result_generation;
      } else {
        const g = (
          await client.query(
            "select state from app.generations where tenant_id=$1 and delivery_id=$2 and generation=$3 for update",
            [...args, event.current_generation],
          )
        ).rows[0];
        if (
          event.current_generation !== expectedGeneration ||
          g.state !== "failed"
        )
          throw new DomainError("replay_conflict", 409);
        generation = expectedGeneration + 1;
        await client.query(
          "insert into app.generations(tenant_id,delivery_id,generation) values($1,$2,$3)",
          [...args, generation],
        );
        await client.query(
          "insert into app.outbox(id,tenant_id,delivery_id,generation) values($1,$2,$3,$4)",
          [randomUUID(), ...args, generation],
        );
        await client.query(
          "insert into app.replay_requests(tenant_id,request_id,delivery_id,expected_generation,result_generation) values($1,$2,$3,$4,$5)",
          [ctx.tenantId, requestId, id, expectedGeneration, generation],
        );
        await client.query(
          "update app.events set current_generation=$3 where tenant_id=$1 and delivery_id=$2",
          [...args, generation],
        );
        await client.query(
          "insert into app.audit(tenant_id,delivery_id,generation,kind,event_key) values($1,$2,$3,'replayed','replayed')",
          [...args, generation],
        );
      }
      const row = (
        await client.query(
          "select g.* from app.generations g where tenant_id=$1 and delivery_id=$2 and generation=$3",
          [...args, generation],
        )
      ).rows[0];
      return deliveryView({ ...row, sale_reference: event.sale_reference });
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505")
      throw new DomainError("replay_conflict", 409);
    throw e;
  }
}
