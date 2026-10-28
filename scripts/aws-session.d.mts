export function responseIsAbsent(
  result: { code: number | null; stdout: string; stderr: string },
  empty: (value: any) => boolean,
  allowEmptyOutput?: boolean,
): boolean;
export function verifyClosure(config: any): Promise<Record<string, boolean>>;
export function exportPrivateFailureEvidence(config: any): Promise<void>;
export function supervisorBinding(config: any): boolean;
export function readyMatches(request: any, context: any, ready: any): boolean;
export function sessionTimes(start: number): {
  cleanupAt: string;
  sessionEnd: string;
};
export function command(
  binary: string,
  args: string[],
  options?: any,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}>;
export function transferCleanupArchive(
  action: "plan" | "apply",
  options: {
    stateBucket: string;
    planKey: string;
    planFile: string;
    archiveFile?: string;
  },
  run?: typeof command,
): Promise<void>;
export function terraformOperation(
  context: any,
  operation: string,
  args: string[],
  log: string,
  run?: typeof command,
  now?: () => number,
): Promise<string>;
export function destroyPhases(
  clients: {
    session(): Promise<void>;
    bootstrap(): Promise<void>;
    recordSession(): Promise<void>;
  },
  resumed?: boolean,
): () => Promise<void>;
