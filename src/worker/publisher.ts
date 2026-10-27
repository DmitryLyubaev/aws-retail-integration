import type { Clock, FaultHook } from "../domain/delivery.js";
import type { Db } from "../db/connect.js";
import { claimOutbox, completePublish } from "../db/outbox.js";
import type { Queue } from "./queue.js";
export async function publishOnce(deps: {
  db: Db;
  queue: Queue;
  clock: Clock;
  fault?: FaultHook;
}): Promise<number> {
  const claims = await claimOutbox(deps.db, deps.clock.now());
  let completed = 0;
  for (const claim of claims) {
    const now = deps.clock.now().getTime();
    if (now >= claim.leaseUntil.getTime() || now >= claim.deadlineAt.getTime())
      continue;
    try {
      await deps.queue.send(claim.envelope);
    } catch {
      await completePublish(deps.db, claim, deps.clock.now(), false);
      continue;
    }
    await deps.fault?.("after_queue_send_before_publish_mark");
    if (await completePublish(deps.db, claim, deps.clock.now(), true))
      completed++;
  }
  return completed;
}
