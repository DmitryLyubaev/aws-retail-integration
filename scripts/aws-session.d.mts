export function responseIsAbsent(
  result: { code: number | null; stdout: string; stderr: string },
  empty: (value: any) => boolean,
): boolean;
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
