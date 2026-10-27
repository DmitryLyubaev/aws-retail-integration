import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateObservation,
  reportFromObservations,
} from "../../src/operations/evidence.js";
import manifest from "../../fixtures/manifest.json" with { type: "json" };
test("offline evidence cannot claim AWS completion and rejects altered or skipped checks", () => {
  const observations = manifest.cases.map((c) => ({
    caseId: c.caseId,
    checks: Object.fromEntries(c.checks.map((k) => [k, true])),
    effects: 200,
    tenantLeak: false,
    originalDigestUnchanged: true,
    childRestarted: true,
    submissionCount: 240,
  }));
  const report = reportFromObservations(
    observations,
    "a".repeat(64),
    "b".repeat(64),
  );
  assert.equal(report.cases.find((c) => c.caseId === "A12")?.status, "not_run");
  assert.equal(
    report.cases.find((c) => c.caseId === "A7" && c.mode === "aws")?.status,
    "not_run",
  );
  assert.equal(report.status, "passed");
  for (const change of [
    { effects: 199 },
    { tenantLeak: true },
    { originalDigestUnchanged: false },
    { childRestarted: false },
    { checks: {} },
    { submissionCount: 239 },
  ])
    assert.equal(evaluateObservation({ ...observations[9], ...change }), false);
  assert.equal(
    reportFromObservations(
      observations.slice(1),
      "a".repeat(64),
      "b".repeat(64),
    ).status,
    "failed",
  );
});
