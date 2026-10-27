import type { Db } from "../db/connect.js";
import { authenticate } from "../db/credentials.js";
import { bearer } from "../http.js";
import { DomainError } from "../domain/errors.js";
export async function authenticateRequest(db: Db, header: unknown) {
  const ctx = await authenticate(db, bearer(header));
  if (!ctx) throw new DomainError("unauthorised", 401);
  return ctx;
}
