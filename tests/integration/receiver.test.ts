import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startReceiver } from "../../src/receiver/server.js";
import { seedReceiverCredentials } from "../../src/receiver/store.js";
import { openDb } from "../../src/db/connect.js";
import { fixture } from "../support/fixture.js";
import {
  withDb,
  tenantA,
  tenantB,
  tokenA,
  tokenB,
} from "../support/database.js";
const integrationA = "integration-a-".padEnd(48, "a");
const integrationB = "integration-b-".padEnd(48, "b");
test("receiver receipts are atomic, tenant-scoped and independently authorised", () =>
  withDb(async (db, info) => {
    await seedReceiverCredentials(db, [
      { ...tenantA, token: integrationA, purpose: "integration" },
      { ...tenantB, token: integrationB, purpose: "integration" },
      { ...tenantA, token: tokenA, purpose: "operator" },
    ]);
    const receiverDb = openDb(info.receiverUrl);
    const receiver = await startReceiver({
      db: receiverDb,
      host: "127.0.0.1",
      port: 0,
      demoMode: true,
    });
    const id = randomUUID();
    const send = (
      token = integrationA,
      deliveryId = id,
      body: unknown = fixture(),
    ) =>
      fetch(receiver.origin + "/sales", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-delivery-id": deliveryId,
        },
        body: JSON.stringify(body),
      });
    try {
      const [a, b] = await Promise.all([send(), send()]);
      assert.equal(a.status, 200);
      assert.deepEqual(await a.json(), await b.json());
      assert.equal(
        (await db.pool.query("select count(*)::int n from receiver.sales"))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await db.pool.query("select count(*)::int n from receiver.receipts"))
          .rows[0].n,
        1,
      );
      assert.equal((await send(integrationB, randomUUID())).status, 200);
      assert.equal((await send(tokenA)).status, 403);
      assert.equal((await send("wrong")).status, 401);
      assert.equal((await send(integrationA, randomUUID())).status, 409);
      assert.equal(
        (await send(integrationA, id, fixture({ saleReference: "OTHER-SALE" })))
          .status,
        409,
      );
      assert.equal(
        (
          await send(
            integrationA,
            id,
            fixture({
              total: "1",
              lines: [{ sku: "A", quantity: 1, unitAmount: "1" }],
            }),
          )
        ).status,
        409,
      );
      const app = openDb(info.appUrl);
      try {
        await assert.rejects(
          () =>
            app.pool.query("insert into receiver.sales(tenant_id) values($1)", [
              tenantA.tenantId,
            ]),
          { code: "42501" },
        );
        await assert.rejects(
          () => receiverDb.pool.query("select * from app.events"),
          { code: "42501" },
        );
      } finally {
        await app.close();
      }
    } finally {
      await receiver.close();
      await receiverDb.close();
    }
  }));
test("receiver commit and one-shot dropped reply survive receiver restart", () =>
  withDb(async (db, info) => {
    await seedReceiverCredentials(db, [
      { ...tenantA, token: integrationA, purpose: "integration" },
      { ...tenantA, token: tokenA, purpose: "operator" },
    ]);
    const receiverDb = openDb(info.receiverUrl);
    let receiver = await startReceiver({
      db: receiverDb,
      host: "127.0.0.1",
      port: 0,
      demoMode: true,
    });
    const id = randomUUID();
    const send = () =>
      fetch(receiver.origin + "/sales", {
        method: "POST",
        headers: {
          authorization: "Bearer " + integrationA,
          "content-type": "application/json",
          "x-delivery-id": id,
        },
        body: JSON.stringify(fixture()),
      });
    const fault = (mode: string, token = tokenA) =>
      fetch(receiver.origin + "/demo/faults/SALE-0001", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode }),
      });
    try {
      assert.equal((await fault("commit_drop_once", integrationA)).status, 403);
      assert.equal((await fault("commit_drop_once")).status, 200);
      await assert.rejects(send);
      assert.equal(
        (await db.pool.query("select count(*)::int n from receiver.sales"))
          .rows[0].n,
        1,
      );
      await receiver.close();
      receiver = await startReceiver({
        db: receiverDb,
        host: "127.0.0.1",
        port: 0,
        demoMode: true,
      });
      const retry = await send();
      assert.equal(retry.status, 200);
      assert.deepEqual(Object.keys((await retry.json()) as object).sort(), [
        "businessSha256",
        "deliveryId",
        "saleReference",
        "total",
      ]);
      assert.equal(
        (await db.pool.query("select count(*)::int n from receiver.sales"))
          .rows[0].n,
        1,
      );
      await receiver.close();
      receiver = await startReceiver({
        db: receiverDb,
        host: "127.0.0.1",
        port: 0,
        demoMode: false,
      });
      assert.equal((await fault("reject_422")).status, 404);
    } finally {
      await receiver.close();
      await receiverDb.close();
    }
  }));
test("transient fault is consumed once and permanent rejection persists until cleared", () =>
  withDb(async (db, info) => {
    await seedReceiverCredentials(db, [
      { ...tenantA, token: integrationA, purpose: "integration" },
      { ...tenantA, token: tokenA, purpose: "operator" },
      { ...tenantB, token: tokenB, purpose: "operator" },
    ]);
    const rd = openDb(info.receiverUrl);
    const server = await startReceiver({
      db: rd,
      host: "127.0.0.1",
      port: 0,
      demoMode: true,
    });
    const id = randomUUID();
    const send = () =>
      fetch(server.origin + "/sales", {
        method: "POST",
        headers: {
          authorization: "Bearer " + integrationA,
          "content-type": "application/json",
          "x-delivery-id": id,
        },
        body: JSON.stringify(fixture()),
      });
    const fault = (mode: string) =>
      fetch(server.origin + "/demo/faults/SALE-0001", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + tokenA,
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode }),
      });
    try {
      await fault("transient_503_once");
      assert.equal((await send()).status, 503);
      assert.equal((await send()).status, 200);
      await fault("reject_422");
      assert.equal((await send()).status, 422);
      assert.equal((await send()).status, 422);
      await fault("accept");
      assert.equal((await send()).status, 200);
    } finally {
      await server.close();
      await rd.close();
    }
  }));
