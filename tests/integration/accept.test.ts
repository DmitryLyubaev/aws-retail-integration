import test from "node:test";
import assert from "node:assert/strict";
import { acceptSale } from "../../src/db/accept.js";
import { parseSale } from "../../src/domain/sale.js";
import { openDb } from "../../src/db/connect.js";
import { withDb, tenantA } from "../support/database.js";
import { fixture } from "../support/fixture.js";
const event = (overrides: Record<string, unknown> = {}) =>
  parseSale(Buffer.from(JSON.stringify(fixture(overrides))));
test("concurrent equal submissions retain one identity and one transactional outbox", () =>
  withDb(async (db, info) => {
    const app = openDb(info.appUrl);
    try {
      const [a, b] = await Promise.all([
        acceptSale(app, tenantA, event()),
        acceptSale(app, tenantA, event()),
      ]);
      assert.equal(a.delivery.deliveryId, b.delivery.deliveryId);
      assert.equal(Number(a.duplicate) + Number(b.duplicate), 1);
      for (const table of ["events", "event_aliases", "generations", "outbox"])
        assert.equal(
          (await db.pool.query(`select count(*)::int n from app.${table}`))
            .rows[0].n,
          1,
        );
      assert.deepEqual(
        (await db.pool.query("select raw from app.events")).rows[0].raw,
        event().raw,
      );
      assert.equal(
        (
          await db.pool.query(
            "select extract(epoch from deadline_at-created_at)::int n from app.generations",
          )
        ).rows[0].n,
        300,
      );
    } finally {
      await app.close();
    }
  }));
test("aliases are retained and content conflicts do not mutate the first sale", () =>
  withDb(async (db) => {
    const original = await acceptSale(db, tenantA, event());
    const alias = await acceptSale(db, tenantA, event({ eventId: "alias-2" }));
    assert.equal(alias.delivery.deliveryId, original.delivery.deliveryId);
    assert.equal(alias.duplicate, true);
    await assert.rejects(
      () =>
        acceptSale(
          db,
          tenantA,
          event({ eventId: "alias-2", saleReference: "another" }),
        ),
      { code: "conflict" },
    );
    await assert.rejects(
      () =>
        acceptSale(
          db,
          tenantA,
          event({
            lines: [{ sku: "A", quantity: 1, unitAmount: "1" }],
            total: "1",
          }),
        ),
      { code: "conflict" },
    );
    assert.equal(
      (await db.pool.query("select count(*)::int n from app.events")).rows[0].n,
      1,
    );
    assert.equal(
      (await db.pool.query("select count(*)::int n from app.event_aliases"))
        .rows[0].n,
      2,
    );
  }));
test("a competing alias association cannot leave an orphan accepted sale", () =>
  withDb(async (db) => {
    await acceptSale(db, tenantA, event());
    const results = await Promise.allSettled([
      acceptSale(db, tenantA, event({ eventId: "racing-alias" })),
      acceptSale(
        db,
        tenantA,
        event({ eventId: "racing-alias", saleReference: "SALE-2" }),
      ),
    ]);
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(results.filter((x) => x.status === "rejected").length, 1);
    const orphans = await db.pool.query(
      "select count(*)::int n from app.events e where not exists(select 1 from app.event_aliases a where a.tenant_id=e.tenant_id and a.delivery_id=e.delivery_id)",
    );
    assert.equal(orphans.rows[0].n, 0);
  }));
test("a rejected alias rolls back every new work row", () =>
  withDb(async (db) => {
    await acceptSale(db, tenantA, event());
    await assert.rejects(
      () => acceptSale(db, tenantA, event({ saleReference: "SALE-2" })),
      { code: "conflict" },
    );
    for (const table of [
      "events",
      "event_aliases",
      "generations",
      "outbox",
      "audit",
    ])
      assert.equal(
        (await db.pool.query(`select count(*)::int n from app.${table}`))
          .rows[0].n,
        1,
      );
  }));
