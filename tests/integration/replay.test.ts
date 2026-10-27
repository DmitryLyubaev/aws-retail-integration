import test from "node:test";
import assert from "node:assert/strict";
import { withDb, tenantA, tenantB } from "../support/database.js";
import { acceptSale } from "../../src/db/accept.js";
import { replayDelivery } from "../../src/db/replay.js";
import { parseSale } from "../../src/domain/sale.js";
import { fixture } from "../support/fixture.js";
test("repeated operator replay creates one next generation and preserves original bytes", () =>
  withDb(async (db) => {
    const raw = Buffer.from(JSON.stringify(fixture()));
    const { delivery } = await acceptSale(db, tenantA, parseSale(raw));
    const id = delivery.deliveryId;
    await db.pool.query(
      "update app.generations set state='failed',failure_code='receiver_http_422'",
    );
    const [a, b] = await Promise.all([
      replayDelivery(db, tenantA, id, 1, "replay-one"),
      replayDelivery(db, tenantA, id, 1, "replay-one"),
    ]);
    assert.equal(a.generation, 2);
    assert.equal(b.generation, 2);
    assert.equal(
      (
        await db.pool.query(
          "select count(*)::int n from app.outbox where generation=2",
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(
      (await db.pool.query("select raw from app.events")).rows[0].raw,
      raw,
    );
    for (const [ctx, g, r, code] of [
      [tenantA, 1, "another", "replay_conflict"],
      [tenantA, 2, "replay-one", "replay_conflict"],
      [tenantB, 1, "other", "not_found"],
    ] as const)
      await assert.rejects(replayDelivery(db, ctx, id, g, r), { code });
    await db.pool.query(
      "update app.generations set state='delivered' where generation=2",
    );
    await assert.rejects(replayDelivery(db, tenantA, id, 2, "delivered"), {
      code: "replay_conflict",
    });
  }));
test("competing distinct replay requests cannot create two new generations", () =>
  withDb(async (db) => {
    const { delivery } = await acceptSale(
      db,
      tenantA,
      parseSale(Buffer.from(JSON.stringify(fixture()))),
    );
    await db.pool.query("update app.generations set state='failed'");
    const results = await Promise.allSettled(
      ["race-a", "race-b"].map((r) =>
        replayDelivery(db, tenantA, delivery.deliveryId, 1, r),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (await db.pool.query("select count(*)::int n from app.generations"))
        .rows[0].n,
      2,
    );
  }));
