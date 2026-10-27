import test from "node:test";
import assert from "node:assert/strict";
import { acceptSale } from "../../src/db/accept.js";
import {
  getDelivery,
  getHistory,
  listDeliveries,
} from "../../src/db/deliveries.js";
import { authenticate, seedCredentials } from "../../src/db/credentials.js";
import { openDb } from "../../src/db/connect.js";
import { parseSale } from "../../src/domain/sale.js";
import { fixture } from "../support/fixture.js";
import {
  withDb,
  tenantA,
  tenantB,
  tokenA,
  tokenB,
} from "../support/database.js";

test("credential reuse cannot silently bind another tenant to an existing token", () =>
  withDb(async (db) => {
    await assert.rejects(
      () => seedCredentials(db, [{ ...tenantB, token: tokenA }]),
      {
        code: "credential_conflict",
      },
    );
    assert.equal((await authenticate(db, tokenA))?.tenantId, tenantA.tenantId);
  }));
test("tenant-scoped reads, histories and pooled reuse cannot cross tenant keys", () =>
  withDb(async (db, info) => {
    const app = openDb(info.appUrl);
    try {
      const a = await acceptSale(
        app,
        tenantA,
        parseSale(Buffer.from(JSON.stringify(fixture()))),
      );
      const b = await acceptSale(
        app,
        tenantB,
        parseSale(Buffer.from(JSON.stringify(fixture()))),
      );
      assert.notEqual(a.delivery.deliveryId, b.delivery.deliveryId);
      assert.equal(
        await getDelivery(app, tenantA, b.delivery.deliveryId),
        null,
      );
      assert.deepEqual(
        await getHistory(app, tenantA, b.delivery.deliveryId),
        [],
      );
      for (let i = 0; i < 3; i++) {
        assert.equal((await listDeliveries(app, tenantA, null, 100)).length, 1);
        assert.equal(
          (await listDeliveries(app, tenantB, null, 100))[0].tenantId,
          tenantB.tenantId,
        );
      }
      await assert.rejects(() => listDeliveries(app, tenantA, null, 101), {
        code: "invalid_pagination",
      });
      await assert.rejects(() => listDeliveries(app, tenantA, "invalid", 10), {
        code: "invalid_pagination",
      });
      assert.equal(
        (await authenticate(app, tokenA))?.tenantId,
        tenantA.tenantId,
      );
      assert.equal(
        (await authenticate(app, tokenB))?.tenantId,
        tenantB.tenantId,
      );
      assert.equal(await authenticate(app, "wrong"), null);
      await assert.rejects(
        () =>
          acceptSale(
            app,
            { ...tenantA, permissions: ["read"] },
            parseSale(Buffer.from(JSON.stringify(fixture()))),
          ),
        { code: "forbidden" },
      );
      await assert.rejects(
        () => app.pool.query("create table app.forbidden (x int)"),
        { code: "42501" },
      );
      await assert.rejects(
        () =>
          app.pool.query("update app.events set raw=$1", [
            Buffer.from("changed"),
          ]),
        { code: "42501" },
      );
    } finally {
      await app.close();
    }
  }));
