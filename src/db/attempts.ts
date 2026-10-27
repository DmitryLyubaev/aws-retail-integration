import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  DeliveryRef,
  AttemptClaim,
  AttemptOutcome,
} from "../domain/delivery.js";
import { parseSale } from "../domain/sale.js";
import { DomainError } from "../domain/errors.js";
import { transaction, type Db } from "./connect.js";
export async function failGeneration(
  client: PoolClient,
  ref: DeliveryRef,
  code: string,
  now: Date,
): Promise<void> {
  const args = [ref.tenantId, ref.deliveryId, ref.generation];
  const changed = await client.query(
    "update app.generations set state='failed',failure_code=$4,fence=null,lease_until=null where tenant_id=$1 and delivery_id=$2 and generation=$3 and state not in ('delivered','failed') returning generation",
    [...args, code],
  );
  if (changed.rowCount) {
    await client.query(
      "update app.attempts set state='abandoned',code=$4,finished_at=$5 where tenant_id=$1 and delivery_id=$2 and generation=$3 and state='claimed'",
      [...args, code, now],
    );
    await client.query(
      "insert into app.audit(tenant_id,delivery_id,generation,kind,code,event_key,at) values($1,$2,$3,'failed',$4,'terminal',$5) on conflict do nothing",
      [...args, code, now],
    );
  }
}
export async function claimAttempt(
  db: Db,
  ref: DeliveryRef,
  now: Date,
): Promise<AttemptClaim | null> {
  return transaction(db, async (client) => {
    const args = [ref.tenantId, ref.deliveryId, ref.generation];
    const { rows } = await client.query(
      "select g.*,e.raw,e.raw_sha256,e.business_sha256 from app.generations g join app.events e on e.tenant_id=g.tenant_id and e.delivery_id=g.delivery_id and e.current_generation=g.generation where g.tenant_id=$1 and g.delivery_id=$2 and g.generation=$3 for update of g",
      args,
    );
    const g = rows[0];
    if (!g || ["failed", "delivered"].includes(g.state)) return null;
    if (g.deadline_at <= now) {
      await failGeneration(
        client,
        ref,
        g.attempts > 0 ? "delivery_unconfirmed" : "deadline_exceeded",
        now,
      );
      return null;
    }
    if (
      (g.state === "delivering" && g.lease_until > now) ||
      g.next_attempt_at > now
    )
      return null;
    if (g.attempts >= 5) {
      await failGeneration(client, ref, "delivery_unconfirmed", now);
      return null;
    }
    const event = parseSale(g.raw);
    if (
      event.rawSha256 !== g.raw_sha256 ||
      event.businessSha256 !== g.business_sha256
    )
      throw new DomainError("corrupt_event", 500);
    await client.query(
      "update app.attempts set state='abandoned',code='lease_expired',finished_at=$4 where tenant_id=$1 and delivery_id=$2 and generation=$3 and state='claimed'",
      [...args, now],
    );
    const attemptId = randomUUID(),
      fence = randomUUID(),
      leaseUntil = new Date(now.getTime() + 30000);
    await client.query(
      "update app.generations set attempts=attempts+1,state='delivering',fence=$4,attempt_id=$5,lease_until=$6 where tenant_id=$1 and delivery_id=$2 and generation=$3",
      [...args, fence, attemptId, leaseUntil],
    );
    await client.query(
      "insert into app.attempts(tenant_id,delivery_id,generation,attempt_id,fence,started_at) values($1,$2,$3,$4,$5,$6)",
      [...args, attemptId, fence, now],
    );
    await client.query(
      "insert into app.audit(tenant_id,delivery_id,generation,kind,attempt_id,event_key,at) values($1,$2,$3,'attempt_claimed',$4,$5,$6)",
      [...args, attemptId, `attempt:${attemptId}:claimed`, now],
    );
    return {
      ...ref,
      attemptId,
      fence,
      leaseUntil: leaseUntil.toISOString(),
      deadlineAt: g.deadline_at.toISOString(),
      event,
    };
  });
}
export async function finishAttempt(
  db: Db,
  claim: AttemptClaim,
  outcome: AttemptOutcome,
  now: Date = new Date(),
): Promise<boolean> {
  return transaction(db, async (client) => {
    const args = [claim.tenantId, claim.deliveryId, claim.generation];
    const { rows } = await client.query(
      "select g.* from app.generations g join app.events e on e.tenant_id=g.tenant_id and e.delivery_id=g.delivery_id and e.current_generation=g.generation where g.tenant_id=$1 and g.delivery_id=$2 and g.generation=$3 for update of g",
      args,
    );
    const g = rows[0];
    if (
      !g ||
      g.state !== "delivering" ||
      g.fence !== claim.fence ||
      g.lease_until <= now
    )
      return false;
    if (g.deadline_at <= now) {
      await failGeneration(client, claim, "delivery_unconfirmed", now);
      return false;
    }
    if (
      outcome.kind === "success" &&
      (outcome.receipt.deliveryId !== claim.deliveryId ||
        outcome.receipt.businessSha256 !== claim.event.businessSha256 ||
        outcome.receipt.saleReference !== claim.event.sale.saleReference ||
        outcome.receipt.total !== claim.event.sale.total)
    )
      throw new DomainError("invalid_receipt", 500);
    const next =
      outcome.kind === "success"
        ? now
        : new Date(
            outcome.retryAt ??
              now.getTime() +
                [2000, 5000, 10000, 20000][Math.min(g.attempts - 1, 3)],
          );
    const terminal =
      outcome.kind === "success" ||
      outcome.kind === "permanent" ||
      g.attempts >= 5 ||
      next >= g.deadline_at;
    const state =
      outcome.kind === "success"
        ? "delivered"
        : terminal
          ? "failed"
          : "retry_wait";
    let code = outcome.kind === "success" ? null : outcome.code;
    await client.query(
      "update app.attempts set state=$5,code=$6,finished_at=$7 where tenant_id=$1 and delivery_id=$2 and generation=$3 and attempt_id=$4",
      [...args, claim.attemptId, outcome.kind, code, now],
    );
    if (state === "failed" && outcome.kind !== "permanent") {
      const unknown = await client.query(
        "select 1 from app.attempts where tenant_id=$1 and delivery_id=$2 and generation=$3 and state in ('unknown','abandoned') limit 1",
        args,
      );
      code = unknown.rowCount
        ? "delivery_unconfirmed"
        : next >= g.deadline_at
          ? "deadline_exceeded"
          : "attempts_exhausted";
    }
    await client.query(
      "update app.generations set state=$4,failure_code=$5,receipt=$6,next_attempt_at=$7,fence=null,lease_until=null where tenant_id=$1 and delivery_id=$2 and generation=$3",
      [
        ...args,
        state,
        code,
        outcome.kind === "success" ? outcome.receipt : null,
        next,
      ],
    );
    await client.query(
      "insert into app.audit(tenant_id,delivery_id,generation,kind,code,attempt_id,event_key,at) values($1,$2,$3,'attempt_finished',$4,$5,$6,$7)",
      [
        ...args,
        code,
        claim.attemptId,
        `attempt:${claim.attemptId}:finished`,
        now,
      ],
    );
    if (terminal)
      await client.query(
        "insert into app.audit(tenant_id,delivery_id,generation,kind,code,attempt_id,event_key,at) values($1,$2,$3,$4,$5,$6,'terminal',$7) on conflict do nothing",
        [...args, state, code, claim.attemptId, now],
      );
    return true;
  });
}
