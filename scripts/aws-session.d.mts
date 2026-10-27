export function responseIsAbsent(
  result: { code: number | null; stdout: string; stderr: string },
  empty: (value: any) => boolean,
): boolean;
export function supervisorBinding(config: any): boolean;
export function readyMatches(request: any, context: any, ready: any): boolean;
