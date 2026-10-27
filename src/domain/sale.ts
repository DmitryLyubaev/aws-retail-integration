import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
export interface SaleCompleted {
  schemaVersion: 1;
  type: "SaleCompleted";
  eventId: string;
  saleReference: string;
  occurredAt: string;
  currency: "AUD";
  lines: readonly { sku: string; quantity: number; unitAmount: string }[];
  total: string;
}
export interface AcceptedSale {
  sale: SaleCompleted;
  raw: Buffer;
  rawSha256: string;
  canonical: string;
  businessSha256: string;
}
export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const invalid = (): never => {
  throw new DomainError("invalid_sale", 400);
};
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(record, k))
  )
    return invalid();
  return record;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  )
    return invalid();
  return value;
}
function amount(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,11}$/.test(value))
    return invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    value,
  );
  if (!match) return invalid();
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized)
    return invalid();
  return normalized;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function parseSale(raw: Buffer): AcceptedSale {
  if (raw.length > 65536) throw new DomainError("body_too_large", 413);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new DomainError("invalid_json", 400);
  }
  const root = object(value, [
    "schemaVersion",
    "type",
    "eventId",
    "saleReference",
    "occurredAt",
    "currency",
    "lines",
    "total",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.type !== "SaleCompleted" ||
    root.currency !== "AUD" ||
    !Array.isArray(root.lines) ||
    root.lines.length < 1 ||
    root.lines.length > 20
  )
    return invalid();
  const lines = root.lines.map((value) => {
    const line = object(value, ["sku", "quantity", "unitAmount"]);
    if (
      typeof line.sku !== "string" ||
      line.sku.length < 1 ||
      line.sku.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(line.sku) ||
      typeof line.quantity !== "number" ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0
    )
      return invalid();
    return {
      sku: line.sku,
      quantity: line.quantity,
      unitAmount: amount(line.unitAmount),
    };
  });
  const total = amount(root.total);
  if (
    lines.reduce(
      (sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitAmount),
      0n,
    ) !== BigInt(total)
  )
    return invalid();
  const sale: SaleCompleted = {
    schemaVersion: 1,
    type: "SaleCompleted",
    eventId: id(root.eventId),
    saleReference: id(root.saleReference),
    occurredAt: timestamp(root.occurredAt),
    currency: "AUD",
    lines,
    total,
  };
  const { eventId: _transportId, ...business } = sale;
  const canonical = canonicalJson(business);
  return {
    sale,
    raw: Buffer.from(raw),
    rawSha256: sha256(raw),
    canonical,
    businessSha256: sha256(canonical),
  };
}
