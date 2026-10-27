import test from "node:test";
import { runtimeArgs } from "../support/runtime.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCli } from "../../src/cli.js";
import { readConfig } from "../../src/config.js";
import { startApi } from "../../src/api/server.js";
import { withWorker } from "../support/worker.js";
import { tokenA } from "../support/database.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../support/fixture.js";
import { publishOnce } from "../../src/worker/publisher.js";
import { consumeOnce } from "../../src/worker/consumer.js";
test("CLI submit, fault, show and idempotent replay exercise the HTTP path", () =>
  withWorker(async (deps) => {
    const api = await startApi({
      db: deps.db,
      host: "127.0.0.1",
      port: 0,
      demoMode: true,
      receiverOrigin: deps.receiverOrigin,
    });
    const dir = await mkdtemp(join(tmpdir(), "p14-cli-"));
    const file = join(dir, "sale.json");
    await writeFile(file, JSON.stringify(fixture()));
    let output = "";
    const env = { DEMO_API_ORIGIN: api.origin, DEMO_TOKEN: tokenA };
    const call = async (args: string[]) => {
      output = "";
      assert.equal(
        await runCli([...args, "--json"], env, {
          out: (s) => (output += s),
          err: (s) => (output += s),
        }),
        0,
        output,
      );
      return JSON.parse(output);
    };
    try {
      await call(["fault", "--sale", "SALE-0001", "--mode", "reject_422"]);
      const sale = await call(["submit", "--file", file]);
      const id = sale.delivery.deliveryId;
      await publishOnce(deps);
      await consumeOnce(deps);
      assert.equal((await call(["show", "--id", id])).state, "failed");
      await call(["fault", "--sale", "SALE-0001", "--mode", "accept"]);
      const replay = [
        "replay",
        "--id",
        id,
        "--generation",
        "1",
        "--request-id",
        "cli-replay",
      ];
      assert.equal((await call(replay)).generation, 2);
      assert.equal((await call(replay)).generation, 2);
      await publishOnce(deps);
      await consumeOnce(deps);
      assert.equal((await call(["show", "--id", id])).state, "delivered");
    } finally {
      await api.close();
      await rm(dir, { recursive: true });
    }
  }));
test("CLI uses real HTTP and subprocess output never reveals credentials", () =>
  withWorker(async (deps) => {
    const api = await startApi({
      db: deps.db,
      host: "127.0.0.1",
      port: 0,
      demoMode: true,
      receiverOrigin: deps.receiverOrigin,
    });
    try {
      const env = {
        ...process.env,
        DEMO_API_ORIGIN: api.origin,
        DEMO_TOKEN: tokenA,
        DATABASE_URL: "postgres://secret:password@private/db",
      };
      const result = await promisify(execFile)(
        process.execPath,
        [...runtimeArgs("src/main.ts"), "cli", "list", "--json"],
        { env },
      );
      assert.deepEqual(JSON.parse(result.stdout), []);
      let out = "";
      const io = {
        out: (s: string) => (out += s),
        err: (s: string) => (out += s),
      };
      assert.equal(await runCli(["show", "--id", "not-an-id"], env, io), 1);
      assert.equal(await runCli(["list", "--unknown", tokenA], env, io), 1);
      assert.ok(!out.includes(tokenA));
      assert.ok(!out.includes(env.DATABASE_URL));
      const unknown = await promisify(execFile)(
        process.execPath,
        [...runtimeArgs("src/main.ts"), "nonsense"],
        { env },
      ).catch((e) => e);
      assert.equal(unknown.code, 1);
      assert.match(unknown.stderr, /invalid_mode/);
      assert.ok(!unknown.stderr.includes("password"));
    } finally {
      await api.close();
    }
  }));
test("AWS configuration refuses public API binding, local queue overrides and static credentials", () => {
  const base = {
    AWS_MODE: "true",
    AWS_REGION: "ap-southeast-2",
    API_HOST: "127.0.0.1",
  };
  for (const extra of [
    { API_HOST: "0.0.0.0" },
    { QUEUE_ENDPOINT: "http://elasticmq:9324" },
    { AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local" },
  ])
    assert.throws(() => readConfig("api", { ...base, ...extra }), {
      code: "invalid_aws_config",
    });
});
