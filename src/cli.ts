import { readFile } from "node:fs/promises";
import { DomainError } from "./domain/errors.js";
export async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<number> {
  try {
    const [command, ...rest] = args;
    const flags = new Map<string, string>();
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") {
        json = true;
        continue;
      }
      if (
        !rest[i]?.startsWith("--") ||
        !rest[i + 1] ||
        rest[i + 1]!.startsWith("--") ||
        flags.has(rest[i]!)
      )
        throw new DomainError("invalid_arguments", 400);
      flags.set(rest[i]!, rest[++i]!);
    }
    const allowed: Record<string, string[]> = {
      submit: ["--file"],
      list: [],
      show: ["--id"],
      replay: ["--id", "--generation", "--request-id"],
      fault: ["--sale", "--mode"],
    };
    if (
      !command ||
      !Object.hasOwn(allowed, command) ||
      [...flags.keys()].some((k) => !allowed[command]!.includes(k)) ||
      allowed[command]!.some((k) => !flags.has(k))
    )
      throw new DomainError("invalid_arguments", 400);
    const origin = new URL(env.DEMO_API_ORIGIN ?? "http://127.0.0.1:3000");
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !["http:", "https:"].includes(origin.protocol)
    )
      throw new DomainError("invalid_api_origin", 400);
    const token =
      env.DEMO_TOKEN ??
      (env.DEMO_CREDENTIAL_FILE
        ? (await readFile(env.DEMO_CREDENTIAL_FILE, "utf8")).trim()
        : "");
    if (token.length < 32 || token.length > 256)
      throw new DomainError("credential_required", 401);
    let path = "/v1/deliveries",
      method = "GET",
      body: string | Buffer<ArrayBuffer> | undefined;
    if (command === "submit") {
      path = "/v1/sales";
      method = "POST";
      body = await readFile(flags.get("--file")!);
    }
    if (command === "show")
      path += "/" + encodeURIComponent(flags.get("--id")!);
    if (command === "replay") {
      if (!/^[1-9]\d*$/.test(flags.get("--generation")!))
        throw new DomainError("invalid_arguments", 400);
      path += "/" + encodeURIComponent(flags.get("--id")!) + "/replay";
      method = "POST";
      body = JSON.stringify({
        expectedGeneration: Number(flags.get("--generation")),
        requestId: flags.get("--request-id"),
      });
    }
    if (command === "fault") {
      path = "/v1/demo/faults/" + encodeURIComponent(flags.get("--sale")!);
      method = "PUT";
      body = JSON.stringify({ mode: flags.get("--mode") });
    }
    const response = await fetch(new URL(path, origin), {
      method,
      redirect: "manual",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError("http_" + response.status, response.status);
    }
    const value = await response.json();
    io.out(JSON.stringify(value, null, json ? undefined : 2) + "\n");
    return 0;
  } catch (e) {
    io.err((e instanceof DomainError ? e.code : "command_failed") + "\n");
    return 1;
  }
}
