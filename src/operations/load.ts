import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "../db/connect.js";
import { sha256 } from "../domain/sale.js";
import { DomainError } from "../domain/errors.js";
import base from "../../fixtures/cases.json" with { type: "json" };
export interface LoadOptions {
  apiOrigin: string;
  tokens: readonly [string, string] | readonly string[];
  db: Db;
  runId: string;
  mode?: "local" | "aws";
}
export interface LoadReport {
  mode: "local" | "aws";
  runId: string;
  at: string;
  brisbane: string;
  configSha256: string;
  datasetSha256: string;
  status: "passed" | "failed";
  submissionCount: number;
  uniqueReceiverEffects: number;
  failures: number;
  retries: number;
  achievedPerSecond: number;
  apiP50Ms: number;
  apiP95Ms: number;
  endToEndP50Ms: number;
  endToEndP95Ms: number;
  drainMs: number;
  durationMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssBytes: number;
  dbConnections: number;
}
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
};
export async function runLoad(options: LoadOptions): Promise<LoadReport> {
  if (options.tokens.length !== 2)
    throw new DomainError("two_tenants_required", 400);
  if (
    (
      await options.db.pool.query(
        "select 1 from app.events where sale_reference like 'LOAD-SALE-%' limit 1",
      )
    ).rowCount
  )
    throw new DomainError("load_dataset_not_empty", 409);
  const start = performance.now(),
    cpu = process.cpuUsage(),
    latencies: number[] = [],
    endToEnd: number[] = [];
  let failures = 0;
  const sent = new Map<string, number>();
  const pending = new Set<Promise<void>>();
  for (let n = 0; n < 240; n++) {
    await delay(Math.max(0, start + n * 200 - performance.now()));
    if (pending.size >= 5) await Promise.race(pending);
    const i = n < 200 ? n : n - 200,
      tenant = i % 2;
    const sale = {
      ...base,
      eventId: "LOAD-EVENT-" + i,
      saleReference: "LOAD-SALE-" + i,
    };
    const submittedAt = Date.now();
    const work = (async () => {
      const began = performance.now();
      try {
        const r = await fetch(new URL("/v1/sales", options.apiOrigin), {
          method: "POST",
          headers: {
            authorization: "Bearer " + options.tokens[tenant],
            "content-type": "application/json",
          },
          body: JSON.stringify(sale),
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        if (r.status !== (n < 200 ? 202 : 200)) {
          failures++;
          await r.body?.cancel();
          return;
        }
        const result = (await r.json()) as any;
        const id = result.delivery?.deliveryId;
        if (typeof id !== "string") {
          failures++;
          return;
        }
        if (!sent.has(id)) sent.set(id, submittedAt);
      } catch {
        failures++;
      } finally {
        latencies.push(performance.now() - began);
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
  const submissionsDone = performance.now();
  let rows: any[] = [];
  do {
    rows = (
      await options.db.pool.query(
        "select e.delivery_id,e.tenant_id,e.raw_sha256,e.raw,e.sale,e.business_sha256 expected_digest,g.state,g.attempts,r.created_at,r.business_sha256,r.total,r.sale receiver_sale from app.events e join app.generations g on g.tenant_id=e.tenant_id and g.delivery_id=e.delivery_id and g.generation=e.current_generation left join receiver.sales r on r.tenant_id=e.tenant_id and r.delivery_id=e.delivery_id where e.sale_reference like 'LOAD-SALE-%'",
      )
    ).rows;
    if (rows.length === 200 && rows.every((r) => r.state === "delivered"))
      break;
    await delay(100);
  } while (performance.now() - start < 300000);
  const effectCount = (
    await options.db.pool.query(
      "select count(*)::int n from receiver.sales where sale_reference like 'LOAD-SALE-%'",
    )
  ).rows[0].n;
  const invariant =
    rows.length === 200 &&
    rows.every(
      (r) =>
        r.state === "delivered" &&
        r.created_at &&
        r.raw_sha256 === sha256(r.raw) &&
        r.total === r.sale.total &&
        r.business_sha256 === r.expected_digest &&
        JSON.stringify(r.sale) === JSON.stringify(r.receiver_sale) &&
        r.tenant_id ===
          (Number(r.sale.saleReference.slice("LOAD-SALE-".length)) % 2 === 0
            ? "retailer-a"
            : "retailer-b"),
    ) &&
    new Set(rows.map((r) => r.tenant_id)).size === 2;
  for (const r of rows)
    if (r.created_at && sent.has(r.delivery_id))
      endToEnd.push(
        Math.max(0, r.created_at.getTime() - sent.get(r.delivery_id)!),
      );
  const used = process.cpuUsage(cpu),
    at = new Date();
  const dbConnections = Number(
    (
      await options.db.pool.query(
        "select count(*) n from pg_stat_activity where datname=current_database()",
      )
    ).rows[0].n,
  );
  return {
    mode: options.mode ?? "local",
    runId: options.runId,
    at: at.toISOString(),
    brisbane: at.toLocaleString("en-AU", {
      timeZone: "Australia/Brisbane",
      hour12: false,
    }),
    configSha256: sha256(
      JSON.stringify({ unique: 200, duplicates: 40, rate: 5, concurrency: 5 }),
    ),
    datasetSha256: sha256(
      JSON.stringify(
        rows.map((r) => [r.tenant_id, r.delivery_id, r.raw_sha256]).sort(),
      ),
    ),
    status:
      invariant && effectCount === 200 && failures === 0 ? "passed" : "failed",
    submissionCount: 240,
    uniqueReceiverEffects: effectCount,
    failures,
    retries: rows.reduce((n, r) => n + Math.max(0, r.attempts - 1), 0),
    achievedPerSecond: 240 / ((submissionsDone - start) / 1000),
    apiP50Ms: percentile(latencies, 0.5),
    apiP95Ms: percentile(latencies, 0.95),
    endToEndP50Ms: percentile(endToEnd, 0.5),
    endToEndP95Ms: percentile(endToEnd, 0.95),
    drainMs: performance.now() - submissionsDone,
    durationMs: performance.now() - start,
    cpuUserMs: used.user / 1000,
    cpuSystemMs: used.system / 1000,
    rssBytes: process.memoryUsage().rss,
    dbConnections,
  };
}
