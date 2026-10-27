import { randomUUID } from "node:crypto";
import type { AcceptedSale } from "../domain/sale.js";
import type { TenantContext, Acceptance } from "../domain/delivery.js";
import { DomainError } from "../domain/errors.js";
import { transaction, type Db } from "./connect.js";
import { requirePermission } from "./credentials.js";
import { projectDelivery } from "./deliveries.js";
export async function acceptSale(
  db: Db,
  ctx: TenantContext,
  event: AcceptedSale,
): Promise<Acceptance> {
  requirePermission(ctx, "submit");
  try {
    return await transaction(db, async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [JSON.stringify([ctx.tenantId, event.sale.saleReference])],
      );
      const { rows } = await client.query(
        "select delivery_id,business_sha256 from app.events where tenant_id=$1 and sale_reference=$2",
        [ctx.tenantId, event.sale.saleReference],
      );
      const duplicate = !!rows[0];
      if (duplicate && rows[0].business_sha256 !== event.businessSha256)
        throw new DomainError("conflict", 409);
      const id = rows[0]?.delivery_id ?? randomUUID();
      if (!duplicate) {
        await client.query(
          "insert into app.events(tenant_id,delivery_id,sale_reference,raw,raw_sha256,canonical,business_sha256,sale) values($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            ctx.tenantId,
            id,
            event.sale.saleReference,
            event.raw,
            event.rawSha256,
            event.canonical,
            event.businessSha256,
            event.sale,
          ],
        );
        await client.query(
          "insert into app.generations(tenant_id,delivery_id,generation) values($1,$2,1)",
          [ctx.tenantId, id],
        );
        await client.query(
          "insert into app.outbox(id,tenant_id,delivery_id,generation) values($1,$2,$3,1)",
          [randomUUID(), ctx.tenantId, id],
        );
        await client.query(
          "insert into app.audit(tenant_id,delivery_id,generation,kind,event_key) values($1,$2,1,'accepted','accepted')",
          [ctx.tenantId, id],
        );
      }
      await client.query(
        "insert into app.event_aliases(tenant_id,event_id,delivery_id) values($1,$2,$3) on conflict do nothing",
        [ctx.tenantId, event.sale.eventId, id],
      );
      const alias = await client.query(
        "select delivery_id from app.event_aliases where tenant_id=$1 and event_id=$2",
        [ctx.tenantId, event.sale.eventId],
      );
      if (alias.rows[0]?.delivery_id !== id)
        throw new DomainError("conflict", 409);
      return {
        delivery: await projectDelivery(client, ctx.tenantId, id),
        duplicate,
      };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new DomainError("conflict", 409);
    throw error;
  }
}
