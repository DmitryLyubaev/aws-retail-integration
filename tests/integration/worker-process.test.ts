import test from "node:test";
import assert from "node:assert/strict";
import { withWorker } from "../support/worker.js";
import { startChild, childMessage, stopChild } from "../support/child.js";
import { tenantA } from "../support/database.js";
import { fixture } from "../support/fixture.js";
import { parseSale } from "../../src/domain/sale.js";
import { acceptSale } from "../../src/db/accept.js";
import { getDelivery } from "../../src/db/deliveries.js";
import { publishOnce } from "../../src/worker/publisher.js";
import { setFault } from "../../src/receiver/faults.js";
import {
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

test(
  "collector SIGKILL after durable quarantine resumes without duplicate records",
  { timeout: 20000 },
  () =>
    withWorker(async (deps, admin, extra) => {
      await extra.client.send(
        new SendMessageCommand({
          QueueUrl: extra.config.dlqUrl,
          MessageBody: "poison",
        }),
      );
      const env = {
        CHILD_DATABASE_URL: extra.appUrl,
        CHILD_QUEUE_CONFIG: JSON.stringify(extra.config),
        RECEIVER_ORIGIN: deps.receiverOrigin,
        RECEIVER_TOKENS: JSON.stringify([...deps.receiverTokens]),
        COLLECTOR: "true",
        BARRIER: "after_quarantine_commit_before_ack",
      };
      const first = startChild("tests/support/consumer-child.ts", env);
      let second: ReturnType<typeof startChild> | undefined;
      try {
        const barrier = await childMessage(first);
        assert.equal(barrier.event, "barrier");
        assert.equal(
          (await admin.pool.query("select count(*)::int n from app.quarantine"))
            .rows[0].n,
          1,
        );
        await stopChild(first);
        await extra.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: extra.config.dlqUrl,
            ReceiptHandle: barrier.handle,
            VisibilityTimeout: 0,
          }),
        );
        second = startChild("tests/support/consumer-child.ts", {
          ...env,
          BARRIER: "",
        });
        assert.equal((await childMessage(second)).event, "done");
        assert.equal(
          (await admin.pool.query("select count(*)::int n from app.quarantine"))
            .rows[0].n,
          1,
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
for (const kill of [true, false])
  test(
    kill
      ? "worker SIGKILL after receiver commit resumes the same sale"
      : "two actual workers fence a delayed first completion",
    { timeout: 20000 },
    () =>
      withWorker(async (deps, admin, extra) => {
        if (kill)
          await setFault(admin, tenantA, "SALE-0001", "commit_drop_once");
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
          BARRIER: "after_receiver_io_before_attempt_finish",
        };
        const first = startChild("tests/support/consumer-child.ts", env);
        let second: ReturnType<typeof startChild> | undefined;
        try {
          const barrier = await childMessage(first);
          assert.equal(barrier.event, "barrier");
          assert.equal(
            (
              await admin.pool.query(
                "select count(*)::int n from receiver.sales",
              )
            ).rows[0].n,
            1,
          );
          if (kill) {
            await stopChild(first);
            await deps.queue.defer(barrier.handle, 0);
          } else
            await deps.queue.send({
              schemaVersion: 1,
              tenantId: tenantA.tenantId,
              deliveryId: accepted.delivery.deliveryId,
              generation: 1,
              businessSha256: parseSale(Buffer.from(JSON.stringify(fixture())))
                .businessSha256,
            });
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
          if (!kill) {
            const done = childMessage(first);
            first.send("resume");
            assert.equal((await done).event, "done");
          }
          assert.equal(
            (
              await admin.pool.query(
                "select count(*)::int n from receiver.sales",
              )
            ).rows[0].n,
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
