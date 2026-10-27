export const closureCategories: readonly string[];
export interface SupervisorConfig {
  sessionId: string;
  cleanupAt: string;
  sessionEnd: string;
}
export interface SupervisorClients {
  now(): number;
  wait(ms: number): Promise<void>;
  cleanup(): Promise<void>;
  destroy(): Promise<void>;
  verify(): Promise<Record<string, boolean>>;
  record(result: unknown): Promise<void>;
  heartbeat?(): Promise<void>;
}
export function superviseCleanup(
  config: SupervisorConfig,
  clients: SupervisorClients,
): Promise<{
  closed: boolean;
  code: string;
  at: string;
  checks: Record<string, boolean>;
}>;
