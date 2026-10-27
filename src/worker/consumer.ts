import type { Db } from "../db/connect.js";
import type {
  Clock,
  FaultHook,
  QueueEnvelope,
  AttemptOutcome,
  AttemptClaim,
  ReceiverReceipt,
} from "../domain/delivery.js";
import type { Queue, QueueMessage } from "./queue.js";
import { parseEnvelope } from "./envelope.js";
import { claimAttempt, finishAttempt } from "../db/attempts.js";
import { observe, telemetry } from "../operations/observe.js";
export interface WorkerDeps {
  db: Db;
  queue: Queue;
  clock: Clock;
  receiverOrigin: string;
  receiverTokens: ReadonlyMap<string, string>;
  fault?: FaultHook;
}
export async function envelopeStatus(
  db: Db,
  ref: QueueEnvelope,
): Promise<{ state: string; generation: number; dueAt: Date } | null> {
  const { rows } = await db.pool.query(
    "select g.state,e.current_generation,g.lease_until,g.next_attempt_at from app.events e join app.generations g on g.tenant_id=e.tenant_id and g.delivery_id=e.delivery_id and g.generation=$3 where e.tenant_id=$1 and e.delivery_id=$2 and e.business_sha256=$4",
    [ref.tenantId, ref.deliveryId, ref.generation, ref.businessSha256],
  );
  const row = rows[0];
  return row
    ? {
        state: row.state,
        generation: row.current_generation,
        dueAt:
          row.state === "delivering" ? row.lease_until : row.next_attempt_at,
      }
    : null;
}
export function retryAt(
  header: string | null,
  attempt: number,
  now: Date,
  deadline: Date,
): string {
  const delays = [2000, 5000, 10000, 20000];
  let delay = delays[Math.min(3, Math.max(0, attempt - 1))];
  const text = header?.trim();
  if (text) {
    const requested = /^\d+$/.test(text)
      ? Number(text) * 1000
      : /^[-+]?\d+(?:\.\d+)?$/.test(text)
        ? NaN
        : Date.parse(text) - now.getTime();
    if (Number.isFinite(requested) && requested >= 0)
      delay = Math.max(delay, requested);
  }
  return new Date(
    Math.min(deadline.getTime(), now.getTime() + delay),
  ).toISOString();
}
async function sendToReceiver(
  deps: WorkerDeps,
  claim: AttemptClaim,
): Promise<AttemptOutcome> {
  const token = deps.receiverTokens.get(claim.tenantId);
  if (!token) return { kind: "permanent", code: "receiver_credential_missing" };
  const remaining =
    new Date(claim.deadlineAt).getTime() - deps.clock.now().getTime();
  if (remaining <= 0) return { kind: "unknown", code: "deadline_exceeded" };
  try {
    const response = await fetch(new URL("/sales", deps.receiverOrigin), {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "x-delivery-id": claim.deliveryId,
      },
      body: new Uint8Array(claim.event.raw),
      signal: AbortSignal.timeout(Math.min(5000, remaining)),
    });
    if (response.status !== 200) {
      void response.body?.cancel();
      const transient = response.status === 429 || response.status >= 500;
      return {
        kind: transient ? "transient" : "permanent",
        code: `receiver_http_${response.status}`,
        retryAt: retryAt(
          response.headers.get("retry-after"),
          (
            await deps.db.pool.query(
              "select attempts from app.generations where tenant_id=$1 and delivery_id=$2 and generation=$3",
              [claim.tenantId, claim.deliveryId, claim.generation],
            )
          ).rows[0].attempts,
          deps.clock.now(),
          new Date(claim.deadlineAt),
        ),
      };
    }
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (!response.body) return { kind: "unknown", code: "invalid_receipt" };
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 8192) {
        await response.body.cancel().catch(() => {});
        return { kind: "unknown", code: "invalid_receipt" };
      }
      chunks.push(chunk);
    }
    let receipt: ReceiverReceipt;
    try {
      receipt = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      return { kind: "unknown", code: "invalid_receipt" };
    }
    if (
      !receipt ||
      typeof receipt !== "object" ||
      Object.keys(receipt).sort().join(",") !==
        "businessSha256,deliveryId,saleReference,total" ||
      receipt.deliveryId !== claim.deliveryId ||
      receipt.businessSha256 !== claim.event.businessSha256 ||
      receipt.saleReference !== claim.event.sale.saleReference ||
      receipt.total !== claim.event.sale.total
    )
      return { kind: "unknown", code: "invalid_receipt" };
    return { kind: "success", receipt };
  } catch {
    return { kind: "unknown", code: "receiver_io_unknown" };
  }
}
async function handle(deps: WorkerDeps, message: QueueMessage): Promise<void> {
  let ref: QueueEnvelope;
  try {
    ref = parseEnvelope(message.body);
  } catch {
    await deps.queue.defer(message.receiptHandle, 0);
    return;
  }
  let status = await envelopeStatus(deps.db, ref);
  if (!status) {
    await deps.queue.defer(message.receiptHandle, 0);
    return;
  }
  if (
    ["delivered", "failed"].includes(status.state) ||
    status.generation !== ref.generation
  ) {
    await deps.queue.remove("source", message.receiptHandle);
    return;
  }
  const claim = await claimAttempt(deps.db, ref, deps.clock.now());
  if (claim) {
    await deps.fault?.("before_receiver_http");
    const outcome = await sendToReceiver(deps, claim);
    await deps.fault?.("after_receiver_io_before_attempt_finish");
    const finished = await finishAttempt(
      deps.db,
      claim,
      outcome,
      deps.clock.now(),
    );
    if (finished) {
      const current = await envelopeStatus(deps.db, ref);
      telemetry.log({
        component: "consumer",
        code: outcome.kind === "success" ? "delivered" : outcome.code,
        tenantId: claim.tenantId,
        deliveryId: claim.deliveryId,
        generation: claim.generation,
        attemptId: claim.attemptId,
      });
      await observe(
        deps.db,
        current?.state === "delivered"
          ? { delivered: 1 }
          : current?.state === "failed"
            ? { failed: 1 }
            : { retry: 1 },
      );
    }
    await deps.fault?.("after_attempt_commit_before_queue_delete");
  }
  status = await envelopeStatus(deps.db, ref);
  if (
    !status ||
    ["delivered", "failed"].includes(status.state) ||
    status.generation !== ref.generation
  )
    await deps.queue.remove("source", message.receiptHandle);
  else
    await deps.queue.defer(
      message.receiptHandle,
      Math.max(
        1,
        Math.min(
          45,
          Math.ceil(
            (status.dueAt.getTime() - deps.clock.now().getTime()) / 1000,
          ),
        ),
      ),
    );
}
export async function consumeOnce(deps: WorkerDeps): Promise<number> {
  const messages = await deps.queue.receive("source");
  for (let i = 0; i < messages.length; i += 4)
    await Promise.all(
      messages.slice(i, i + 4).map((message) =>
        handle(deps, message).catch(() => {
          process.stderr.write(
            JSON.stringify({
              component: "consumer",
              code: "message_processing_failed",
            }) + "\n",
          );
        }),
      ),
    );
  return messages.length;
}
