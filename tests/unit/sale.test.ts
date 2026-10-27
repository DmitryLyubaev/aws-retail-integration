import test from "node:test";
import assert from "node:assert/strict";
import { parseSale } from "../../src/domain/sale.js";
import { fixture } from "../support/fixture.js";
const encode = (x: unknown) => Buffer.from(JSON.stringify(x));
test("sale retains exact bytes and hand-derived bigint total", () => {
  const raw = encode(fixture());
  const result = parseSale(raw);
  assert.equal(result.sale.total, "2598");
  assert.deepEqual(result.raw, raw);
});
test("transport event IDs and object ordering do not change business identity", () => {
  const first = parseSale(encode(fixture()));
  const alias = parseSale(
    Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(fixture({ eventId: "alias-2" })).reverse(),
        ),
        null,
        2,
      ),
    ),
  );
  assert.equal(alias.businessSha256, first.businessSha256);
  assert.notEqual(alias.rawSha256, first.rawSha256);
});
test("line ordering remains business-significant", () => {
  const lines = [
    { sku: "A", quantity: 1, unitAmount: "1" },
    { sku: "B", quantity: 1, unitAmount: "2" },
  ];
  assert.notEqual(
    parseSale(encode(fixture({ lines, total: "3" }))).businessSha256,
    parseSale(encode(fixture({ lines: [...lines].reverse(), total: "3" })))
      .businessSha256,
  );
});
for (const [name, overrides] of Object.entries({
  unknown: { extra: true },
  currency: { currency: "USD" },
  version: { schemaVersion: 2 },
  calendar: { occurredAt: "2026-02-30T00:00:00.000Z" },
  offset: { occurredAt: "2026-10-27T10:00:00+10:00" },
  empty: { lines: [] },
  many: {
    lines: Array.from({ length: 21 }, () => ({
      sku: "A",
      quantity: 1,
      unitAmount: "1",
    })),
    total: "21",
  },
  zero: { total: "0" },
  leadingZero: { total: "02598" },
  huge: { total: "1000000000000" },
  mismatch: { total: "2599" },
  decimal: { lines: [{ sku: "A", quantity: 1.5, unitAmount: "1" }] },
  negative: { lines: [{ sku: "A", quantity: -1, unitAmount: "1" }] },
  zeroAmount: { lines: [{ sku: "A", quantity: 1, unitAmount: "0" }] },
  unsafe: {
    lines: [{ sku: "A", quantity: 9007199254740992, unitAmount: "1" }],
  },
  nested: { lines: [{ sku: "A", quantity: 1, unitAmount: "1", extra: true }] },
  missing: { eventId: "" },
}))
  test(`rejects ${name} input rather than coercing it`, () =>
    assert.throws(() => parseSale(encode(fixture(overrides))), {
      code: "invalid_sale",
    }));
test("supports twenty lines and the twelve-digit minor-unit boundary exactly", () => {
  assert.equal(
    parseSale(
      encode(
        fixture({
          lines: Array.from({ length: 20 }, () => ({
            sku: "A",
            quantity: 1,
            unitAmount: "1",
          })),
          total: "20",
        }),
      ),
    ).sale.total,
    "20",
  );
  assert.equal(
    parseSale(
      encode(
        fixture({
          lines: [{ sku: "A", quantity: 1, unitAmount: "999999999999" }],
          total: "999999999999",
        }),
      ),
    ).sale.total,
    "999999999999",
  );
});
test("body limit counts bytes and rejects invalid UTF-8/JSON", () => {
  const body = encode(fixture());
  assert.equal(
    parseSale(Buffer.concat([body, Buffer.alloc(65536 - body.length, 32)])).sale
      .total,
    "2598",
  );
  assert.throws(() => parseSale(Buffer.alloc(65537, 32)), {
    code: "body_too_large",
  });
  assert.throws(() => parseSale(Buffer.from([0xff])), { code: "invalid_json" });
  assert.throws(() => parseSale(Buffer.from("{")), { code: "invalid_json" });
});
