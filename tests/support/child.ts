import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { compiledTests, runtimePath } from "./runtime.js";
export function startChild(
  script: string,
  env: Record<string, string>,
): ChildProcess {
  return fork(runtimePath(script), [], {
    execArgv: compiledTests() ? [] : ["--import", "tsx"],
    env: { ...process.env, ...env },
    silent: true,
  });
}
export function childMessage(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("child message deadline"));
    }, 10000);
    const message = (value: unknown) => {
      cleanup();
      resolve(value);
    };
    const exit = () => {
      cleanup();
      reject(new Error("child exited before expected message"));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", message);
      child.off("exit", exit);
    }
    child.once("message", message);
    child.once("exit", exit);
  });
}
export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
}
