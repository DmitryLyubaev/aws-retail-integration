import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { acceptSale } from "../../src/db/accept.js";
import { getDelivery } from "../../src/db/deliveries.js";
import { parseSale } from "../../src/domain/sale.js";
import { publishOnce } from "../../src/worker/publisher.js";
import { createQueue } from "../../src/worker/queue.js";
import { withQueues } from "../support/queues.js";
import { withDb, tenantA } from "../support/database.js";
import { fixture } from "../support/fixture.js";
const event = () => parseSale(Buffer.from(JSON.stringify(fixture())));
test("uncommitted outbox work is invisible to the publisher", () =>
  withDb(async (db) =>
    withQueues(async (queue) => {
      const client = await db.pool.connect();
      const sale = event();
      const id = randomUUID();
      try {
        await client.query("begin");
        await client.query(
          "insert into app.events(tenant_id,delivery_id,sale_reference,raw,raw_sha256,canonical,business_sha256,sale) values($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            tenantA.tenantId,
            id,
            sale.sale.saleReference,
            sale.raw,
            sale.rawSha256,
            sale.canonical,
            sale.businessSha256,
            sale.sale,
          ],
        );
        await client.query(
          "insert into app.generations(tenant_id,delivery_id,generation) values($1,$2,1)",
          [tenantA.tenantId, id],
        );
        await client.query(
          "insert into app.outbox(id,tenant_id,delivery_id,generation) values($1,$2,$3,1)",
          [randomUUID(), tenantA.tenantId, id],
        );
        assert.equal(
          await publishOnce({ db, queue, clock: { now: () => new Date() } }),
          0,
        );
        await client.query("commit");
        assert.equal(
          await publishOnce({ db, queue, clock: { now: () => new Date() } }),
          1,
        );
      } finally {
        await client.query("rollback");
        client.release();
      }
    }),
  ));
test("a publisher does not send another leased item after its lease has expired", () =>
  withDb(async (db) =>
    withQueues(async (queue) => {
      await acceptSale(db, tenantA, event());
      await acceptSale(
        db,
        tenantA,
        parseSale(
          Buffer.from(
            JSON.stringify(
              fixture({ eventId: "EVENT-2", saleReference: "SALE-2" }),
            ),
          ),
        ),
      );
      const initial = new Date();
      let now = initial;
      await publishOnce({
        db,
        queue,
        clock: { now: () => now },
        fault: async () => {
          now = new Date(initial.getTime() + 31000);
        },
      });
      assert.equal((await queue.receive("source")).length, 1);
    }),
  ));
for (const point of [
  "after_accept_commit",
  "after_queue_send_before_publish_mark",
])
  test(
    `actual process crash at ${point} preserves recoverable outbox`,
    { timeout: 20000 },
    () =>
      withDb(async (db, info) =>
        withQueues(async (queue, config) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "tests/support/publisher-child.ts"],
            {
              env: {
                ...process.env,
                CHILD_DATABASE_URL: info.appUrl,
                CHILD_QUEUE_CONFIG: JSON.stringify(config),
                BARRIER: point,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let text = "";
          try {
            const barrier = await new Promise<{ deliveryId: string }>(
              (resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("publisher barrier timeout")),
                  8000,
                );
                child.stdout.on("data", (chunk) => {
                  text += chunk.toString();
                  if (text.includes("\n")) {
                    clearTimeout(timer);
                    try {
                      resolve(JSON.parse(text.split("\n")[0]));
                    } catch (error) {
                      reject(error);
                    }
                  }
                });
                child.once("exit", () => {
                  clearTimeout(timer);
                  reject(new Error("publisher exited before barrier"));
                });
              },
            );
            const exit = once(child, "exit");
            child.kill("SIGKILL");
            await exit;
            await db.pool.query(
              "update app.outbox set lease_until=now()-interval '1 second'",
            );
            assert.equal(
              await publishOnce({
                db,
                queue,
                clock: { now: () => new Date() },
              }),
              1,
            );
            const messages = await queue.receive("source");
            assert.equal(
              messages.length,
              point === "after_accept_commit" ? 1 : 2,
            );
            if (messages.length === 2)
              assert.equal(messages[0].body, messages[1].body);
            assert.equal(
              (
                await db.pool.query(
                  "select count(*)::int n from app.generations",
                )
              ).rows[0].n,
              1,
            );
            assert.deepEqual(
              (await db.pool.query("select raw from app.events")).rows[0].raw,
              event().raw,
            );
            assert.equal(
              (await getDelivery(db, tenantA, barrier.deliveryId))?.state,
              "pending",
            );
          } finally {
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGKILL");
          }
        }),
      ),
  );
