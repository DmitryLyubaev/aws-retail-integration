import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupCostDrivers,
  type CleanupClients,
} from "../../src/operations/cleanup.js";
const config = {
  sessionId: "p14-synthetic",
  clusterArn: "arn:aws:ecs:ap-southeast-2:111122223333:cluster/p14-synthetic",
  serviceArns: [
    "arn:aws:ecs:ap-southeast-2:111122223333:service/p14-synthetic/p14-synthetic-application",
    "arn:aws:ecs:ap-southeast-2:111122223333:service/p14-synthetic/p14-synthetic-worker",
  ],
  dbIdentifier: "p14-synthetic",
};
function fake(
  options: { foreign?: boolean; absent?: boolean; deleting?: boolean } = {},
) {
  const calls: string[] = [];
  let deleted = false;
  const clients: CleanupClients = {
    inspectCluster: async () =>
      options.absent
        ? null
        : { sessionId: options.foreign ? "other" : config.sessionId },
    inspectService: async () =>
      options.absent ? null : { sessionId: config.sessionId },
    scaleZero: async (arn) => {
      calls.push("scale:" + arn);
    },
    listTasks: async () =>
      options.absent
        ? []
        : [config.clusterArn.replace("cluster/", "task/") + "/task1"],
    inspectTask: async () => ({
      sessionId: config.sessionId,
      clusterArn: config.clusterArn,
    }),
    stopTask: async (arn) => {
      calls.push("stop:" + arn);
    },
    inspectDatabase: async () =>
      options.absent || (deleted && !options.deleting)
        ? null
        : {
            sessionId: config.sessionId,
            status: deleted ? "deleting" : "available",
          },
    deleteDatabase: async () => {
      deleted = true;
      calls.push("delete");
    },
  };
  return { calls, clients };
}
test("cleanup scales owned services, stops dedicated tasks and confirms deletion", async () => {
  const { calls, clients } = fake();
  const result = await cleanupCostDrivers(config, clients);
  assert.equal(result.databaseAbsent, true);
  assert.equal(calls.filter((c) => c.startsWith("scale:")).length, 2);
  assert.ok(calls.includes("delete"));
});
test("cleanup is idempotent for absent partial creation and refuses foreign ownership", async () => {
  const absent = fake({ absent: true });
  assert.equal(
    (await cleanupCostDrivers(config, absent.clients)).databaseAbsent,
    true,
  );
  assert.equal(absent.calls.length, 0);
  const foreign = fake({ foreign: true });
  await assert.rejects(cleanupCostDrivers(config, foreign.clients), {
    code: "cleanup_ownership",
  });
  assert.equal(foreign.calls.length, 0);
  await assert.rejects(
    cleanupCostDrivers({ ...config, dbIdentifier: "foreign" }, fake().clients),
    { code: "cleanup_inventory" },
  );
});
test("unfinished database deletion fails visibly and a later retry can finish", async () => {
  const deleting = fake({ deleting: true });
  await assert.rejects(cleanupCostDrivers(config, deleting.clients), {
    code: "cleanup_incomplete",
  });
  assert.equal(
    (await cleanupCostDrivers(config, fake({ absent: true }).clients))
      .databaseAbsent,
    true,
  );
});
test("cleanup validates database ownership before any service mutation and tolerates a missing service", async () => {
  const foreign = fake();
  foreign.clients.inspectDatabase = async () => ({
    sessionId: "foreign",
    status: "available",
  });
  await assert.rejects(cleanupCostDrivers(config, foreign.clients), {
    code: "cleanup_ownership",
  });
  assert.equal(foreign.calls.length, 0);
  const partial = fake();
  partial.clients.inspectService = async (arn) =>
    arn.endsWith("worker") ? null : { sessionId: config.sessionId };
  const result = await cleanupCostDrivers(config, partial.clients);
  assert.equal(result.servicesScaled, 1);
  assert.equal(result.databaseAbsent, true);
});
