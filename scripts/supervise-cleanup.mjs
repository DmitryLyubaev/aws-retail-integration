import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
export const closureCategories = [
  "compute",
  "database",
  "queues",
  "buckets",
  "secrets",
  "logs",
  "alarms",
  "discovery",
  "network",
  "cleanup",
  "iam",
  "bootstrap",
];
export async function superviseCleanup(config, clients) {
  const sessionId = config.sessionId,
    cleanup = Date.parse(config.cleanupAt),
    end = Date.parse(config.sessionEnd);
  if (
    !/^p14-[a-z0-9][a-z0-9-]{0,23}$/.test(sessionId) ||
    !Number.isFinite(cleanup) ||
    end - cleanup !== 7200000
  )
    throw new Error("supervisor_config");
  while (clients.now() < cleanup) {
    try {
      await clients.heartbeat?.();
    } catch {
      await clients.record({
        closed: false,
        code: "heartbeat_failed",
        at: new Date(clients.now()).toISOString(),
        checks: {},
      });
    }
    await clients.wait(Math.min(5000, cleanup - clients.now()));
  }
  let checks = {};
  do {
    try {
      await clients.cleanup();
    } catch {}
    try {
      await clients.destroy();
    } catch {}
    try {
      checks = await clients.verify();
    } catch {
      checks = {};
    }
    const closed = closureCategories.every((k) => checks[k] === true);
    const result = {
      closed,
      code: closed
        ? clients.now() > end
          ? "closed_late"
          : "closed"
        : "closure_unverified",
      at: new Date(clients.now()).toISOString(),
      checks,
    };
    await clients.record(result);
    if (closed) return result;
    if (clients.now() >= end) return result;
    await clients.wait(Math.min(10000, end - clients.now()));
  } while (clients.now() < end);
  const result = {
    closed: false,
    code: "closure_unverified",
    at: new Date(clients.now()).toISOString(),
    checks,
  };
  await clients.record(result);
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = JSON.parse(
      await readFile(process.argv[2] ?? ".local/supervisor.json", "utf8"),
    );
    const { supervisorClients } = await import("./aws-session.mjs");
    const clients = await supervisorClients(config);
    const result = await superviseCleanup(config, {
      ...clients,
      now: () => Date.now(),
      wait: (ms) => delay(ms),
      record: async (value) => {
        await writeFile(".local/closure.json", JSON.stringify(value, null, 2), {
          mode: 0o600,
        });
        process.stdout.write(
          JSON.stringify({
            code: value.code,
            closed: value.closed,
            at: value.at,
          }) + "\n",
        );
      },
    });
    process.exitCode = result.closed ? 0 : 1;
  } catch {
    process.stderr.write('{"closed":false,"code":"supervisor_failed"}\n');
    process.exitCode = 1;
  }
}
