export interface DeliveryRequest {
  action: "plan" | "apply" | "destroy";
  sourceCommit: string;
  sessionId: string;
  imageDigest: string;
  planKey?: string;
  planSha256?: string;
}
export interface Inventory {
  sessionId: string;
  sourceCommit: string;
  imageDigest: string;
  accountId: string;
  region: string;
  clusterArn: string;
  serviceArns: readonly string[];
  dbIdentifier: string;
  backupBucket?: string;
}
export interface DeliveryContext {
  eventName: string;
  ref: string;
  repository: string;
  approvedRepository: string;
  environment: string;
  expectedAccount: string;
  actualAccount?: string;
  region: string;
  sourceCommit: string;
  imageDigest?: string;
  now: string;
  cleanupAt: string;
  sessionEnd: string;
  configSha256: string;
  savedPlanSha256?: string;
  reviewedPlan?: boolean;
  inventory?: Inventory;
  receipt?: Record<string, unknown>;
}
export interface DeliveryDecision {
  allowed: boolean;
  code: string;
}
export interface DeliveryClients {
  plan(): Promise<void>;
  apply(): Promise<void>;
  migrate(): Promise<number>;
  seed(): Promise<number>;
  start(service: "application" | "worker", count: 1): Promise<void>;
  destroy(): Promise<void>;
  cleanup(): Promise<void>;
  now?(): string;
}
export function validateDispatch(
  request: DeliveryRequest,
  context: DeliveryContext,
): DeliveryDecision;
export function validateDelivery(
  request: DeliveryRequest,
  context: DeliveryContext,
): DeliveryDecision;
export function runDelivery(
  request: DeliveryRequest,
  context: DeliveryContext,
  clients: DeliveryClients,
): Promise<DeliveryDecision>;
