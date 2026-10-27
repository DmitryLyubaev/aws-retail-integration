import type { TenantContext, ReceiverReceipt } from "../domain/delivery.js";
import { type AcceptedSale, sha256 } from "../domain/sale.js";
import { DomainError } from "../domain/errors.js";
import { requirePermission } from "../db/credentials.js";
import { transaction, type Db } from "../db/connect.js";
export type ReceiverResult =
  | { kind: "success"; receipt: ReceiverReceipt; dropResponse: boolean }
  | { kind: "refusal"; status: 422 | 503; code: string };
export async function seedReceiverCredentials(
  db: Db,
  credentials: readonly (TenantContext & {
    token: string;
    purpose: "integration" | "operator";
  })[],
): Promise<void> {
  await transaction(db, async (client) => {
    for (const item of credentials) {
      if (item.token.length < 32 || item.token.length > 256)
        throw new DomainError("invalid_credential", 400);
      await client.query(
        "insert into receiver.tenants values($1) on conflict do nothing",
        [item.tenantId],
      );
      const result = await client.query(
        "insert into receiver.credentials(token_sha256,tenant_id,actor_id,purpose) values($1,$2,$3,$4) on conflict(token_sha256) do update set actor_id=excluded.actor_id where receiver.credentials.tenant_id=excluded.tenant_id and receiver.credentials.actor_id=excluded.actor_id and receiver.credentials.purpose=excluded.purpose returning token_sha256",
        [sha256(item.token), item.tenantId, item.actorId, item.purpose],
      );
      if (!result.rowCount) throw new DomainError("credential_conflict", 409);
    }
  });
}
export async function authenticateReceiver(
  db: Db,
  token: string,
  purpose: "integration" | "operator",
): Promise<TenantContext> {
  if (token.length < 32 || token.length > 256)
    throw new DomainError("unauthorised", 401);
  const { rows } = await db.pool.query(
    "select tenant_id,actor_id,purpose from receiver.credentials where token_sha256=$1",
    [sha256(token)],
  );
  if (!rows[0]) throw new DomainError("unauthorised", 401);
  if (rows[0].purpose !== purpose) throw new DomainError("forbidden", 403);
  return {
    tenantId: rows[0].tenant_id,
    actorId: rows[0].actor_id,
    permissions: purpose === "integration" ? ["submit"] : ["fault"],
  };
}
export async function recordSale(
  db: Db,
  ctx: TenantContext,
  deliveryId: string,
  event: AcceptedSale,
): Promise<ReceiverResult> {
  requirePermission(ctx, "submit");
  return transaction(db, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(["receiver", ctx.tenantId, event.sale.saleReference]),
    ]);
    const fault = (
      await client.query(
        "select mode,used from receiver.faults where tenant_id=$1 and sale_reference=$2 for update",
        [ctx.tenantId, event.sale.saleReference],
      )
    ).rows[0];
    if (fault?.mode === "reject_422")
      return { kind: "refusal", status: 422, code: "receiver_rejected" };
    const first = fault && !fault.used;
    if (
      first &&
      (fault.mode === "transient_503_once" || fault.mode === "commit_drop_once")
    )
      await client.query(
        "update receiver.faults set used=true where tenant_id=$1 and sale_reference=$2",
        [ctx.tenantId, event.sale.saleReference],
      );
    if (first && fault.mode === "transient_503_once")
      return { kind: "refusal", status: 503, code: "receiver_transient" };
    await client.query(
      "insert into receiver.sales(tenant_id,sale_reference,delivery_id,business_sha256,total,sale) values($1,$2,$3,$4,$5,$6) on conflict do nothing",
      [
        ctx.tenantId,
        event.sale.saleReference,
        deliveryId,
        event.businessSha256,
        event.sale.total,
        event.sale,
      ],
    );
    const stored = (
      await client.query(
        "select delivery_id,business_sha256,total from receiver.sales where tenant_id=$1 and sale_reference=$2",
        [ctx.tenantId, event.sale.saleReference],
      )
    ).rows[0];
    if (
      !stored ||
      stored.delivery_id !== deliveryId ||
      stored.business_sha256 !== event.businessSha256 ||
      stored.total !== event.sale.total
    )
      throw new DomainError("conflict", 409);
    const receipt: ReceiverReceipt = {
      deliveryId,
      saleReference: event.sale.saleReference,
      businessSha256: stored.business_sha256,
      total: stored.total,
    };
    await client.query(
      "insert into receiver.receipts(tenant_id,sale_reference,receipt) values($1,$2,$3) on conflict do nothing",
      [ctx.tenantId, event.sale.saleReference, receipt],
    );
    const original = (
      await client.query(
        "select receipt from receiver.receipts where tenant_id=$1 and sale_reference=$2",
        [ctx.tenantId, event.sale.saleReference],
      )
    ).rows[0].receipt;
    return {
      kind: "success",
      receipt: original,
      dropResponse: !!(first && fault.mode === "commit_drop_once"),
    };
  });
}
