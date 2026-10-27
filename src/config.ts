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
export function databaseConnection(
  env: NodeJS.ProcessEnv,
  mode?: Mode,
): string {
  let url: URL;
  try {
    if (env.DATABASE_URL) url = new URL(env.DATABASE_URL);
    else {
      if (
        !env.DATABASE_HOST ||
        !env.DATABASE_USER ||
        !env.DATABASE_PASSWORD ||
        !env.DATABASE_NAME
      )
        throw new DomainError("database_required", 400);
      url = new URL("postgresql://placeholder:5432");
      url.hostname = env.DATABASE_HOST;
      url.username = env.DATABASE_USER;
      url.password = env.DATABASE_PASSWORD;
      url.pathname = "/" + env.DATABASE_NAME;
      url.search = env.DATABASE_OPTIONS ?? "";
    }
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("invalid_database_config", 400);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new DomainError("invalid_database_config", 400);
  if (env.AWS_MODE === "true") {
    if (
      !url.hostname.endsWith(".ap-southeast-2.rds.amazonaws.com") ||
      (url.port && url.port !== "5432") ||
      url.searchParams.get("sslmode") !== "verify-full" ||
      url.searchParams.get("sslrootcert") !== "/app/config/rds-ca.pem" ||
      [...url.searchParams.keys()].length !== 2 ||
      url.hash
    )
      throw new DomainError("invalid_database_tls", 400);
    const expected =
      mode === "receiver"
        ? "p14_receiver"
        : mode === "api" || mode === "worker"
          ? "p14_app"
          : null;
    if (expected && decodeURIComponent(url.username) !== expected)
      throw new DomainError("invalid_database_role", 400);
  }
  return url.href;
}
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
