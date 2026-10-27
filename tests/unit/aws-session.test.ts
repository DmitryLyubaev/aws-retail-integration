import test from "node:test";
import assert from "node:assert/strict";
import {
  responseIsAbsent,
  supervisorBinding,
  readyMatches,
} from "../../scripts/aws-session.mjs";
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
