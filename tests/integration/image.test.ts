import test from "node:test";
import assert from "node:assert/strict";
import { imageSmoke } from "../support/image-smoke.js";
test(
  "built runtime image delivers with separate SQL roles and shuts down on SIGTERM",
  { skip: process.env.IMAGE_SMOKE !== "true", timeout: 360000 },
  async () => {
    const result = await imageSmoke();
    assert.equal(result.receiverEffects, 1);
    assert.deepEqual(result.runtimeRoles, ["p14_app", "p14_receiver"]);
    assert.deepEqual(result.exitCodes, [0, 0, 0]);
    assert.match(result.nodeVersion, /v24\.22\.1/);
    assert.match(result.pgVersion, /17\./);
    assert.equal(result.migrationRefused, true);
  },
);
