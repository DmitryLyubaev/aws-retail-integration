import test from "node:test";
import assert from "node:assert/strict";
import { validateDelivery, runDelivery } from "../../scripts/delivery.mjs";
const sourceCommit = "a".repeat(40),
  imageDigest = "sha256:" + "b".repeat(64),
  planSha256 = "c".repeat(64);
const request = {
  action: "apply" as const,
  sourceCommit,
  sessionId: "p14-synthetic",
  imageDigest,
  planKey: `plans/p14-synthetic/${sourceCommit}/plan.bin`,
  planSha256,
};
const inventory = {
  sessionId: request.sessionId,
  sourceCommit,
  imageDigest,
  accountId: "111122223333",
  region: "ap-southeast-2",
  clusterArn: "arn:aws:ecs:ap-southeast-2:111122223333:cluster/p14-synthetic",
  serviceArns: [
    "arn:aws:ecs:ap-southeast-2:111122223333:service/p14-synthetic/p14-synthetic-application",
    "arn:aws:ecs:ap-southeast-2:111122223333:service/p14-synthetic/p14-synthetic-worker",
  ],
  dbIdentifier: "p14-synthetic",
};
const context = {
  eventName: "workflow_dispatch",
  ref: "refs/heads/main",
  repository: "owner/aws-retail-integration",
  approvedRepository: "owner/aws-retail-integration",
  environment: "aws-demo",
  expectedAccount: "111122223333",
  actualAccount: "111122223333",
  region: "ap-southeast-2",
  sourceCommit,
  imageDigest,
  now: "2030-01-01T01:00:00Z",
  cleanupAt: "2030-01-01T04:00:00Z",
  sessionEnd: "2030-01-01T06:00:00Z",
  configSha256: "d".repeat(64),
  savedPlanSha256: planSha256,
  reviewedPlan: true,
  inventory,
  receipt: {
    ...request,
    ref: "refs/heads/main",
    repository: "owner/aws-retail-integration",
    environment: "aws-demo",
    accountId: "111122223333",
    region: "ap-southeast-2",
    configSha256: "d".repeat(64),
    cleanupAt: "2030-01-01T04:00:00Z",
    sessionEnd: "2030-01-01T06:00:00Z",
  },
};
test("a pull request cannot request AWS mutation", async () => {
  let calls = 0;
  const refused = validateDelivery(request, {
    ...context,
    ref: "refs/pull/14/merge",
  });
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "ref");
  const clients = {
    plan: async () => {
      calls++;
    },
    apply: async () => {
      calls++;
    },
    migrate: async () => 0,
    seed: async () => 0,
    start: async () => {
      calls++;
    },
    destroy: async () => {
      calls++;
    },
    cleanup: async () => {
      calls++;
    },
  };
  await runDelivery(
    request,
    { ...context, ref: "refs/pull/14/merge" },
    clients,
  );
  assert.equal(calls, 0);
});
test("delivery binds main dispatch, account, source, image and reviewed exact private plan", () => {
  assert.equal(validateDelivery(request, context).allowed, true);
  for (const change of [
    { eventName: "pull_request" },
    { ref: "refs/heads/feature" },
    { repository: "fork/aws-retail-integration" },
    { actualAccount: "999900001111" },
    { region: "us-east-1" },
    { sourceCommit: "e".repeat(40) },
    { imageDigest: "sha256:" + "e".repeat(64) },
    { savedPlanSha256: "e".repeat(64) },
    { reviewedPlan: false },
    { receipt: undefined },
    { now: "2030-01-01T04:00:00Z" },
    { now: "2029-12-31T23:59:00Z" },
    { receipt: { ...context.receipt, configSha256: "e".repeat(64) } },
    {
      receipt: {
        ...context.receipt,
        repository: "fork/aws-retail-integration",
      },
    },
  ])
    assert.equal(
      validateDelivery(request, { ...context, ...change }).allowed,
      false,
      JSON.stringify(change),
    );
  assert.equal(
    validateDelivery({ ...request, planKey: "plans/foreign/plan.bin" }, context)
      .allowed,
    false,
  );
});
test("failed migration prevents all service starts and invokes independent cleanup", async () => {
  const starts: unknown[] = [],
    cleanup: string[] = [];
  const result = await runDelivery(request, context, {
    plan: async () => {},
    apply: async () => {},
    migrate: async () => 1,
    seed: async () => 0,
    start: async (...args) => {
      starts.push(args);
    },
    destroy: async () => {},
    cleanup: async () => {
      cleanup.push("called");
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "migration_failed");
  assert.deepEqual(starts, []);
  assert.equal(cleanup.length, 1);
});
test("successful migration and seed start exactly one of each owned service", async () => {
  const starts: unknown[] = [];
  const result = await runDelivery(request, context, {
    plan: async () => {},
    apply: async () => {},
    migrate: async () => 0,
    seed: async () => 0,
    start: async (...args) => {
      starts.push(args);
    },
    destroy: async () => {},
    cleanup: async () => {},
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(starts, [
    ["application", 1],
    ["worker", 1],
  ]);
});
test("expired sessions can still clean owned inventory but unknown cleanup targets are refused", () => {
  const destroy = { ...request, action: "destroy" as const };
  const expired = {
    ...context,
    now: "2030-01-01T07:00:00Z",
    imageDigest: undefined,
    receipt: undefined,
  };
  assert.equal(validateDelivery(destroy, expired).allowed, true);
  assert.equal(
    validateDelivery(destroy, { ...expired, inventory: undefined }).code,
    "inventory",
  );
  assert.equal(
    validateDelivery(destroy, {
      ...expired,
      inventory: { ...inventory, dbIdentifier: "foreign" },
    }).allowed,
    false,
  );
  assert.equal(
    validateDelivery(destroy, {
      ...expired,
      inventory: { ...inventory, backupBucket: "p14-foreign-backup" },
    }).allowed,
    false,
  );
});
test("migration crossing the cleanup deadline cannot restart stopped services", async () => {
  let now = context.now,
    starts = 0,
    cleanups = 0;
  const result = await runDelivery(request, context, {
    plan: async () => {},
    apply: async () => {},
    migrate: async () => {
      now = context.cleanupAt;
      return 0;
    },
    seed: async () => 0,
    start: async () => {
      starts++;
    },
    destroy: async () => {},
    cleanup: async () => {
      cleanups++;
    },
    now: () => now,
  });
  assert.equal(result.allowed, false);
  assert.equal(starts, 0);
  assert.equal(cleanups, 1);
});
