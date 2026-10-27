import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { withWorker } from "../support/worker.js";
import { tenantA } from "../support/database.js";
import { fixture } from "../support/fixture.js";
import { parseSale } from "../../src/domain/sale.js";
import { acceptSale } from "../../src/db/accept.js";
import { getDelivery } from "../../src/db/deliveries.js";
import { publishOnce } from "../../src/worker/publisher.js";
import { consumeOnce } from "../../src/worker/consumer.js";
import { setFault } from "../../src/receiver/faults.js";
async function seed(deps: Parameters<typeof consumeOnce>[0]) {
  const accepted = await acceptSale(
    deps.db,
    tenantA,
    parseSale(Buffer.from(JSON.stringify(fixture()))),
  );
  await publishOnce(deps);
  return accepted.delivery.deliveryId;
}
test("receiver commit/lost reply retries to one effect and one terminal sender outcome", () =>
  withWorker(async (deps, admin) => {
    await setFault(admin, tenantA, "SALE-0001", "commit_drop_once");
    const id = await seed(deps);
    await consumeOnce(deps);
    assert.equal(
      (await getDelivery(deps.db, tenantA, id))?.state,
      "retry_wait",
    );
    assert.equal(
      (await admin.pool.query("select count(*)::int n from receiver.sales"))
        .rows[0].n,
      1,
    );
    await admin.pool.query(
      "update app.generations set next_attempt_at=now()-interval '1 second'",
    );
    const queued = await deps.queue.receive("source");
    for (const message of queued)
      await deps.queue.defer(message.receiptHandle, 0);
    await consumeOnce(deps);
    assert.equal((await getDelivery(deps.db, tenantA, id))?.state, "delivered");
    assert.equal(
      (await admin.pool.query("select count(*)::int n from receiver.sales"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (
        await admin.pool.query(
          "select count(*)::int n from app.audit where event_key='terminal'",
        )
      ).rows[0].n,
      1,
    );
  }));
test("permanent rejection fails immediately while 503 retries retain a bounded budget", () =>
  withWorker(async (deps, admin) => {
    await setFault(admin, tenantA, "SALE-0001", "reject_422");
    const id = await seed(deps);
    await consumeOnce(deps);
    assert.equal((await getDelivery(deps.db, tenantA, id))?.state, "failed");
    assert.equal((await getDelivery(deps.db, tenantA, id))?.attempts, 1);
    assert.equal(
      (await admin.pool.query("select count(*)::int n from receiver.sales"))
        .rows[0].n,
      0,
    );
  }));
test("transient 503 is retried once and accepted input bytes remain unchanged", () =>
  withWorker(async (deps, admin) => {
    await setFault(admin, tenantA, "SALE-0001", "transient_503_once");
    const id = await seed(deps);
    await consumeOnce(deps);
    assert.equal(
      (await getDelivery(deps.db, tenantA, id))?.state,
      "retry_wait",
    );
    await admin.pool.query(
      "update app.generations set next_attempt_at=now()-interval '1 second'",
    );
    await new Promise((r) => setTimeout(r, 2200));
    await consumeOnce(deps);
    assert.equal((await getDelivery(deps.db, tenantA, id))?.state, "delivered");
    assert.equal((await getDelivery(deps.db, tenantA, id))?.attempts, 2);
    assert.deepEqual(
      (await admin.pool.query("select raw from app.events")).rows[0].raw,
      Buffer.from(JSON.stringify(fixture())),
    );
  }));
test(
  "non-resolving receiver requests are aborted and cannot occupy a worker forever",
  { timeout: 12000 },
  () =>
    withWorker(async (deps, admin) => {
      const server = http.createServer(() => {});
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const id = await seed(deps);
        const start = Date.now();
        await consumeOnce({
          ...deps,
          receiverOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        });
        assert.ok(Date.now() - start < 8000);
        assert.equal(
          (await getDelivery(deps.db, tenantA, id))?.state,
          "retry_wait",
        );
        assert.equal(
          (await admin.pool.query("select state from app.attempts")).rows[0]
            .state,
          "unknown",
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    }),
);
test("a mismatched success receipt is never accepted as delivered", () =>
  withWorker(async (deps) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          deliveryId: "wrong",
          saleReference: "SALE-0001",
          businessSha256: "0".repeat(64),
          total: "2598",
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const id = await seed(deps);
      await consumeOnce({
        ...deps,
        receiverOrigin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      });
      assert.equal(
        (await getDelivery(deps.db, tenantA, id))?.state,
        "retry_wait",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }));
