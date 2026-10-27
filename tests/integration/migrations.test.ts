import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/connect.js";
import { acceptSale } from "../../src/db/accept.js";
import { seedCredentials } from "../../src/db/credentials.js";
import { parseSale } from "../../src/domain/sale.js";
import { fixture } from "../support/fixture.js";
import { withDb, tenantA, tokenA } from "../support/database.js";
test("migrations are repeatable, upgrade populated core and runtime cannot migrate", () =>
  withDb(
    async (db, info) => {
      await migrate(db, { through: "001_core.sql" });
      await db.pool.query("insert into app.tenants values ('retailer-a')");
      const sale = await acceptSale(
        db,
        tenantA,
        parseSale(Buffer.from(JSON.stringify(fixture()))),
      );
      await migrate(db, { through: "002_credentials.sql" });
      await migrate(db, { through: "002_credentials.sql" });
      await seedCredentials(db, [{ ...tenantA, token: tokenA }]);
      assert.equal(
        (
          await db.pool.query(
            "select raw_sha256 from app.events where delivery_id=$1",
            [sale.delivery.deliveryId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await db.pool.query(
            "select count(*)::int n from app.schema_migrations",
          )
        ).rows[0].n,
        2,
      );
      const app = openDb(info.appUrl);
      try {
        await assert.rejects(() => migrate(app));
      } finally {
        await app.close();
      }
    },
    { migrations: false },
  ));
