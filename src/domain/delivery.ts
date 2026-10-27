import type { AcceptedSale } from "./sale.js";
export type Permission = "submit" | "read" | "replay" | "fault";
export interface TenantContext {
  tenantId: string;
  actorId: string;
  permissions: readonly Permission[];
}
export interface DeliveryRef {
  tenantId: string;
  deliveryId: string;
  generation: number;
}
export interface QueueEnvelope extends DeliveryRef {
  schemaVersion: 1;
  businessSha256: string;
}
export type DeliveryState =
  "pending" | "delivering" | "retry_wait" | "delivered" | "failed";
export interface DeliveryView extends DeliveryRef {
  saleReference: string;
  state: DeliveryState;
  failureCode: string | null;
  attempts: number;
  deadlineAt: string;
}
export interface Acceptance {
  delivery: DeliveryView;
  duplicate: boolean;
}
export interface ReceiverReceipt {
  deliveryId: string;
  saleReference: string;
  businessSha256: string;
  total: string;
}
export interface AuditEntry {
  id: string;
  at: string;
  generation: number;
  kind: string;
  code: string | null;
  attemptId: string | null;
}
export interface Clock {
  now(): Date;
}
export type FaultHook = (point: string) => Promise<void>;
export interface AttemptClaim extends DeliveryRef {
  attemptId: string;
  fence: string;
  leaseUntil: string;
  deadlineAt: string;
  event: AcceptedSale;
}
export type AttemptOutcome =
  | { kind: "success"; receipt: ReceiverReceipt }
  | {
      kind: "transient" | "permanent" | "unknown";
      code: string;
      retryAt?: string;
    };