test("concurrent publishers lease work once and late completion cannot downgrade delivery", () =>
  withDb(async (db) =>
    withQueues(async (queue) => {
      const accepted = await acceptSale(db, tenantA, event());
      const deps = { db, queue, clock: { now: () => new Date() } };
      const results = await Promise.all([publishOnce(deps), publishOnce(deps)]);
      assert.equal(
        results.reduce((a, b) => a + b, 0),
        1,
      );
      assert.equal((await queue.receive("source")).length, 1);
      await db.pool.query(
        "update app.outbox set state='pending',fence=null,lease_until=null",
      );
      await publishOnce({
        ...deps,
        fault: async () => {
          await db.pool.query("update app.generations set state='delivered'");
        },
      });
      assert.equal(
        (await getDelivery(db, tenantA, accepted.delivery.deliveryId))?.state,
        "delivered",
      );
    }),
  ));
test("five publish failures terminate the generation and deadlines are not reset", () =>
  withDb(async (db) =>
    withQueues(async (queue) => {
      const accepted = await acceptSale(db, tenantA, event());
      let now = new Date();
      const failing = {
        ...queue,
        send: async () => {
          throw new Error("injected transport outage");
        },
      };
      for (let i = 0; i < 6; i++) {
        await publishOnce({ db, queue: failing, clock: { now: () => now } });
        now = new Date(now.getTime() + 3000);
      }
      const state = await getDelivery(
        db,
        tenantA,
        accepted.delivery.deliveryId,
      );
      assert.equal(state?.state, "failed");
      assert.equal(state?.failureCode, "queue_publish_failed");
      assert.equal(
        (await db.pool.query("select failures from app.outbox")).rows[0]
          .failures,
        5,
      );
      assert.equal(
        (
          await db.pool.query(
            "select count(*)::int n from app.audit where event_key='terminal'",
          )
        ).rows[0].n,
        1,
      );
    }),
  ));
test("an expired unpublished generation stops without sending more queue work", () =>
  withDb(async (db) =>
    withQueues(async (queue) => {
      const accepted = await acceptSale(db, tenantA, event());
      await publishOnce({
        db,
        queue,
        clock: { now: () => new Date(Date.now() + 301000) },
      });
      assert.equal(
        (await getDelivery(db, tenantA, accepted.delivery.deliveryId))?.state,
        "failed",
      );
      assert.equal(
        (await db.pool.query("select state from app.outbox")).rows[0].state,
        "failed",
      );
    }),
  ));
test(
  "a non-resolving SQS send is bounded by the adapter deadline",
  { timeout: 12000 },
  () =>
    withDb(async (db) => {
      await acceptSale(db, tenantA, event());
      const server = http.createServer(() => {});
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as { port: number };
      const endpoint = `http://127.0.0.1:${address.port}`;
      const queue = createQueue({
        mode: "local",
        region: "ap-southeast-2",
        localEndpoint: endpoint,
        sourceUrl: endpoint + "/source",
        dlqUrl: endpoint + "/dlq",
      });
      const start = Date.now();
      try {
        assert.equal(
          await publishOnce({ db, queue, clock: { now: () => new Date() } }),
          0,
        );
        assert.ok(Date.now() - start < 8000);
        assert.equal(
          (await db.pool.query("select failures from app.outbox")).rows[0]
            .failures,
          1,
        );
      } finally {
        queue.close();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    }),
);
