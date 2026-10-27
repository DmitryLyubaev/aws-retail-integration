import type { TenantContext, Permission } from "../domain/delivery.js";
import { sha256 } from "../domain/sale.js";
import { DomainError } from "../domain/errors.js";
import { transaction, type Db } from "./connect.js";
export function requirePermission(
  ctx: TenantContext,
  permission: Permission,
): void {
  if (!ctx.tenantId || !ctx.permissions.includes(permission))
    throw new DomainError("forbidden", 403);
}
export async function seedCredentials(
  db: Db,
  credentials: readonly (TenantContext & { token: string })[],
): Promise<void> {
  await transaction(db, async (client) => {
    for (const item of credentials) {
      if (item.token.length < 32)
        throw new DomainError("invalid_credential", 400);
      await client.query(
        "insert into app.tenants values($1) on conflict do nothing",
        [item.tenantId],
      );
      const stored = await client.query(
        "insert into app.credentials(token_sha256,tenant_id,actor_id,permissions) values($1,$2,$3,$4) on conflict(token_sha256) do update set enabled=true,permissions=excluded.permissions where app.credentials.tenant_id=excluded.tenant_id and app.credentials.actor_id=excluded.actor_id returning token_sha256",
        [sha256(item.token), item.tenantId, item.actorId, item.permissions],
      );
      if (!stored.rowCount) throw new DomainError("credential_conflict", 409);
    }
  });
}
export async function authenticate(
  db: Db,
  token: string,
): Promise<TenantContext | null> {
  if (token.length < 32 || token.length > 256) return null;
  const { rows } = await db.pool.query(
    "select tenant_id,actor_id,permissions from app.credentials where token_sha256=$1 and enabled",
    [sha256(token)],
  );
  if (!rows[0]) return null;
  return {
    tenantId: rows[0].tenant_id,
    actorId: rows[0].actor_id,
    permissions: rows[0].permissions,
  };
}
