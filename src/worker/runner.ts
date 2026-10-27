import { setTimeout as delay } from "node:timers/promises";
import { publishOnce } from "./publisher.js";
import { consumeOnce, type WorkerDeps } from "./consumer.js";
import { collectOnce } from "./collector.js";
export function startWorker(deps: WorkerDeps): { close(): Promise<void> } {
  let stopped = false;
  const loop = async (work: () => Promise<unknown>, pause: number) => {
    while (!stopped) {
      try {
        await work();
      } catch {
        if (!stopped)
          process.stderr.write(
            JSON.stringify({ component: "worker", code: "loop_failed" }) + "\n",
          );
      }
      if (!stopped) await delay(pause);
    }
  };
  const tasks = [
    loop(() => publishOnce(deps), 1000),
    loop(() => consumeOnce(deps), 50),
    loop(() => collectOnce(deps), 50),
  ];
  return {
    async close() {
      stopped = true;
      deps.queue.close();
      await Promise.all(tasks);
    },
  };
}
