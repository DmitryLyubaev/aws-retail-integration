import { readFile } from "node:fs/promises";
import { readConfig } from "./config.js";
import { runCli } from "./cli.js";
import { DomainError } from "./domain/errors.js";
import { openDb } from "./db/connect.js";
import { migrate, provisionRoles } from "./db/migrate.js";
import { seedCredentials } from "./db/credentials.js";
import { seedReceiverCredentials } from "./receiver/store.js";
import { startApi } from "./api/server.js";
import { startReceiver } from "./receiver/server.js";
import { createQueue } from "./worker/queue.js";
import { startWorker } from "./worker/runner.js";
import { runCases } from "./operations/evidence.js";
import { runLoad } from "./operations/load.js";
import { backupDataset, restoreDataset } from "./operations/backup.js";
import { SQSClient } from "@aws-sdk/client-sqs";
async function main() {
  const config = readConfig(process.argv[2] ?? "");
  if (config.mode === "cli") {
    process.exitCode = await runCli(process.argv.slice(3), process.env, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
    return;
  }
  if (config.mode === "evidence") {
    if (config.aws) throw new DomainError("offline_evidence_only", 400);
    const report = await runCases();
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exitCode = report.status === "passed" ? 0 : 1;
    return;
  }
  if (!process.env.DATABASE_URL)
    throw new DomainError("database_required", 400);
  const db = openDb(process.env.DATABASE_URL);
  try {
    if (config.mode === "load") {
      const report = await runLoad({
        db,
        mode: config.aws ? "aws" : "local",
        apiOrigin: process.env.DEMO_API_ORIGIN ?? "http://127.0.0.1:3000",
        tokens: JSON.parse(process.env.LOAD_TOKENS ?? "[]"),
        runId: process.env.SESSION_ID ?? "p14-local",
      });
      process.stdout.write(JSON.stringify(report) + "\n");
      process.exitCode = report.status === "passed" ? 0 : 1;
      await db.close();
      return;
    }
    if (config.mode === "backup") {
      if (!process.env.BACKUP_CONFIG_FILE)
        throw new DomainError("backup_config_required", 400);
      const input = JSON.parse(
        await readFile(process.env.BACKUP_CONFIG_FILE, "utf8"),
      );
      if (
        input.mode !== (config.aws ? "aws" : "local") ||
        input.queueConfig?.mode !== input.mode
      )
        throw new DomainError("invalid_backup_mode", 400);
      const queueClient = new SQSClient({
        region: config.region,
        maxAttempts: 1,
        ...(!config.aws
          ? {
              endpoint: input.queueConfig.localEndpoint,
              credentials: { accessKeyId: "local", secretAccessKey: "local" },
            }
          : {}),
      });
      try {
        const options = {
          ...input,
          db,
          databaseUrl: process.env.DATABASE_URL,
          queueClient,
        };
        const report =
          process.argv[3] === "restore"
            ? await restoreDataset(options)
            : await backupDataset(options);
        process.stdout.write(JSON.stringify(report) + "\n");
      } finally {
        queueClient.destroy();
        await db.close();
      }
      return;
    }
    if (config.mode === "migrate") {
      if (process.env.ROLE_PASSWORDS)
        await provisionRoles(db, JSON.parse(process.env.ROLE_PASSWORDS));
      await migrate(db);
      await db.close();
      return;
    }
    if (config.mode === "seed") {
      if (!process.env.SEED_FILE)
        throw new DomainError("seed_file_required", 400);
      const input = JSON.parse(await readFile(process.env.SEED_FILE, "utf8"));
      await seedCredentials(db, input.application);
      await seedReceiverCredentials(db, input.receiver);
      await db.close();
      return;
    }
    const running =
      config.mode === "api"
        ? await startApi({ ...config, db })
        : config.mode === "receiver"
          ? await startReceiver({ ...config, db })
          : startWorker({
              db,
              queue: createQueue({
                mode: config.aws ? "aws" : "local",
                region: config.region,
                sourceUrl: process.env.SOURCE_QUEUE_URL!,
                dlqUrl: process.env.DLQ_URL!,
                localEndpoint: process.env.QUEUE_ENDPOINT,
              }),
              clock: { now: () => new Date() },
              receiverOrigin: config.receiverOrigin,
              receiverTokens: new Map(
                Object.entries(JSON.parse(process.env.RECEIVER_TOKENS ?? "{}")),
              ),
            });
    const close = async () => {
      await running.close();
      await db.close();
    };
    process.once("SIGTERM", () => void close());
    process.once("SIGINT", () => void close());
  } catch (e) {
    await db.close();
    throw e;
  }
}
main().catch((e) => {
  process.stderr.write(
    JSON.stringify({
      code: e instanceof DomainError ? e.code : "startup_failed",
    }) + "\n",
  );
  process.exitCode = 1;
});
