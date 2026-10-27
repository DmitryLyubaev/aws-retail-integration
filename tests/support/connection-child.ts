import { openDb } from "../../src/db/connect.js";
const db = openDb(process.env.CHILD_DATABASE_URL!);
const result = await db.pool.query("select pg_backend_pid() pid");
process.on("message", async () => {
  const probe = await db.pool.query("select 1 value");
  process.send?.({ event: "recovered", value: probe.rows[0].value });
  await db.close();
  process.disconnect();
});
process.send?.({ event: "idle", pid: result.rows[0].pid });
