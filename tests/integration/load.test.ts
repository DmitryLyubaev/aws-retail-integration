import test from "node:test";
import assert from "node:assert/strict";
import { withWorker } from "../support/worker.js";
import { runLoad } from "../../src/operations/load.js";
import { startApi } from "../../src/api/server.js";
import { seedReceiverCredentials } from "../../src/receiver/store.js";
import { tenantB, tokenA, tokenB } from "../support/database.js";
import { integrationToken } from "../support/worker.js";
import { startWorker } from "../../src/worker/runner.js";
import { mkdir, writeFile } from "node:fs/promises";
import { withDb, tenantA } from "../support/database.js";
import { withQueues } from "../support/queues.js";
import { backupDataset, restoreDataset } from "../../src/operations/backup.js";
import { acceptSale } from "../../src/db/accept.js";
import { parseSale } from "../../src/domain/sale.js";
import base from "../../fixtures/cases.json" with { type: "json" };
test(
  "declared 240 submissions produce 200 effects and an isolated logical restore",
  { timeout: 120000 },
  () =>
    withWorker(async (deps, admin, extra) => {
      const token = "integration-b".padEnd(48, "b");
      await seedReceiverCredentials(admin, [
        { ...tenantB, token, purpose: "integration" },
      ]);
      const api = await startApi({
        db: deps.db,
        host: "127.0.0.1",
        port: 0,
        demoMode: false,
        receiverOrigin: deps.receiverOrigin,
      });
      const worker = startWorker({
        ...deps,
        receiverTokens: new Map([
          ...deps.receiverTokens,
          [tenantB.tenantId, token],
        ]),
      });
      try {
        const report = await runLoad({
          apiOrigin: api.origin,
          tokens: [tokenA, tokenB],
          db: admin,
          runId: "offline-load",
        });
        await mkdir("results", { recursive: true });
        await writeFile("results/load.json", JSON.stringify(report, null, 2));
        assert.equal(report.submissionCount, 240);
        assert.equal(report.uniqueReceiverEffects, 200);
        assert.equal(report.failures, 0);
        assert.equal(report.status, "passed");
        await worker.close();
        await api.close();
        const options = {
          db: admin,
          databaseUrl: extra.maintenanceUrl,
          file: "results/load.dump",
          queueConfig: extra.config,
          queueClient: extra.client,
          writersStopped: true,
          mode: "local" as const,
        };
        const backup = await backupDataset(options);
        await withDb(
          async (target, info) =>
            withQueues(async (_queue, config) => {
              const restored = await restoreDataset({
                ...options,
                backup,
                targetDatabaseUrl: info.url,
                targetQueueConfig: config,
              });
              const duplicate = await acceptSale(
                target,
                tenantA,
                parseSale(
                  Buffer.from(
                    JSON.stringify({
                      ...base,
                      eventId: "LOAD-EVENT-0",
                      saleReference: "LOAD-SALE-0",
                    }),
                  ),
                ),
              );
              assert.equal(duplicate.duplicate, true);
              assert.equal(
                (
                  await target.pool.query(
                    "select count(*)::int n from receiver.sales",
                  )
                ).rows[0].n,
                200,
              );
              await writeFile(
                "results/restore.json",
                JSON.stringify(
                  { backup, restored, dedupeVerified: true },
                  null,
                  2,
                ),
              );
            }),
          { migrations: false },
        );
      } finally {
        await worker.close();
        await api.close();
      }
    }),
);
