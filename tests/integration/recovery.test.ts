import test from "node:test";
import assert from "node:assert/strict";
import { withWorker } from "../support/worker.js";
import { tenantA } from "../support/database.js";
import { fixture } from "../support/fixture.js";
import { acceptSale } from "../../src/db/accept.js";
import { getHistory, getDelivery } from "../../src/db/deliveries.js";
import { parseSale } from "../../src/domain/sale.js";
import { publishOnce } from "../../src/worker/publisher.js";
import { consumeOnce } from "../../src/worker/consumer.js";
import { setFault } from "../../src/receiver/faults.js";
import { replayDelivery } from "../../src/db/replay.js";
import { startChild, childMessage, stopChild } from "../support/child.js";
for (const boundary of [
  "before_receiver_http",
  "after_attempt_commit_before_queue_delete",
])
  test("actual worker restart at " + boundary, { timeout: 20000 }, () =>
    withWorker(async (deps, admin, extra) => {
      const accepted = await acceptSale(
        deps.db,
        tenantA,
        parseSale(Buffer.from(JSON.stringify(fixture()))),
      );
      await publishOnce(deps);
      const env = {
        CHILD_DATABASE_URL: extra.appUrl,
        CHILD_QUEUE_CONFIG: JSON.stringify(extra.config),
        RECEIVER_ORIGIN: deps.receiverOrigin,
        RECEIVER_TOKENS: JSON.stringify([...deps.receiverTokens]),
        BARRIER: boundary,
      };
      const first = startChild("tests/support/consumer-child.ts", env);
      let second: ReturnType<typeof startChild> | undefined;
      try {
        const barrier = await childMessage(first);
        assert.equal(barrier.event, "barrier");
        await stopChild(first);
        await deps.queue.defer(barrier.handle, 0);
        if (boundary === "before_receiver_http")
          await admin.pool.query(
            "update app.generations set lease_until=now()-interval '1 second'",
          );
        second = startChild("tests/support/consumer-child.ts", {
          ...env,
          BARRIER: "",
        });
        assert.equal((await childMessage(second)).event, "done");
        assert.equal(
          (await getDelivery(deps.db, tenantA, accepted.delivery.deliveryId))
            ?.state,
          "delivered",
        );
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
      } finally {
        await stopChild(first);
        if (second) await stopChild(second);
      }
    }),
  );
test(
  "actual worker restart after absolute deadline does not send late HTTP",
  { timeout: 20000 },
  () =>
    withWorker(async (deps, admin, extra) => {
      const accepted = await acceptSale(
        deps.db,
        tenantA,
        parseSale(Buffer.from(JSON.stringify(fixture()))),
      );
      await publishOnce(deps);
      const env = {
        CHILD_DATABASE_URL: extra.appUrl,
        CHILD_QUEUE_CONFIG: JSON.stringify(extra.config),
        RECEIVER_ORIGIN: deps.receiverOrigin,
        RECEIVER_TOKENS: JSON.stringify([...deps.receiverTokens]),
        BARRIER: "before_receiver_http",
      };
      const first = startChild("tests/support/consumer-child.ts", env);
      let second: ReturnType<typeof startChild> | undefined;
      try {
        const barrier = await childMessage(first);
        await stopChild(first);
        await deps.queue.defer(barrier.handle, 0);
        second = startChild("tests/support/consumer-child.ts", {
          ...env,
          BARRIER: "",
          CLOCK_NOW: new Date(Date.now() + 301000).toISOString(),
        });
        assert.equal((await childMessage(second)).event, "done");
        assert.equal(
          (await getDelivery(deps.db, tenantA, accepted.delivery.deliveryId))
            ?.failureCode,
          "delivery_unconfirmed",
        );
        assert.equal(
          (await admin.pool.query("select count(*)::int n from receiver.sales"))
            .rows[0].n,
          0,
        );
      } finally {
        await stopChild(first);
        if (second) await stopChild(second);
      }
    }),
);
test("correlation history retains bounded error codes and immutable input through recovery", () =>
  withWorker(async (deps, admin) => {
    const raw = Buffer.from(JSON.stringify(fixture()));
    const sale = await acceptSale(deps.db, tenantA, parseSale(raw));
    await setFault(admin, tenantA, "SALE-0001", "reject_422");
    await publishOnce(deps);
    await consumeOnce(deps);
    const history = await getHistory(
      deps.db,
      tenantA,
      sale.delivery.deliveryId,
    );
    assert.ok(
      history.some((x) => x.code === "receiver_http_422" && x.attemptId),
    );
    await setFault(admin, tenantA, "SALE-0001", "accept");
    await replayDelivery(
      deps.db,
      tenantA,
      sale.delivery.deliveryId,
      1,
      "recover",
    );
    await publishOnce(deps);
    await consumeOnce(deps);
    assert.equal(
      (await getDelivery(deps.db, tenantA, sale.delivery.deliveryId))?.state,
      "delivered",
    );
    assert.deepEqual(
      (await admin.pool.query("select raw from app.events")).rows[0].raw,
      raw,
    );
  }));
