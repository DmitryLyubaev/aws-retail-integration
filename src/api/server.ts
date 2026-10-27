import type { Db } from "../db/connect.js";
import { requirePermission } from "../db/credentials.js";
import { acceptSale } from "../db/accept.js";
import { getDelivery, getHistory, listDeliveries } from "../db/deliveries.js";
import { replayDelivery } from "../db/replay.js";
import { DomainError } from "../domain/errors.js";
import { parseSale } from "../domain/sale.js";
import { rawHttp, bodyObject, bearer, type RunningHttp } from "../http.js";
import { authenticateRequest } from "./auth.js";
import { observe, telemetry } from "../operations/observe.js";
export async function startApi(deps: {
  db: Db;
  host: string;
  port: number;
  demoMode: boolean;
  receiverOrigin: string;
}): Promise<RunningHttp> {
  const app = rawHttp();
  const auth = (header: unknown) => authenticateRequest(deps.db, header);
  app.post("/v1/sales", async (req, reply) => {
    const ctx = await auth(req.headers.authorization);
    const result = await acceptSale(
      deps.db,
      ctx,
      parseSale(req.body as Buffer),
    );
    if (!result.duplicate) {
      await observe(deps.db, { accepted: 1 });
      telemetry.log({
        component: "api",
        code: "accepted",
        tenantId: ctx.tenantId,
        deliveryId: result.delivery.deliveryId,
        generation: result.delivery.generation,
      });
    }
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });
  app.get<{ Querystring: Record<string, unknown> }>(
    "/v1/deliveries",
    async (req) => {
      const ctx = await auth(req.headers.authorization);
      const q = req.query;
      if (
        Object.keys(q).some((k) => !["after", "limit"].includes(k)) ||
        (q.after !== undefined && typeof q.after !== "string") ||
        (q.limit !== undefined &&
          (typeof q.limit !== "string" || !/^\d+$/.test(q.limit)))
      )
        throw new DomainError("invalid_pagination", 400);
      return listDeliveries(
        deps.db,
        ctx,
        (q.after as string) ?? null,
        q.limit === undefined ? 20 : Number(q.limit),
      );
    },
  );
  app.get<{ Params: { id: string } }>("/v1/deliveries/:id", async (req) => {
    const result = await getDelivery(
      deps.db,
      await auth(req.headers.authorization),
      req.params.id,
    );
    if (!result) throw new DomainError("not_found", 404);
    return result;
  });
  app.get<{ Params: { id: string } }>(
    "/v1/deliveries/:id/history",
    async (req) => {
      const ctx = await auth(req.headers.authorization);
      if (!(await getDelivery(deps.db, ctx, req.params.id)))
        throw new DomainError("not_found", 404);
      return getHistory(deps.db, ctx, req.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/deliveries/:id/replay",
    async (req) => {
      const ctx = await auth(req.headers.authorization);
      const input = bodyObject(req.body, ["expectedGeneration", "requestId"]);
      return replayDelivery(
        deps.db,
        ctx,
        req.params.id,
        input.expectedGeneration as number,
        input.requestId as string,
      );
    },
  );
  app.put<{ Params: { saleReference: string } }>(
    "/v1/demo/faults/:saleReference",
    async (req) => {
      if (!deps.demoMode) throw new DomainError("not_found", 404);
      const ctx = await auth(req.headers.authorization);
      requirePermission(ctx, "fault");
      const input = bodyObject(req.body, ["mode"]);
      if (
        ![
          "accept",
          "reject_422",
          "transient_503_once",
          "commit_drop_once",
        ].includes(input.mode as string)
      )
        throw new DomainError("invalid_fault", 400);
      const response = await fetch(
        new URL(
          "/demo/faults/" + encodeURIComponent(req.params.saleReference),
          deps.receiverOrigin,
        ),
        {
          method: "PUT",
          redirect: "manual",
          headers: {
            authorization: "Bearer " + bearer(req.headers.authorization),
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(5000),
        },
      );
      await response.body?.cancel();
      if (!response.ok) throw new DomainError("receiver_fault_failed", 502);
      return { ok: true };
    },
  );
  const origin = await app.listen({ host: deps.host, port: deps.port });
  return { origin, close: () => app.close() };
}
