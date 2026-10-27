import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDb, tenantA } from "../support/database.js";
import { withQueues } from "../support/queues.js";
import { acceptSale } from "../../src/db/accept.js";
import { parseSale } from "../../src/domain/sale.js";
import { fixture } from "../support/fixture.js";
import {
  backupDataset,
  restoreDataset,
  datasetSnapshot,
} from "../../src/operations/backup.js";
import { recordSale } from "../../src/receiver/store.js";
import { seedReceiverCredentials } from "../../src/receiver/store.js";
test("logical restore verifies canonical data, dedupe and grants without changing original", () =>
  withDb(async (db, info) =>
    withQueues(async (_q, config, client) => {
      const dir = await mkdtemp(join(tmpdir(), "p14-restore-"));
      try {
        const event = parseSale(Buffer.from(JSON.stringify(fixture())));
        const sale = await acceptSale(db, tenantA, event);
        await seedReceiverCredentials(db, [
          {
            ...tenantA,
            token: "restore-test".padEnd(48, "x"),
            purpose: "integration",
          },
        ]);
        await recordSale(db, tenantA, sale.delivery.deliveryId, event);
        // Explicit fixture of a drained generation; recovery tests exercise the actual worker path.
        await db.pool.query("update app.generations set state='delivered'");
        await db.pool.query("update app.outbox set state='published'");
        const before = await datasetSnapshot(db);
        const options = {
          db,
          databaseUrl: info.url,
          file: join(dir, "dataset.dump"),
          queueConfig: config,
          queueClient: client,
          writersStopped: true as const,
          mode: "local" as const,
        };
        const backup = await backupDataset(options);
        assert.ok(backup.bytes > 0);
        await db.pool.query("update app.generations set state='pending'");
        await assert.rejects(backupDataset(options), {
          code: "dataset_not_quiescent",
        });
        await db.pool.query("update app.generations set state='delivered'");
        await assert.rejects(
          backupDataset({ ...options, writersStopped: false }),
          { code: "writers_not_stopped" },
        );
        await assert.rejects(
          restoreDataset({
            ...options,
            backup,
            targetDatabaseUrl: info.url,
            targetQueueConfig: config,
          }),
          { code: "restore_not_isolated" },
        );
        await withDb(
          async (target, targetInfo) =>
            withQueues(async (_restoreQ, restoreConfig) => {
              // Restore requires a fresh empty database, so this fixture does not pre-run migrations.
              await assert.rejects(
                restoreDataset({
                  ...options,
                  backup: { ...backup, sha256: "0".repeat(64) },
                  targetDatabaseUrl: targetInfo.url,
                  targetQueueConfig: restoreConfig,
                }),
                { code: "backup_digest_mismatch" },
              );
              assert.equal(
                (
                  await target.pool.query(
                    "select count(*)::int n from pg_tables where schemaname in ('app','receiver')",
                  )
                ).rows[0].n,
                0,
              );
              const result = await restoreDataset({
                ...options,
                backup,
                targetDatabaseUrl: targetInfo.url,
                targetQueueConfig: restoreConfig,
              });
              assert.equal(result.datasetSha256, before.sha256);
              const repeated = await acceptSale(target, tenantA, event);
              assert.equal(repeated.duplicate, true);
              const receipt = await recordSale(
                target,
                tenantA,
                sale.delivery.deliveryId,
                event,
              );
              assert.equal(receipt.kind, "success");
              assert.equal(
                (
                  await target.pool.query(
                    "select count(*)::int n from receiver.sales",
                  )
                ).rows[0].n,
                1,
              );
              assert.equal(
                (
                  await target.pool.query(
                    "select has_table_privilege('p14_app','receiver.sales','INSERT') p",
                  )
                ).rows[0].p,
                false,
              );
              assert.equal(
                (
                  await target.pool.query(
                    "select has_table_privilege('p14_receiver','receiver.sales','INSERT') p",
                  )
                ).rows[0].p,
                true,
              );
            }),
          { migrations: false },
        );
        assert.deepEqual(await datasetSnapshot(db), before);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  ));
