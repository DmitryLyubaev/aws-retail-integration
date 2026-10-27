import type { WorkerDeps } from "./consumer.js";
import { parseEnvelope } from "./envelope.js";
import { persistQuarantine } from "../db/quarantine.js";
export async function collectOnce(deps: WorkerDeps): Promise<number> {
  const messages = await deps.queue.receive("dlq");
  let collected = 0;
  for (const message of messages) {
    let ref;
    try {
      ref = parseEnvelope(message.body);
    } catch {}
    await persistQuarantine(
      deps.db,
      message,
      ref ? "transport_exhausted" : "invalid_envelope",
      ref,
      deps.clock.now(),
    );
    await deps.fault?.("after_quarantine_commit_before_ack");
    await deps.queue.remove("dlq", message.receiptHandle);
    collected++;
  }
  return collected;
}
