import { DomainError } from "./domain/errors.js";
export const modes = [
  "api",
  "receiver",
  "worker",
  "migrate",
  "seed",
  "cli",
  "backup",
  "load",
  "evidence",
] as const;
export type Mode = (typeof modes)[number];
export function readConfig(mode: string, env: NodeJS.ProcessEnv = process.env) {
  if (!modes.includes(mode as Mode)) throw new DomainError("invalid_mode", 400);
  const aws = env.AWS_MODE === "true",
    host = env.API_HOST ?? "127.0.0.1",
    region = env.AWS_REGION ?? "ap-southeast-2";
  if (
    aws &&
    (region !== "ap-southeast-2" ||
      !["127.0.0.1", "::1", "localhost"].includes(host) ||
      env.QUEUE_ENDPOINT ||
      env.AWS_ENDPOINT_URL ||
      Object.keys(env).some((k) => k.startsWith("AWS_ENDPOINT_URL_")) ||
      env.AWS_ACCESS_KEY_ID ||
      env.AWS_SECRET_ACCESS_KEY ||
      env.AWS_PROFILE)
  )
    throw new DomainError("invalid_aws_config", 400);
  const port = Number(env.PORT ?? (mode === "receiver" ? 3001 : 3000));
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new DomainError("invalid_port", 400);
  return {
    mode: mode as Mode,
    aws,
    host: mode === "receiver" ? (env.RECEIVER_HOST ?? "127.0.0.1") : host,
    port,
    region,
    demoMode: env.DEMO_MODE === "true",
    receiverOrigin: env.RECEIVER_ORIGIN ?? "http://127.0.0.1:3001",
  };
}
