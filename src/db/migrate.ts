import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../domain/sale.js";
import { DomainError } from "../domain/errors.js";
import { transaction, type Db } from "./connect.js";
export async function provisionRoles(
  db: Db,
  passwords: { migrator: string; application: string; receiver: string },
): Promise<void> {
  for (const [name, password] of Object.entries({
    p14_migrator: passwords.migrator,
    p14_app: passwords.application,
    p14_receiver: passwords.receiver,
  })) {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(password))
      throw new DomainError("invalid_role_password", 400);
    const exists = await db.pool.query(
      "select 1 from pg_roles where rolname=$1",
      [name],
    );
    if (!exists.rowCount)
      await db.pool.query(
        `CREATE ROLE ${name} LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
      );
    else await db.pool.query(`ALTER ROLE ${name} PASSWORD '${password}'`);
  }
  const { rows } = await db.pool.query(
    "select current_user u,current_database() d",
  );
  const quote = (x: string) => '"' + x.replaceAll('"', '""') + '"';
  if (rows[0].u !== "p14_migrator")
    await db.pool.query(`GRANT p14_migrator TO ${quote(rows[0].u)}`);
  await db.pool.query(
    `GRANT CREATE, CONNECT ON DATABASE ${quote(rows[0].d)} TO p14_migrator`,
  );
  await db.pool.query(
    `GRANT CONNECT ON DATABASE ${quote(rows[0].d)} TO p14_app, p14_receiver`,
  );
}
export async function migrate(
  db: Db,
  options: { directory?: string; through?: string } = {},
): Promise<void> {
  const directory = options.directory ?? path.resolve("migrations");
  const files = (await readdir(directory))
    .filter((x) => /^\d{3}_[a-z_]+\.sql$/.test(x))
    .sort();
  await transaction(db, async (client) => {
    await client.query("SET LOCAL ROLE p14_migrator");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('p14-migrations',0))",
    );
    await client.query(
      "CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION p14_migrator",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS app.schema_migrations (name text primary key, sha256 char(64) not null, applied_at timestamptz not null default now())",
    );
    for (const file of files) {
      if (options.through && file > options.through) break;
      const sql = await readFile(path.join(directory, file), "utf8");
      const digest = sha256(sql);
      const previous = await client.query(
        "select sha256 from app.schema_migrations where name=$1",
        [file],
      );
      if (previous.rowCount) {
        if (previous.rows[0].sha256 !== digest)
          throw new DomainError("migration_changed", 500);
        continue;
      }
      await client.query(sql);
      await client.query(
        "insert into app.schema_migrations(name,sha256) values ($1,$2)",
        [file, digest],
      );
    }
  });
}
