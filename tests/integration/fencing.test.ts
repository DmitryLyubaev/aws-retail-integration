import test from "node:test";
import assert from "node:assert/strict";
import { withWorker } from "../support/worker.js";
import { tenantA } from "../support/database.js";
import { fixture } from "../support/fixture.js";
import { parseSale } from "../../src/domain/sale.js";
import { acceptSale } from "../../src/db/accept.js";
import { getDelivery } from "../../src/db/deliveries.js";
import { claimAttempt, finishAttempt } from "../../src/db/attempts.js";
import { publishOnce } from "../../src/worker/publisher.js";
test("deadline sweep closes the history of an abandoned in-flight attempt", () =>
  withWorker(async (deps, admin) => {
    const accepted = await acceptSale(
      deps.db,
      tenantA,
      parseSale(Buffer.from(JSON.stringify(fixture()))),
    );
    assert.ok(await claimAttempt(deps.db, accepted.delivery, new Date()));
    await publishOnce({
      ...deps,
      clock: { now: () => new Date(Date.now() + 301000) },
    });
    assert.equal(
      (await admin.pool.query("select state from app.attempts")).rows[0].state,
      "abandoned",
    );
  }));
test("Retry-After beyond the deadline records the timing limit rather than five exhausted attempts", () =>
  withWorker(async (deps) => {
    const accepted = await acceptSale(
      deps.db,
      tenantA,
      parseSale(Buffer.from(JSON.stringify(fixture()))),
    );
    const claim = await claimAttempt(deps.db, accepted.delivery, new Date());
    assert.ok(claim);
    await finishAttempt(deps.db, claim, {
      kind: "transient",
      code: "receiver_http_429",
      retryAt: accepted.delivery.deadlineAt,
    });
    assert.equal(
      (await getDelivery(deps.db, tenantA, accepted.delivery.deliveryId))
        ?.failureCode,
      "deadline_exceeded",
    );
  }));
test("two workers contend for one fenced claim and an expired worker cannot replace the winner", () =>
  withWorker(async (deps, admin) => {
    const event = parseSale(Buffer.from(JSON.stringify(fixture())));
    const accepted = await acceptSale(deps.db, tenantA, event);
    const ref = accepted.delivery;
    const claims = await Promise.all([
      claimAttempt(deps.db, ref, new Date()),
      claimAttempt(deps.db, ref, new Date()),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const old = claims.find(Boolean)!;
    await admin.pool.query(
      "update app.generations set lease_until=now()-interval '1 second'",
    );
    const next = await claimAttempt(deps.db, ref, new Date());
    assert.ok(next);
    const receipt = {
      deliveryId: ref.deliveryId,
      saleReference: event.sale.saleReference,
      businessSha256: event.businessSha256,
      total: "2598",
    };
    assert.equal(
      await finishAttempt(deps.db, next, { kind: "success", receipt }),
      true,
    );
    assert.equal(
      await finishAttempt(deps.db, old, { kind: "success", receipt }),
      false,
    );
    assert.equal(
      (await getDelivery(deps.db, tenantA, ref.deliveryId))?.state,
      "delivered",
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
test("five reserved failures exhaust the attempt budget and restart cannot reset the deadline", () =>
  withWorker(async (deps, admin) => {
    const accepted = await acceptSale(
      deps.db,
      tenantA,
      parseSale(Buffer.from(JSON.stringify(fixture()))),
    );
    const original = accepted.delivery.deadlineAt;
    for (let i = 0; i < 5; i++) {
      const claim = await claimAttempt(deps.db, accepted.delivery, new Date());
      assert.ok(claim);
      assert.equal(
        await finishAttempt(deps.db, claim, {
          kind: "transient",
          code: "receiver_http_503",
        }),
        true,
      );
      await admin.pool.query(
        "update app.generations set next_attempt_at=now()-interval '1 second'",
      );
    }
    assert.equal(
      await claimAttempt(deps.db, accepted.delivery, new Date()),
      null,
    );
    const result = await getDelivery(
      deps.db,
      tenantA,
      accepted.delivery.deliveryId,
    );
    assert.equal(result?.attempts, 5);
    assert.equal(result?.state, "failed");
    assert.equal(result?.deadlineAt, original);
  }));
test("expired generation refuses a new claim rather than receiving a fresh retry lifetime", () =>
  withWorker(async (deps) => {
    const accepted = await acceptSale(
      deps.db,
      tenantA,
      parseSale(Buffer.from(JSON.stringify(fixture()))),
    );
    assert.equal(
      await claimAttempt(
        deps.db,
        accepted.delivery,
        new Date(Date.now() + 301000),
      ),
      null,
    );
    assert.equal(
      (await getDelivery(deps.db, tenantA, accepted.delivery.deliveryId))
        ?.state,
      "failed",
    );
  }));
