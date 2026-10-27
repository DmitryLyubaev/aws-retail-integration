import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const refuse = (code) => ({ allowed: false, code });
const allow = { allowed: true, code: "ok" };
export function validateDispatch(request, context) {
  if (context.ref !== "refs/heads/main") return refuse("ref");
  if (context.eventName !== "workflow_dispatch") return refuse("event");
  if (
    !context.approvedRepository ||
    context.repository !== context.approvedRepository
  )
    return refuse("repository");
  if (context.environment !== "aws-demo") return refuse("environment");
  if (
    !request ||
    !["plan", "apply", "destroy"].includes(request.action) ||
    Object.keys(request).some(
      (k) =>
        ![
          "action",
          "sourceCommit",
          "sessionId",
          "imageDigest",
          "planKey",
          "planSha256",
        ].includes(k),
    )
  )
    return refuse("request");
  if (
    !/^[a-f0-9]{40}$/.test(request.sourceCommit) ||
    (request.action !== "destroy" &&
      request.sourceCommit !== context.sourceCommit)
  )
    return refuse("source");
  if (!/^p14-[a-z0-9][a-z0-9-]{0,23}$/.test(request.sessionId))
    return refuse("session");
  if (!/^sha256:[a-f0-9]{64}$/.test(request.imageDigest))
    return refuse("image");
  if (
    !/^\d{12}$/.test(context.expectedAccount) ||
    context.region !== "ap-southeast-2"
  )
    return refuse("account_region");
  const now = Date.parse(context.now),
    cleanup = Date.parse(context.cleanupAt),
    end = Date.parse(context.sessionEnd);
  if (
    ![now, cleanup, end].every(Number.isFinite) ||
    end - cleanup !== 7200000 ||
    (request.action !== "destroy" &&
      (now < cleanup - 14400000 || now >= cleanup))
  )
    return refuse("deadline");
  if (
    request.action === "apply" &&
    (request.planKey !==
      `plans/${request.sessionId}/${request.sourceCommit}/plan.bin` ||
      !request.planSha256 ||
      !/^[a-f0-9]{64}$/.test(request.planSha256))
  )
    return refuse("plan");
  return allow;
}
export function validateDelivery(request, context) {
  const local = validateDispatch(request, context);
  if (!local.allowed) return local;
  if (context.actualAccount !== context.expectedAccount)
    return refuse("account");
  const inventory = context.inventory;
  const prefix = `arn:aws:ecs:${context.region}:${context.expectedAccount}:`;
  if (
    inventory?.backupBucket !== undefined &&
    inventory.backupBucket !==
      `${request.sessionId}-${context.expectedAccount}-backup`
  )
    return refuse("inventory");
  if (
    !inventory ||
    inventory.sessionId !== request.sessionId ||
    inventory.accountId !== context.expectedAccount ||
    inventory.region !== context.region ||
    inventory.sourceCommit !== request.sourceCommit ||
    inventory.imageDigest !== request.imageDigest ||
    inventory.dbIdentifier !== request.sessionId ||
    inventory.clusterArn !== prefix + "cluster/" + request.sessionId ||
    !Array.isArray(inventory.serviceArns) ||
    inventory.serviceArns.length !== 2 ||
    !["application", "worker"].every((name) =>
      inventory.serviceArns.includes(
        prefix + `service/${request.sessionId}/${request.sessionId}-${name}`,
      ),
    )
  )
    return refuse("inventory");
  if (
    request.action !== "destroy" &&
    context.imageDigest !== request.imageDigest
  )
    return refuse("image");
  if (request.action === "apply") {
    const receipt = context.receipt;
    if (
      context.reviewedPlan !== true ||
      !receipt ||
      context.savedPlanSha256 !== request.planSha256
    )
      return refuse("plan");
    for (const key of [
      "sourceCommit",
      "sessionId",
      "imageDigest",
      "planKey",
      "planSha256",
    ])
      if (receipt[key] !== request[key]) return refuse("plan_receipt");
    for (const [key, value] of Object.entries({
      ref: context.ref,
      repository: context.repository,
      environment: context.environment,
      accountId: context.actualAccount,
      region: context.region,
      configSha256: context.configSha256,
      cleanupAt: context.cleanupAt,
      sessionEnd: context.sessionEnd,
    }))
      if (receipt[key] !== value) return refuse("plan_receipt");
  }
  return allow;
}
export async function runDelivery(request, context, clients) {
  const decision = validateDelivery(request, context);
  if (!decision.allowed) return decision;
  let stage = request.action;
  const current = () =>
    validateDelivery(request, {
      ...context,
      now: clients.now?.() ?? context.now,
    }).allowed;
  try {
    if (request.action === "plan") await clients.plan();
    else if (request.action === "destroy") await clients.destroy();
    else {
      await clients.apply();
      stage = "migration";
      if (!current() || (await clients.migrate()) !== 0)
        throw new Error("migration");
      stage = "seed";
      if (!current() || (await clients.seed()) !== 0) throw new Error("seed");
      stage = "start";
      if (!current()) throw new Error("deadline");
      await clients.start("application", 1);
      if (!current()) throw new Error("deadline");
      await clients.start("worker", 1);
    }
    return allow;
  } catch {
    if (request.action === "apply")
      try {
        await clients.cleanup();
      } catch {
        return refuse("cleanup_failed");
      }
    return refuse(stage + "_failed");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const request = JSON.parse(
      await readFile(process.argv[3] ?? ".local/request.json", "utf8"),
    );
    const context = JSON.parse(
      await readFile(process.argv[4] ?? ".local/context.json", "utf8"),
    );
    const result =
      process.argv[2] === "preflight"
        ? validateDispatch(request, context)
        : validateDelivery(request, context);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.allowed ? 0 : 1;
  } catch {
    process.stderr.write('{"allowed":false,"code":"guard_input"}\n');
    process.exitCode = 1;
  }
}
