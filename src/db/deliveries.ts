import type { PoolClient } from "pg";
import type {
  TenantContext,
  DeliveryView,
  AuditEntry,
} from "../domain/delivery.js";
import { DomainError } from "../domain/errors.js";
import type { Db } from "./connect.js";
import { requirePermission } from "./credentials.js";
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const projection =
  "select e.tenant_id,e.delivery_id,e.sale_reference,g.generation,g.state,g.failure_code,g.attempts,g.deadline_at from app.events e join app.generations g on (g.tenant_id=e.tenant_id and g.delivery_id=e.delivery_id and g.generation=e.current_generation)";
export function deliveryView(row: Record<string, any>): DeliveryView {
  return {
    tenantId: row.tenant_id,
    deliveryId: row.delivery_id,
    saleReference: row.sale_reference,
    generation: row.generation,
    state: row.state,
    failureCode: row.failure_code,
    attempts: row.attempts,
    deadlineAt: row.deadline_at.toISOString(),
  };
}
export async function projectDelivery(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<DeliveryView> {
  const { rows } = await client.query(
    projection + " where e.tenant_id=$1 and e.delivery_id=$2",
    [tenantId, id],
  );
  if (!rows[0]) throw new DomainError("not_found", 404);
  return deliveryView(rows[0]);
}
export async function getDelivery(
  db: Db,
  ctx: TenantContext,
  id: string,
): Promise<DeliveryView | null> {
  requirePermission(ctx, "read");
  if (!uuidPattern.test(id)) return null;
  const { rows } = await db.pool.query(
    projection + " where e.tenant_id=$1 and e.delivery_id=$2",
    [ctx.tenantId, id],
  );
  return rows[0] ? deliveryView(rows[0]) : null;
}
export async function listDeliveries(
  db: Db,
  ctx: TenantContext,
  after: string | null,
  limit: number,
): Promise<DeliveryView[]> {
  requirePermission(ctx, "read");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (after !== null && !uuidPattern.test(after))
  )
    throw new DomainError("invalid_pagination", 400);
  const { rows } = await db.pool.query(
    projection +
      " where e.tenant_id=$1 and ($2::uuid is null or e.delivery_id>$2::uuid) order by e.delivery_id limit $3",
    [ctx.tenantId, after, limit],
  );
  return rows.map(deliveryView);
}
export async function getHistory(
  db: Db,
  ctx: TenantContext,
  id: string,
): Promise<readonly AuditEntry[]> {
  requirePermission(ctx, "read");
  if (!uuidPattern.test(id)) return [];
  const { rows } = await db.pool.query(
    "select id,at,generation,kind,code,attempt_id from app.audit where tenant_id=$1 and delivery_id=$2 order by id",
    [ctx.tenantId, id],
  );
  return rows.map((r) => ({
    id: String(r.id),
    at: r.at.toISOString(),
    generation: r.generation,
    kind: r.kind,
    code: r.code,
    attemptId: r.attempt_id,
  }));
}
