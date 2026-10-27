import type { SaleCompleted } from "../../src/domain/sale.js";
export function fixture(
  overrides: Record<string, unknown> = {},
): SaleCompleted {
  return {
    schemaVersion: 1,
    type: "SaleCompleted",
    eventId: "EVENT-0001",
    saleReference: "SALE-0001",
    occurredAt: "2026-10-27T00:00:00.000Z",
    currency: "AUD",
    lines: [{ sku: "WIDGET-A", quantity: 2, unitAmount: "1299" }],
    total: "2598",
    ...overrides,
  } as SaleCompleted;
}
