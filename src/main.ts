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
async function main() {
  const config = readConfig(process.argv[2] ?? "");
  if (config.mode === "cli") {
    process.exitCode = await runCli(process.argv.slice(3), process.env, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
    return;
  }
  if (["backup", "load", "evidence"].includes(config.mode))
    throw new DomainError("operation_not_implemented", 400);
  if (!process.env.DATABASE_URL)
    throw new DomainError("database_required", 400);
  const db = openDb(process.env.DATABASE_URL);
  try {
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
