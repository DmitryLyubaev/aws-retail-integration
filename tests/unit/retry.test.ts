import test from "node:test";
import assert from "node:assert/strict";
import { retryAt } from "../../src/worker/consumer.js";
test("Retry-After respects valid seconds/dates without resetting the absolute deadline", () => {
  const now = new Date("2026-10-27T00:00:00.000Z"),
    deadline = new Date("2026-10-27T00:05:00.000Z");
  assert.equal(retryAt(null, 1, now, deadline), "2026-10-27T00:00:02.000Z");
  assert.equal(retryAt("10", 1, now, deadline), "2026-10-27T00:00:10.000Z");
  assert.equal(
    retryAt("Tue, 27 Oct 2026 00:00:12 GMT", 1, now, deadline),
    "2026-10-27T00:00:12.000Z",
  );
  assert.equal(
    retryAt("9999999999", 1, now, deadline),
    "2026-10-27T00:05:00.000Z",
  );
  for (const header of ["bad", "-3", "2.5", "Infinity"])
    assert.equal(retryAt(header, 2, now, deadline), "2026-10-27T00:00:05.000Z");
});
