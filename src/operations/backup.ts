import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { openDb, type Db } from "../db/connect.js";
import { sha256 } from "../domain/sale.js";
import { DomainError } from "../domain/errors.js";
import type { QueueConfig } from "../worker/queue.js";
const exec = promisify(execFile);
export interface BackupOptions {
  db: Db;
  databaseUrl: string;
  file: string;
  queueConfig: QueueConfig;
  queueClient: SQSClient;
  writersStopped: boolean;
  mode: "local" | "aws";
  liveBucket?: string;
  liveKey?: string;
}
export interface BackupManifest {
  mode: "local" | "aws";
  at: string;
  sourceIdentity: string;
  datasetSha256: string;
  sha256: string;
  bytes: number;
  durationMs: number;
  counts: Record<string, number>;
  s3?: { bucket: string; key: string };
}
export interface RestoreOptions extends BackupOptions {
  backup: BackupManifest;
  targetDatabaseUrl: string;
  targetQueueConfig: QueueConfig;
}
export interface RestoreReport {
  mode: "local" | "aws";
  at: string;
  datasetSha256: string;
  durationMs: number;
  counts: Record<string, number>;
}
async function identity(db: Db) {
  return sha256(
    JSON.stringify(
      (
        await db.pool.query(
          "select current_database() db,inet_server_addr()::text address,inet_server_port() port",
        )
      ).rows[0],
    ),
  );
}
export async function datasetSnapshot(
  db: Db,
): Promise<{ sha256: string; counts: Record<string, number> }> {
  const tables = (
    await db.pool.query(
      "select schemaname,tablename from pg_tables where schemaname in ('app','receiver') order by schemaname,tablename",
    )
  ).rows;
  const rows: Record<string, unknown> = {},
    counts: Record<string, number> = {};
  for (const t of tables) {
    const name = t.schemaname + "." + t.tablename;
    const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
    const data = await db.pool.query(
      `select to_jsonb(t) row from ${quote(t.schemaname)}.${quote(t.tablename)} t order by to_jsonb(t)::text`,
    );
    rows[name] = data.rows.map((x) => x.row);
    counts[name] = data.rowCount!;
  }
  return { sha256: sha256(JSON.stringify(rows)), counts };
}
async function queuesEmpty(
  options: BackupOptions,
  config = options.queueConfig,
) {
  for (const QueueUrl of [config.sourceUrl, config.dlqUrl]) {
    const result = await options.queueClient.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ],
      }),
    );
    if (
      (
        [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ] as const
      ).some(
        (k) =>
          result.Attributes?.[k] === undefined ||
          Number(result.Attributes[k]) !== 0,
      )
    )
      throw new DomainError("queues_not_empty", 409);
  }
}
export async function assertQuiescent(options: BackupOptions) {
  if (!options.writersStopped)
    throw new DomainError("writers_not_stopped", 409);
  const busy = await options.db.pool.query(
    "select (select count(*) from app.generations where state not in ('delivered','failed'))+(select count(*) from app.outbox where state in ('pending','publishing'))+(select count(*) from app.attempts where state='claimed')+(select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state in ('active','idle in transaction')) n",
  );
  if (Number(busy.rows[0].n) !== 0)
    throw new DomainError("dataset_not_quiescent", 409);
  await queuesEmpty(options);
}
function pgEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const u = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "prefer",
  };
}
export async function backupDataset(
  options: BackupOptions,
): Promise<BackupManifest> {
  const start = performance.now();
  await assertQuiescent(options);
  const snapshot = await datasetSnapshot(options.db);
  if (options.mode === "aws" && (!options.liveBucket || !options.liveKey))
    throw new DomainError("private_backup_required", 400);
  try {
    await exec(
      "pg_dump",
      [
        "--format=custom",
        "--schema=app",
        "--schema=receiver",
        "--file",
        options.file,
      ],
      { env: pgEnv(options.databaseUrl), timeout: 60000, maxBuffer: 1048576 },
    );
  } catch {
    throw new DomainError("dump_failed", 500);
  }
  await chmod(options.file, 0o600);
  const bytes = await readFile(options.file);
  const manifest: BackupManifest = {
    mode: options.mode,
    at: new Date().toISOString(),
    sourceIdentity: await identity(options.db),
    datasetSha256: snapshot.sha256,
    sha256: sha256(bytes),
    bytes: bytes.length,
    durationMs: performance.now() - start,
    counts: snapshot.counts,
  };
  if (options.mode === "aws") {
    const client = new S3Client({
      region: options.queueConfig.region,
      maxAttempts: 2,
    });
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: options.liveBucket,
          Key: options.liveKey,
          Body: bytes,
          ServerSideEncryption: "AES256",
          ChecksumSHA256: Buffer.from(manifest.sha256, "hex").toString(
            "base64",
          ),
        }),
      );
      manifest.s3 = { bucket: options.liveBucket!, key: options.liveKey! };
    } finally {
      client.destroy();
    }
  }
  await writeFile(
    options.file + ".manifest.json",
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  return manifest;
}
export async function restoreDataset(
  options: RestoreOptions,
): Promise<RestoreReport> {
  const start = performance.now();
  const source = new URL(options.databaseUrl),
    target = new URL(options.targetDatabaseUrl);
  const originals = new Set(
    [options.queueConfig.sourceUrl, options.queueConfig.dlqUrl].map(
      (x) => new URL(x).href,
    ),
  );
  if (
    (source.host === target.host && source.pathname === target.pathname) ||
    options.targetQueueConfig.sourceUrl === options.targetQueueConfig.dlqUrl ||
    [
      options.targetQueueConfig.sourceUrl,
      options.targetQueueConfig.dlqUrl,
    ].some((x) => originals.has(new URL(x).href))
  )
    throw new DomainError("restore_not_isolated", 400);
  const db = openDb(options.targetDatabaseUrl);
  try {
    if ((await identity(db)) === options.backup.sourceIdentity)
      throw new DomainError("restore_not_isolated", 400);
    if (
      (
        await db.pool.query(
          "select 1 from pg_tables where schemaname in ('app','receiver') limit 1",
        )
      ).rowCount
    )
      throw new DomainError("restore_target_not_empty", 409);
    await queuesEmpty(options, options.targetQueueConfig);
    if (sha256(await readFile(options.file)) !== options.backup.sha256)
      throw new DomainError("backup_digest_mismatch", 400);
    try {
      await exec(
        "pg_restore",
        [
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--role=p14_migrator",
          "--dbname",
          decodeURIComponent(target.pathname.slice(1)),
          options.file,
        ],
        {
          env: pgEnv(options.targetDatabaseUrl),
          timeout: 60000,
          maxBuffer: 1048576,
        },
      );
    } catch {
      throw new DomainError("restore_failed", 500);
    }
    const snapshot = await datasetSnapshot(db);
    if (snapshot.sha256 !== options.backup.datasetSha256)
      throw new DomainError("restored_dataset_mismatch", 500);
    return {
      mode: options.mode,
      at: new Date().toISOString(),
      datasetSha256: snapshot.sha256,
      durationMs: performance.now() - start,
      counts: snapshot.counts,
    };
  } finally {
    await db.close();
  }
}
