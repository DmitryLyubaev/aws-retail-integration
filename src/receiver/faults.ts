import type { TenantContext } from "../domain/delivery.js";
import { DomainError } from "../domain/errors.js";
import { requirePermission } from "../db/credentials.js";
import { type Db } from "../db/connect.js";
export type FaultMode =
  "accept" | "reject_422" | "transient_503_once" | "commit_drop_once";
export const faultModes: readonly FaultMode[] = [
  "accept",
  "reject_422",
  "transient_503_once",
  "commit_drop_once",
];
export async function setFault(
  db: Db,
  ctx: TenantContext,
  saleReference: string,
  mode: FaultMode,
): Promise<void> {
  requirePermission(ctx, "fault");
  if (
    !faultModes.includes(mode) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(saleReference)
  )
    throw new DomainError("invalid_fault", 400);
  await db.pool.query(
    "insert into receiver.faults(tenant_id,sale_reference,mode) values($1,$2,$3) on conflict(tenant_id,sale_reference) do update set mode=excluded.mode,used=false",
    [ctx.tenantId, saleReference, mode],
  );
}
