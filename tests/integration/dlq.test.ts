import test from "node:test";
import assert from "node:assert/strict";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { withWorker } from "../support/worker.js";
import { tenantA } from "../support/database.js";
import { fixture } from "../support/fixture.js";
import { parseSale } from "../../src/domain/sale.js";
import { acceptSale } from "../../src/db/accept.js";
import { getDelivery } from "../../src/db/deliveries.js";
import { publishOnce } from "../../src/worker/publisher.js";
import { consumeOnce } from "../../src/worker/consumer.js";
import { collectOnce } from "../../src/worker/collector.js";
import { persistQuarantine } from "../../src/db/quarantine.js";
import { randomUUID } from "node:crypto";
test("unknown references and digest mismatches cannot block a healthy source message", () =>
  withWorker(async (deps, admin, extra) => {
    const sale = await acceptSale(
      deps.db,
      tenantA,
      parseSale(Buffer.from(JSON.stringify(fixture()))),
    );
    for (const deliveryId of [sale.delivery.deliveryId, randomUUID()])
      await extra.client.send(
        new SendMessageCommand({
          QueueUrl: extra.config.sourceUrl,
          MessageBody: JSON.stringify({
            schemaVersion: 1,
            tenantId: tenantA.tenantId,
            deliveryId,
            generation: 1,
            businessSha256: "0".repeat(64),
          }),
        }),
      );
    await publishOnce(deps);
    await consumeOnce(deps);
    assert.equal(
      (await getDelivery(deps.db, tenantA, sale.delivery.deliveryId))?.state,
      "delivered",
    );
    assert.equal(
      (await admin.pool.query("select count(*)::int n from receiver.sales"))
        .rows[0].n,
      1,
    );
  }));
test(
  "poison reaches the local DLQ while healthy work completes and collection is durable",
  { timeout: 15000 },
  () =>
    withWorker(async (deps, admin, extra) => {
      await extra.client.send(
        new SendMessageCommand({
          QueueUrl: extra.config.sourceUrl,
          MessageBody: "not JSON",
        }),
      );
      for (let i = 0; i < 5; i++) await consumeOnce(deps);
      const sale = await acceptSale(
        deps.db,
        tenantA,
        parseSale(Buffer.from(JSON.stringify(fixture()))),
      );
      await publishOnce(deps);
      await consumeOnce(deps);
      let seen: any;
      const queue = {
        ...deps.queue,
        receive: async (kind: "source" | "dlq") => {
          const messages = await deps.queue.receive(kind);
          if (kind === "dlq") seen = messages[0];
          return messages;
        },
      };
      await collectOnce({ ...deps, queue });
      assert.equal(
        (await getDelivery(deps.db, tenantA, sale.delivery.deliveryId))?.state,
        "delivered",
      );
      assert.equal(
        (await admin.pool.query("select count(*)::int n from app.quarantine"))
          .rows[0].n,
        1,
      );
      await persistQuarantine(deps.db, seen, "invalid_envelope");
      assert.equal(
        (await admin.pool.query("select count(*)::int n from app.quarantine"))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await admin.pool.query("select count(*)::int n from app.events"))
          .rows[0].n,
        1,
      );
    }),
);
test("a forged digest in a dead letter cannot fail the real delivery", () =>
  withWorker(async (deps, admin, extra) => {
    const sale = await acceptSale(
      deps.db,
      tenantA,
      parseSale(Buffer.from(JSON.stringify(fixture()))),
    );
    await extra.client.send(
      new SendMessageCommand({
        QueueUrl: extra.config.dlqUrl,
        MessageBody: JSON.stringify({
          schemaVersion: 1,
          tenantId: tenantA.tenantId,
          deliveryId: sale.delivery.deliveryId,
          generation: 1,
          businessSha256: "0".repeat(64),
        }),
      }),
    );
    await collectOnce(deps);
    assert.equal(
      (await getDelivery(deps.db, tenantA, sale.delivery.deliveryId))?.state,
      "pending",
    );
    assert.equal(
      (await admin.pool.query("select code from app.quarantine")).rows[0].code,
      "invalid_reference",
    );
  }));
