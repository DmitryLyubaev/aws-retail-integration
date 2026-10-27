import test from "node:test";
import assert from "node:assert/strict";
import { createTelemetry } from "../../src/telemetry.js";
test("telemetry has five metrics, one session dimension and drops arbitrary secrets", () => {
  const lines: string[] = [];
  const t = createTelemetry("p14-local", (s) => lines.push(s));
  t.log({
    component: "worker",
    code: "receiver_http_422",
    deliveryId: "123",
    token: "secret",
    dsn: "postgres://private",
    payload: { private: true },
  } as any);
  t.metrics({
    accepted: 1,
    delivered: 1,
    retry: 0,
    failed: 0,
    "outbox-pending": 0,
  });
  assert.ok(!lines.join("").includes("secret"));
  assert.ok(!lines.join("").includes("private"));
  const emf = JSON.parse(lines[1]);
  assert.deepEqual(emf._aws.CloudWatchMetrics[0].Dimensions, [["SessionId"]]);
  assert.equal(emf._aws.CloudWatchMetrics[0].Metrics.length, 5);
  assert.throws(() => t.metrics({ accepted: NaN } as any));
});
