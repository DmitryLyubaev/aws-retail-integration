import type { Db } from "../db/connect.js";
import { uuidPattern } from "../db/deliveries.js";
import { parseSale } from "../domain/sale.js";
import { DomainError } from "../domain/errors.js";
import { rawHttp, bearer, bodyObject, type RunningHttp } from "../http.js";
import { authenticateReceiver, recordSale } from "./store.js";
import { setFault, type FaultMode } from "./faults.js";
export async function startReceiver(deps: {
  db: Db;
  host: string;
  port: number;
  demoMode: boolean;
}): Promise<RunningHttp> {
  const app = rawHttp();
  app.post("/sales", async (request, reply) => {
    const ctx = await authenticateReceiver(
      deps.db,
      bearer(request.headers.authorization),
      "integration",
    );
    const id = request.headers["x-delivery-id"];
    if (typeof id !== "string" || !uuidPattern.test(id))
      throw new DomainError("invalid_delivery_id", 400);
    const event = parseSale(request.body as Buffer);
    const result = await recordSale(deps.db, ctx, id, event);
    if (result.kind === "refusal")
      return reply.code(result.status).send({ code: result.code });
    if (result.dropResponse) {
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    return result.receipt;
  });
  app.put<{ Params: { saleReference: string } }>(
    "/demo/faults/:saleReference",
    async (request) => {
      if (!deps.demoMode) throw new DomainError("not_found", 404);
      const ctx = await authenticateReceiver(
        deps.db,
        bearer(request.headers.authorization),
        "operator",
      );
      const input = bodyObject(request.body, ["mode"]);
      await setFault(
        deps.db,
        ctx,
        request.params.saleReference,
        input.mode as FaultMode,
      );
      return { ok: true };
    },
  );
  const origin = await app.listen({ host: deps.host, port: deps.port });
  return { origin, close: () => app.close() };
}
