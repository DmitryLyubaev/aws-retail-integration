import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pgEnv } from "../../src/operations/backup.js";

test("PostgreSQL backup subprocesses retain verified TLS and the configured CA", async () => {
  const source = new URL(
    "postgres://owner:synthetic@source.invalid/demo?sslmode=verify-full&sslrootcert=%2Fapp%2Fconfig%2Frds-ca.pem",
  );
  const target = new URL(source);
  target.hostname = "restore.invalid";
  for (const url of [source, target]) {
    const env = pgEnv(url.href);
    assert.equal(env.PGSSLMODE, "verify-full");
    assert.equal(env.PGSSLROOTCERT, "/app/config/rds-ca.pem");
    assert.equal(env.PGHOST, url.hostname);
    assert.match(
      await readFile("config/rds-ca.pem", "utf8"),
      /BEGIN CERTIFICATE/,
    );
  }
});
