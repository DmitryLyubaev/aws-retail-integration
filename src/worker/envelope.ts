import type { QueueEnvelope } from "../domain/delivery.js";
import { uuidPattern } from "../db/deliveries.js";
import { DomainError } from "../domain/errors.js";
export function parseEnvelope(body: string): QueueEnvelope {
  if (Buffer.byteLength(body) > 4096)
    throw new DomainError("invalid_envelope", 400);
  let e: any;
  try {
    e = JSON.parse(body);
  } catch {
    throw new DomainError("invalid_envelope", 400);
  }
  if (
    !e ||
    typeof e !== "object" ||
    Array.isArray(e) ||
    Object.keys(e).sort().join(",") !==
      "businessSha256,deliveryId,generation,schemaVersion,tenantId" ||
    e.schemaVersion !== 1 ||
    typeof e.tenantId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(e.tenantId) ||
    typeof e.deliveryId !== "string" ||
    !uuidPattern.test(e.deliveryId) ||
    !Number.isInteger(e.generation) ||
    e.generation < 1 ||
    e.generation > 2147483647 ||
    typeof e.businessSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(e.businessSha256)
  )
    throw new DomainError("invalid_envelope", 400);
  return e;
}
