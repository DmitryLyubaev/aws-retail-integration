import type { Db } from "../db/connect.js";
import { createTelemetry } from "../telemetry.js";
export const telemetry = createTelemetry(process.env.SESSION_ID ?? "p14-local");
export async function observe(
  db: Db,
  delta: Partial<
    Record<"accepted" | "delivered" | "retry" | "failed", number>
  > = {},
) {
  try {
    const result = await db.pool.query(
      "select count(*)::int n from app.outbox where state in ('pending','publishing')",
    );
    telemetry.metrics({
      accepted: 0,
      delivered: 0,
      retry: 0,
      failed: 0,
      ...delta,
      "outbox-pending": result.rows[0].n,
    });
  } catch {
    telemetry.log({ component: "telemetry", code: "observation_failed" });
  }
}
