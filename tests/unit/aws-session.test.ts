import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  responseIsAbsent,
  supervisorBinding,
  readyMatches,
  sessionTimes,
  command,
  terraformOperation,
  destroyPhases,
} from "../../scripts/aws-session.mjs";

test("generated workflow deadlines have canonical Terraform second-resolution timestamps", () => {
  assert.deepEqual(
    sessionTimes(Date.parse("2030-01-01T00:00:00Z")),
    JSON.parse(readFileSync("infra/session/tests/workflow-times.json", "utf8")),
  );
  assert.throws(() => sessionTimes(Date.parse("2030-01-01T00:00:00.123Z")));
});

test("Terraform provisioning gets a bounded allowance exceeding normal RDS creation", async () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const context = sessionTimes(now);
  const timeouts: number[] = [];
  const run: typeof command = async (_bin, _args, options) => {
    timeouts.push(options.timeout);
    return { code: 0, stdout: "ok", stderr: "" };
  };
  await terraformOperation(context, "apply", [], "unused", run, () => now);
  assert.ok(timeouts[0]! >= 20 * 60000);
  await terraformOperation(
    context,
    "apply",
    [],
    "unused",
    run,
    () => Date.parse(context.cleanupAt) - 10000,
  );
  assert.equal(timeouts[1], 10000);
  await terraformOperation(
    context,
    "destroy",
    [],
    "unused",
    run,
    () => Date.parse(context.sessionEnd) - 5000,
  );
  assert.equal(timeouts[2], 5000);
  await assert.rejects(
    terraformOperation(context, "apply", [], "unused", run, () =>
      Date.parse(context.cleanupAt),
    ),
    /deadline/,
  );
  await assert.rejects(
    terraformOperation(
      context,
      "apply",
      [],
      "unused",
      async () => ({ code: null, timedOut: true, stdout: "", stderr: "" }),
      () => now,
    ),
    /timeout/,
  );
});

test(
  "an interrupted subprocess that ignores SIGTERM is killed by its hard timeout",
  { timeout: 5000 },
  async () => {
    const start = Date.now();
    const result = await command(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { timeout: 400 },
    );
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - start < 2000);
  },
);

test("bootstrap destroy resumes after its state bucket was removed without reinitializing the session", async () => {
  let bucket = true,
    sessionCalls = 0,
    bootstrapCalls = 0,
    recorded = false;
  const clients = {
    session: async () => {
      sessionCalls++;
      if (!bucket) throw new Error("backend_bucket_absent");
    },
    recordSession: async () => {
      recorded = true;
    },
    bootstrap: async () => {
      bootstrapCalls++;
      bucket = false;
      if (bootstrapCalls === 1) throw new Error("partial_bootstrap");
    },
  };
  const destroy = destroyPhases(clients);
  await assert.rejects(destroy(), /partial_bootstrap/);
  await destroy();
  assert.equal(sessionCalls, 1);
  assert.equal(bootstrapCalls, 2);
  assert.equal(recorded, true);
  await destroyPhases(clients, recorded)(); // A new supervisor resumes its private receipt.
  assert.equal(sessionCalls, 1);
  assert.equal(bootstrapCalls, 3);
});
test("closure probes recognize absent resources while access and transport errors remain unverified", () => {
  for (const code of [
    "404",
    "NoSuchBucket",
    "InvalidVpcID.NotFound",
    "RepositoryNotFoundException",
    "ResourceNotFoundException",
  ])
    assert.equal(
      responseIsAbsent(
        {
          code: 254,
          stdout: "",
          stderr: "An error occurred (" + code + ") when calling the operation",
        },
        () => false,
      ),
      true,
    );
  for (const code of ["403", "AccessDenied", "ExpiredToken", "Timeout"])
    assert.equal(
      responseIsAbsent(
        { code: 254, stdout: "", stderr: "An error occurred (" + code + ")" },
        () => false,
      ),
      false,
    );
  assert.equal(
    responseIsAbsent(
      { code: 0, stdout: '{"items":[]}', stderr: "" },
      (r) => r.items.length === 0,
    ),
    true,
  );
  assert.equal(
    responseIsAbsent({ code: 0, stdout: "bad JSON", stderr: "" }, () => true),
    false,
  );
});
test("apply requires a fresh supervisor heartbeat bound to this plan and account", () => {
  const request = {
    sessionId: "p14-synthetic",
    sourceCommit: "a".repeat(40),
    imageDigest: "sha256:" + "b".repeat(64),
  };
  const context = {
    actualAccount: "111122223333",
    configSha256: "c".repeat(64),
    cleanupAt: "2030-01-01T04:00:00Z",
    sessionEnd: "2030-01-01T06:00:00Z",
    now: "2030-01-01T01:00:00Z",
  };
  const ready = {
    ...request,
    accountId: context.actualAccount,
    configSha256: context.configSha256,
    cleanupAt: context.cleanupAt,
    sessionEnd: context.sessionEnd,
    at: "2030-01-01T00:59:45Z",
  };
  assert.equal(readyMatches(request, context, ready), true);
  for (const change of [
    { sessionId: "p14-foreign" },
    { sourceCommit: "f".repeat(40) },
    { at: "2030-01-01T00:58:00Z" },
    { accountId: "999900001111" },
    { sessionEnd: "2030-01-02T06:00:00Z" },
  ])
    assert.equal(
      readyMatches(request, context, { ...ready, ...change }),
      false,
    );
});
test("live supervisor cannot replace the plan-bound session or cleanup deadlines", () => {
  const config = {
    sessionId: "p14-synthetic",
    cleanupAt: "2030-01-01T04:00:00Z",
    sessionEnd: "2030-01-01T06:00:00Z",
    request: { sessionId: "p14-synthetic" },
    context: {
      cleanupAt: "2030-01-01T04:00:00Z",
      sessionEnd: "2030-01-01T06:00:00Z",
    },
  };
  assert.equal(supervisorBinding(config), true);
  assert.equal(
    supervisorBinding({ ...config, sessionEnd: "2030-01-02T06:00:00Z" }),
    false,
  );
  assert.equal(supervisorBinding({ ...config, sessionId: "p14-other" }), false);
});
