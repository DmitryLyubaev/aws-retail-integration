import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { withDb } from "../support/database.js";
function message(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("connection child message timeout"));
    }, 5000);
    const exited = () => {
      cleanup();
      reject(
        new Error("idle database connection termination crashed the process"),
      );
    };
    const received = (value: unknown) => {
      cleanup();
      resolve(value);
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("exit", exited);
      child.off("message", received);
    }
    child.once("exit", exited);
    child.once("message", received);
  });
}
test(
  "idle backend termination is reported and the process can reconnect",
  { timeout: 10000 },
  () =>
    withDb(async (db, info) => {
      const child = fork("tests/support/connection-child.ts", [], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, CHILD_DATABASE_URL: info.appUrl },
        silent: true,
      });
      try {
        const ready = await message(child);
        assert.equal(ready.event, "idle");
        const recovered = message(child);
        await db.pool.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where pid=$1 and datname=current_database() and usename='p14_app'",
          [ready.pid],
        );
        const timer = setTimeout(() => {
          if (child.connected) child.send("probe");
        }, 150);
        try {
          assert.deepEqual(await recovered, { event: "recovered", value: 1 });
        } finally {
          clearTimeout(timer);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    }),
);
