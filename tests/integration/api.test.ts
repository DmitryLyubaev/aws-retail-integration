import test from "node:test";
import assert from "node:assert/strict";
import { startApi } from "../../src/api/server.js";
import { withWorker } from "../support/worker.js";
import { tokenA, tokenB, tenantA } from "../support/database.js";
import { seedCredentials } from "../../src/db/credentials.js";
import { fixture } from "../support/fixture.js";
test("API authenticates tenant context, validates exact input and commits before returning 202", () =>
  withWorker(async (deps, admin) => {
    const api = await startApi({
      db: deps.db,
      host: "127.0.0.1",
      port: 0,
      demoMode: true,
      receiverOrigin: deps.receiverOrigin,
    });
    const call = (
      path: string,
      token = tokenA,
      body?: string,
      method = body ? "POST" : "GET",
    ) =>
      fetch(api.origin + path, {
        method,
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "x-tenant-id": "retailer-b",
        },
        body,
      });
    try {
      assert.equal(
        (await call("/v1/sales", "bad", JSON.stringify(fixture()))).status,
        401,
      );
      for (const raw of [
        "{",
        JSON.stringify({ ...fixture(), tenantId: "retailer-b" }),
        JSON.stringify({ ...fixture(), schemaVersion: "1" }),
      ])
        assert.equal((await call("/v1/sales", tokenA, raw)).status, 400);
      assert.equal(
        (await call("/v1/sales", tokenA, " ".repeat(65537))).status,
        413,
      );
      const first = await call("/v1/sales", tokenA, JSON.stringify(fixture()));
      assert.equal(first.status, 202);
      const sale: any = await first.json();
      const id = sale.delivery.deliveryId;
      assert.equal(
        (await admin.pool.query("select count(*)::int n from app.outbox"))
          .rows[0].n,
        1,
      );
      const duplicate = await call(
        "/v1/sales",
        tokenA,
        JSON.stringify(fixture()),
      );
      assert.equal(duplicate.status, 200);
      assert.equal(((await duplicate.json()) as any).delivery.deliveryId, id);
      assert.equal((await call("/v1/deliveries/" + id, tokenB)).status, 404);
      assert.equal(
        (await call("/v1/deliveries/" + id + "/history", tokenB)).status,
        404,
      );
      assert.equal(
        (
          await call(
            "/v1/deliveries/" + id + "/replay",
            tokenB,
            JSON.stringify({ expectedGeneration: 1, requestId: "r1" }),
          )
        ).status,
        404,
      );
      const submit = "submit-only".padEnd(48, "x");
      await seedCredentials(admin, [
        {
          ...tenantA,
          actorId: "submit",
          permissions: ["submit"],
          token: submit,
        },
      ]);
      assert.equal(
        (
          await call(
            "/v1/deliveries/" + id + "/replay",
            submit,
            JSON.stringify({ expectedGeneration: 1, requestId: "r1" }),
          )
        ).status,
        403,
      );
      assert.equal((await call("/v1/deliveries?limit=1")).status, 200);
      assert.equal(
        (await call("/v1/deliveries?tenantId=retailer-b")).status,
        400,
      );
      assert.equal(
        (
          await call(
            "/v1/demo/faults/SALE-0001",
            tokenA,
            JSON.stringify({ mode: "transient_503_once" }),
            "PUT",
          )
        ).status,
        200,
      );
    } finally {
      await api.close();
    }
  }));
test("API contains unhandled driver errors without exposing credentials", async () => {
  const secret = "postgres://user:secret@host/db";
  const db = {
    pool: {
      query: async () => {
        throw new Error(secret);
      },
    },
  } as any;
  const api = await startApi({
    db,
    host: "127.0.0.1",
    port: 0,
    demoMode: false,
    receiverOrigin: "http://127.0.0.1:1",
  });
  try {
    const r = await fetch(api.origin + "/v1/deliveries", {
      headers: { authorization: "Bearer " + "x".repeat(48) },
    });
    assert.equal(r.status, 500);
    const body = await r.text();
    assert.match(body, /internal_error/);
    assert.ok(!body.includes(secret));
  } finally {
    await api.close();
  }
});
