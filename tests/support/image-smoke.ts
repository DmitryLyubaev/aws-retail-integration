import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { docker, streamText } from "./docker.js";
import { withWorker, integrationToken } from "./worker.js";
import { tenantB, tokenA, tokenB } from "./database.js";
import { seedReceiverCredentials } from "../../src/receiver/store.js";
import { fixture } from "./fixture.js";
export async function imageSmoke() {
  const Image = process.env.P14_RUNTIME_IMAGE ?? "p14-runtime:offline",
    ids: string[] = [];
  const suffix = randomUUID().slice(0, 8),
    network = process.env.P14_DOCKER_NETWORK ?? "p14_default";
  const self = await docker(
    "GET",
    "/containers/" + process.env.HOSTNAME + "/json",
  );
  const hostRoot = self.Mounts.find(
    (m: any) => m.Destination === "/app",
  )?.Source;
  if (typeof hostRoot !== "string")
    throw new Error("Tooling workspace mount required");
  const scratch = "results/image-" + suffix;
  await mkdir(scratch, { recursive: true });
  async function create(
    name: string,
    env: Record<string, string>,
    cmd: string[],
    entry?: string[],
  ) {
    const c = await docker("POST", "/containers/create?name=" + name, {
      Image,
      Cmd: cmd,
      ...(entry ? { Entrypoint: entry } : {}),
      Env: Object.entries(env).map(([k, v]) => k + "=" + v),
      Labels: { "p14.image-smoke": suffix },
      HostConfig: {
        NetworkMode: network,
        Binds: [hostRoot + "/" + scratch + ":/scratch"],
      },
    });
    if (!/^[a-f0-9]{64}$/.test(c.Id))
      throw new Error("Invalid created container ID");
    ids.push(c.Id);
    await docker("POST", "/containers/" + c.Id + "/start");
    return c.Id as string;
  }
  async function oneoff(
    name: string,
    env: Record<string, string>,
    cmd: string[],
    entry?: string[],
  ) {
    const id = await create("p14-" + suffix + "-" + name, env, cmd, entry);
    const state = await docker(
      "POST",
      "/containers/" + id + "/wait?condition=not-running",
    );
    const raw = await docker(
      "GET",
      "/containers/" + id + "/logs?stdout=true&stderr=true",
    );
    return { code: state.StatusCode, text: streamText(raw) };
  }
  async function ready(url: string) {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(url, {
          headers: { authorization: "Bearer " + tokenA },
          signal: AbortSignal.timeout(500),
        });
        await r.body?.cancel();
        if (r.ok) return;
      } catch {}
      await delay(100);
    }
    throw new Error("Image readiness deadline");
  }
  try {
    return await withWorker(async (deps, admin, extra) => {
      const bToken = "image-integration-b".padEnd(48, "b");
      await seedReceiverCredentials(admin, [
        { ...tenantB, token: bToken, purpose: "integration" },
      ]);
      const common = {
        AWS_MODE: "false",
        AWS_REGION: "ap-southeast-2",
        AWS_EC2_METADATA_DISABLED: "true",
        SESSION_ID: "p14-image",
        DEMO_MODE: "true",
      };
      const receiverName = "p14-" + suffix + "-receiver",
        apiName = "p14-" + suffix + "-api";
      const receiver = await create(
        receiverName,
        {
          ...common,
          DATABASE_URL: extra.receiverUrl,
          RECEIVER_HOST: "0.0.0.0",
          PORT: "3001",
        },
        ["receiver"],
      );
      const api = await create(
        apiName,
        {
          ...common,
          DATABASE_URL: extra.appUrl,
          API_HOST: "0.0.0.0",
          RECEIVER_ORIGIN: "http://" + receiverName + ":3001",
        },
        ["api"],
      );
      const worker = await create(
        "p14-" + suffix + "-worker",
        {
          ...common,
          DATABASE_URL: extra.appUrl,
          QUEUE_ENDPOINT: extra.config.localEndpoint!,
          SOURCE_QUEUE_URL: extra.config.sourceUrl,
          DLQ_URL: extra.config.dlqUrl,
          RECEIVER_ORIGIN: "http://" + receiverName + ":3001",
          RECEIVER_TOKENS: JSON.stringify({
            "retailer-a": integrationToken,
            "retailer-b": bToken,
          }),
        },
        ["worker"],
      );
      const origin = "http://" + apiName + ":3000";
      await ready(origin + "/v1/deliveries");
      const submitted = await fetch(origin + "/v1/sales", {
        method: "POST",
        headers: {
          authorization: "Bearer " + tokenA,
          "content-type": "application/json",
        },
        body: JSON.stringify(fixture()),
      });
      assert.equal(submitted.status, 202);
      const sale = (await submitted.json()) as any;
      for (let i = 0; i < 150; i++) {
        const r = await fetch(
          origin + "/v1/deliveries/" + sale.delivery.deliveryId,
          { headers: { authorization: "Bearer " + tokenA } },
        );
        if (((await r.json()) as any).state === "delivered") break;
        await delay(100);
      }
      const receiverEffects = (
        await admin.pool.query(
          "select count(*)::int n from receiver.sales where sale_reference='SALE-0001'",
        )
      ).rows[0].n;
      assert.equal(receiverEffects, 1);
      const runtimeRoles = (
        await admin.pool.query(
          "select distinct usename from pg_stat_activity where datname=current_database() and usename in ('p14_app','p14_receiver') order by usename",
        )
      ).rows.map((r) => r.usename);
      const cli = await oneoff(
        "cli",
        { ...common, DEMO_API_ORIGIN: origin, DEMO_TOKEN: tokenA },
        ["cli", "list", "--json"],
      );
      assert.equal(cli.code, 0);
      assert.ok(!cli.text.includes(tokenA));
      assert.ok(
        JSON.parse(cli.text).some(
          (r: any) => r.deliveryId === sale.delivery.deliveryId,
        ),
      );
      const refused = await oneoff(
        "migration-refused",
        { ...common, DATABASE_URL: extra.appUrl },
        ["migrate"],
      );
      assert.notEqual(refused.code, 0);
      assert.ok(!refused.text.includes(extra.appUrl));
      const seed = await oneoff(
        "seed",
        {
          ...common,
          DATABASE_URL: extra.maintenanceUrl,
          SEED_DATA: JSON.stringify({ application: [], receiver: [] }),
        },
        ["seed"],
      );
      assert.equal(seed.code, 0);
      const migrate = await oneoff(
        "migrate",
        { ...common, DATABASE_URL: extra.maintenanceUrl },
        ["migrate"],
      );
      assert.equal(migrate.code, 0);
      const loadExec = await docker("POST", "/containers/" + api + "/exec", {
        AttachStdout: true,
        AttachStderr: true,
        Cmd: ["node", "dist/src/main.js", "load"],
        Env: [
          "DATABASE_URL=" + extra.maintenanceUrl,
          "DEMO_API_ORIGIN=http://127.0.0.1:3000",
          "LOAD_TOKENS=" + JSON.stringify([tokenA, tokenB]),
        ],
      });
      const loadText = streamText(
        await docker("POST", "/exec/" + loadExec.Id + "/start", {
          Detach: false,
          Tty: false,
        }),
      );
      const loadState = await docker("GET", "/exec/" + loadExec.Id + "/json");
      assert.equal(loadState.ExitCode, 0);
      const load = JSON.parse(loadText.trim());
      assert.equal(load.status, "passed");
      assert.equal(load.uniqueReceiverEffects, 200);
      await writeFile(scratch + "/load.json", JSON.stringify(load, null, 2));
      const exitCodes: number[] = [];
      for (const id of [worker, api, receiver]) {
        await docker("POST", "/containers/" + id + "/stop?t=15");
        exitCodes.push(
          (await docker("GET", "/containers/" + id + "/json")).State.ExitCode,
        );
      }
      const options = {
        mode: "local",
        file: "/scratch/dataset.dump",
        queueConfig: extra.config,
        writersStopped: true,
      };
      await writeFile(scratch + "/backup.json", JSON.stringify(options), {
        mode: 0o600,
      });
      const backup = await oneoff(
        "backup",
        {
          ...common,
          DATABASE_URL: extra.maintenanceUrl,
          BACKUP_CONFIG_FILE: "/scratch/backup.json",
        },
        ["backup"],
      );
      assert.equal(backup.code, 0);
      assert.ok(JSON.parse(backup.text).bytes > 0);
      const evidence = await oneoff(
        "evidence",
        {
          ...common,
          TEST_DATABASE_URL: extra.maintenanceUrl,
          TEST_QUEUE_ENDPOINT: extra.config.localEndpoint!,
          RESULT_DIRECTORY: "/scratch/evidence",
        },
        ["evidence"],
      );
      assert.equal(evidence.code, 0, evidence.text);
      assert.equal(JSON.parse(evidence.text.trim()).status, "passed");
      const node = await oneoff("node", {}, ["--version"], ["node"]);
      const pg = await oneoff("pg", {}, ["--version"], ["pg_dump"]);
      assert.equal(node.code, 0);
      assert.equal(pg.code, 0);
      const inspected = await docker(
        "GET",
        "/images/" + encodeURIComponent(Image) + "/json",
      );
      const result = {
        receiverEffects,
        runtimeRoles,
        exitCodes,
        nodeVersion: node.text.trim(),
        pgVersion: pg.text.trim(),
        migrationRefused: refused.code !== 0,
        imageId: inspected.Id,
        imageBytes: inspected.Size,
        sourceCommit:
          inspected.Config.Labels?.["org.opencontainers.image.revision"],
        evidenceFormat: JSON.parse(evidence.text.trim()).sourceFormat,
        maintenanceModes: [
          "migrate",
          "seed",
          "backup",
          "load",
          "cli",
          "evidence",
        ],
      };
      await writeFile("results/image.json", JSON.stringify(result, null, 2));
      return result;
    });
  } finally {
    for (const id of ids.reverse())
      await docker("DELETE", "/containers/" + id + "?force=true");
  }
}
