import test from "node:test";
import assert from "node:assert/strict";
import {
  superviseCleanup,
  closureCategories,
} from "../../scripts/supervise-cleanup.mjs";
const config = {
  sessionId: "p14-synthetic",
  cleanupAt: "2030-01-01T04:00:00Z",
  sessionEnd: "2030-01-01T06:00:00Z",
};
test("supervisor starts at hour four and cannot extend its captured deadline", async () => {
  let now = Date.parse("2030-01-01T03:59:59Z"),
    cleanups = 0,
    destroys = 0;
  const input = { ...config };
  const result = await superviseCleanup(input, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
      input.sessionEnd = "2030-01-02T06:00:00Z";
    },
    cleanup: async () => {
      cleanups++;
    },
    destroy: async () => {
      destroys++;
    },
    verify: async () =>
      Object.fromEntries(closureCategories.map((k) => [k, true])),
    record: async () => {},
  });
  assert.equal(result.closed, true);
  assert.equal(cleanups, 1);
  assert.equal(destroys, 1);
  assert.ok(now >= Date.parse(config.cleanupAt));
  assert.ok(now < Date.parse(config.sessionEnd));
});
test("failed readiness heartbeats remain visible while absolute cleanup still runs", async () => {
  let now = Date.parse(config.cleanupAt) - 10000,
    heartbeats = 0,
    cleanup = 0;
  const records: any[] = [];
  const result = await superviseCleanup(config, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    heartbeat: async () => {
      heartbeats++;
      throw new Error("injected");
    },
    cleanup: async () => {
      cleanup++;
    },
    destroy: async () => {},
    verify: async () =>
      Object.fromEntries(closureCategories.map((k) => [k, true])),
    record: async (r) => {
      records.push(r);
    },
  });
  assert.ok(heartbeats > 0);
  assert.equal(cleanup, 1);
  assert.equal(result.closed, true);
  assert.ok(records.some((r) => r.code === "heartbeat_failed"));
});
test("supervisor retries partial cleanup, attempts destroy despite a failed fallback and reports unfinished closure", async () => {
  let now = Date.parse(config.cleanupAt),
    attempts = 0,
    destroys = 0;
  const result = await superviseCleanup(config, {
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
    cleanup: async () => {
      attempts++;
      throw new Error("injected");
    },
    destroy: async () => {
      destroys++;
    },
    verify: async () => ({}),
    record: async () => {},
  });
  assert.equal(result.closed, false);
  assert.equal(result.code, "closure_unverified");
  assert.ok(attempts > 1);
  assert.equal(destroys, attempts);
  assert.equal(now, Date.parse(config.sessionEnd));
});
