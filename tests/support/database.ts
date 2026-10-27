import { randomUUID } from "node:crypto";
import { openDb, type Db } from "../../src/db/connect.js";
import { migrate, provisionRoles } from "../../src/db/migrate.js";
import { seedCredentials } from "../../src/db/credentials.js";
import type { TenantContext } from "../../src/domain/delivery.js";
export const tenantA: TenantContext = {
  tenantId: "retailer-a",
  actorId: "operator-a",
  permissions: ["submit", "read", "replay", "fault"],
};
export const tenantB: TenantContext = {
  tenantId: "retailer-b",
  actorId: "operator-b",
  permissions: ["submit", "read", "replay", "fault"],
};
export const tokenA = "synthetic-a-".padEnd(48, "a");
export const tokenB = "synthetic-b-".padEnd(48, "b");
export const localPassword = "local-test-synthetic-password";
export async function withDb<T>(
  run: (
    db: Db,
    info: {
      url: string;
      appUrl: string;
      receiverUrl: string;
      migratorUrl: string;
    },
  ) => Promise<T>,
  options: { migrations?: boolean } = {},
): Promise<T> {
  const source = process.env.TEST_DATABASE_URL;
  if (!source) throw new Error("Compose database required");
  const admin = openDb(source);
  const name = "p14t_" + randomUUID().replaceAll("-", "");
  await admin.pool.query(`create database "${name}"`);
  const url = new URL(source);
  url.pathname = "/" + name;
  const db = openDb(url.href);
  try {
    await provisionRoles(db, {
      migrator: localPassword,
      application: localPassword,
      receiver: localPassword,
    });
    if (options.migrations !== false) {
      await migrate(db);
      await seedCredentials(db, [
        { ...tenantA, token: tokenA },
        { ...tenantB, token: tokenB },
      ]);
    }
    const roleUrl = (role: string) => {
      const v = new URL(url);
      v.username = role;
      v.password = localPassword;
      return v.href;
    };
    return await run(db, {
      url: url.href,
      appUrl: roleUrl("p14_app"),
      receiverUrl: roleUrl("p14_receiver"),
      migratorUrl: roleUrl("p14_migrator"),
    });
  } finally {
    await db.close();
    await admin.pool.query(`drop database "${name}" with (force)`);
    await admin.close();
  }
}
