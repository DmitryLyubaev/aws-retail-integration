import Fastify from "fastify";
import { DomainError } from "./domain/errors.js";
export interface RunningHttp {
  origin: string;
  close(): Promise<void>;
}
export function rawHttp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.setErrorHandler((error, request, reply) => {
    const e = error as { code?: string; statusCode?: number };
    const code =
      error instanceof DomainError
        ? error.code
        : e.code === "FST_ERR_CTP_BODY_TOO_LARGE"
          ? "body_too_large"
          : e.statusCode === 415
            ? "unsupported_media_type"
            : "internal_error";
    const status =
      error instanceof DomainError
        ? error.status
        : code === "body_too_large"
          ? 413
          : code === "unsupported_media_type"
            ? 415
            : 500;
    void reply.code(status).send({ code, requestId: request.id });
  });
  return app;
}
export function bearer(header: unknown): string {
  if (
    typeof header !== "string" ||
    !header.startsWith("Bearer ") ||
    header.length > 263
  )
    throw new DomainError("unauthorised", 401);
  return header.slice(7);
}
export function bodyObject(
  body: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body as Buffer),
    );
  } catch {
    throw new DomainError("invalid_json", 400);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new DomainError("invalid_request", 400);
  return value as Record<string, unknown>;
}
