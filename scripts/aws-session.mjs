import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  validateDispatch,
  validateDelivery,
  runDelivery,
} from "./delivery.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonFile = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
export function command(binary, args, { input, log, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AWS_PAGER: "" },
    });
    let stdout = "",
      stderr = "",
      size = 0,
      timedOut = false;
    const grace = Math.min(2000, Math.floor(timeout / 4));
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
      },
      Math.max(0, timeout - grace),
    );
    const hardTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    const collect = (chunk, err) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        child.kill("SIGTERM");
        return;
      }
      if (err) stderr += chunk;
      else stdout += chunk;
    };
    child.stdout.on("data", (c) => collect(c, false));
    child.stderr.on("data", (c) => collect(c, true));
    child.on("error", () => {
      clearTimeout(timer);
      clearTimeout(hardTimer);
      reject(new Error("command_unavailable"));
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(hardTimer);
      try {
        if (log) await writeFile(log, stdout + "\n" + stderr, { mode: 0o600 });
        resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
      } catch {
        reject(new Error("private_log_failed"));
      }
    });
    child.stdin.end(input);
  });
}
async function must(binary, args, options) {
  const r = await command(binary, args, options);
  if (r.code !== 0) throw new Error("command_failed");
  return r.stdout;
}
export async function terraformOperation(
  context,
  operation,
  args,
  log,
  run = command,
  now = Date.now,
) {
  const cutoff = Date.parse(
    operation === "destroy" ? context.sessionEnd : context.cleanupAt,
  );
  const remaining = cutoff - now();
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error("terraform_deadline");
  const result = await run("terraform", args, {
    log,
    timeout: Math.min(45 * 60000, remaining),
  });
  if (result.timedOut) throw new Error("terraform_timeout");
  if (result.code !== 0) throw new Error("command_failed");
  return result.stdout;
}
const aws = (...args) =>
  command("aws", ["--no-cli-pager", "--region", "ap-southeast-2", ...args]);
async function awsJson(...args) {
  const r = await aws(...args, "--output", "json");
  if (r.code !== 0) throw new Error("aws_read_failed");
  return JSON.parse(r.stdout);
}
async function identity(expected) {
  const actual = await awsJson("sts", "get-caller-identity");
  if (actual.Account !== expected) throw new Error("account");
  return actual.Account;
}
function inventory(request, context) {
  const prefix = `arn:aws:ecs:${context.region}:${context.expectedAccount}:`;
  return {
    sessionId: request.sessionId,
    sourceCommit: request.sourceCommit,
    imageDigest: request.imageDigest,
    accountId: context.expectedAccount,
    region: context.region,
    clusterArn: prefix + "cluster/" + request.sessionId,
    serviceArns: ["application", "worker"].map(
      (n) => prefix + `service/${request.sessionId}/${request.sessionId}-${n}`,
    ),
    dbIdentifier: request.sessionId,
  };
}
export function sessionTimes(start) {
  if (!Number.isFinite(start) || start % 1000 !== 0)
    throw new Error("session_start_precision");
  return {
    cleanupAt: new Date(start + 14400000).toISOString().replace(".000Z", "Z"),
    sessionEnd: new Date(start + 21600000).toISOString().replace(".000Z", "Z"),
  };
}
async function prepare(publication = false) {
  await mkdir(".local/logs", { recursive: true });
  const e = process.env;
  const request = {
    action: publication ? "plan" : e.REQUEST_ACTION,
    sourceCommit: e.REQUEST_SOURCE,
    sessionId: e.REQUEST_SESSION,
    imageDigest: publication ? "sha256:" + "0".repeat(64) : e.REQUEST_IMAGE,
    ...(e.REQUEST_PLAN_KEY ? { planKey: e.REQUEST_PLAN_KEY } : {}),
    ...(e.REQUEST_PLAN_SHA ? { planSha256: e.REQUEST_PLAN_SHA } : {}),
  };
  const start = Date.parse(e.SESSION_START);
  const context = {
    eventName: e.GITHUB_EVENT_NAME,
    ref: e.GITHUB_REF,
    repository: e.GITHUB_REPOSITORY,
    approvedRepository: e.APPROVED_REPOSITORY,
    environment: e.DEPLOYMENT_ENVIRONMENT,
    expectedAccount: e.EXPECTED_ACCOUNT,
    region: e.AWS_REGION,
    sourceCommit: e.GITHUB_SHA,
    now: new Date().toISOString(),
    ...sessionTimes(start),
    configSha256: e.CONFIG_SHA256 ?? "",
    reviewedPlan: e.REVIEWED_PLAN === "true",
  };
  const result = validateDispatch(request, context);
  if (!result.allowed) throw new Error(result.code);
  await save(".local/request.json", request);
  await save(".local/context.json", context);
  return { request, context };
}
async function login(registry) {
  const r = await aws("ecr", "get-login-password");
  if (r.code !== 0) throw new Error("ecr_login");
  await must(
    "docker",
    ["login", "--username", "AWS", "--password-stdin", registry],
    { input: r.stdout },
  );
}
async function publishedImage(request, context, repository) {
  if (
    repository !==
    `${context.expectedAccount}.dkr.ecr.ap-southeast-2.amazonaws.com/p14-retail-integration`
  )
    throw new Error("image_repository");
  const registry = repository.split("/")[0];
  await login(registry);
  try {
    await must("docker", ["pull", repository + "@" + request.imageDigest], {
      log: ".local/logs/image-pull.log",
    });
    const data = JSON.parse(
      await must("docker", [
        "image",
        "inspect",
        repository + "@" + request.imageDigest,
      ]),
    );
    if (
      data[0]?.Config?.Labels?.["org.opencontainers.image.revision"] !==
      request.sourceCommit
    )
      throw new Error("image_source");
    context.imageDigest = request.imageDigest;
  } finally {
    await command("docker", ["logout", registry]);
  }
}
async function tfInit(config) {
  await must(
    "terraform",
    [
      "-chdir=infra/session",
      "init",
      "-input=false",
      "-reconfigure",
      "-backend-config=bucket=" + config.stateBucket,
      "-backend-config=key=sessions/" +
        config.request.sessionId +
        "/terraform.tfstate",
    ],
    { log: ".local/logs/terraform-init.log" },
  );
}
async function ownedCompute(i) {
  const clusters = await awsJson(
    "ecs",
    "describe-clusters",
    "--clusters",
    i.clusterArn,
    "--include",
    "TAGS",
  );
  const cluster = clusters.clusters?.[0];
  if (!cluster) return;
  const owned = (tags) =>
    tags?.some((t) => t.key === "SessionId" && t.value === i.sessionId);
  if (!owned(cluster.tags)) throw new Error("ownership");
  const services = await awsJson(
    "ecs",
    "describe-services",
    "--cluster",
    i.clusterArn,
    "--services",
    ...i.serviceArns,
    "--include",
    "TAGS",
  );
  if (services.services?.some((s) => s.status !== "INACTIVE" && !owned(s.tags)))
    throw new Error("ownership");
  const tasks = await awsJson("ecs", "list-tasks", "--cluster", i.clusterArn);
  if (tasks.nextToken) throw new Error("inventory");
  const arns = tasks.taskArns ?? [];
  if (arns.length > 10) throw new Error("inventory");
  const details = arns.length
    ? await awsJson(
        "ecs",
        "describe-tasks",
        "--cluster",
        i.clusterArn,
        "--tasks",
        ...arns,
        "--include",
        "TAGS",
      )
    : { tasks: [] };
  if (
    details.tasks?.some((t) => t.clusterArn !== i.clusterArn || !owned(t.tags))
  )
    throw new Error("ownership");
  for (const s of services.services ?? [])
    if (s.status !== "INACTIVE") {
      const r = await aws(
        "ecs",
        "update-service",
        "--cluster",
        i.clusterArn,
        "--service",
        s.serviceArn,
        "--desired-count",
        "0",
      );
      if (r.code !== 0) throw new Error("compute_stop");
    }
  for (const arn of arns) {
    const r = await aws(
      "ecs",
      "stop-task",
      "--cluster",
      i.clusterArn,
      "--task",
      arn,
      "--reason",
      "Bounded demonstration failure or cleanup",
    );
    if (r.code !== 0) throw new Error("compute_stop");
  }
}
async function emptyBucket(bucket) {
  if (!/^p14-[a-z0-9-]+$/.test(bucket)) throw new Error("bucket_inventory");
  for (let page = 0; page < 20; page++) {
    const r = await aws(
      "s3api",
      "list-object-versions",
      "--bucket",
      bucket,
      "--no-paginate",
      "--max-keys",
      "1000",
      "--output",
      "json",
    );
    if (r.code !== 0) {
      if (/NoSuchBucket/.test(r.stderr)) return;
      throw new Error("bucket_inspect");
    }
    const data = JSON.parse(r.stdout);
    const objects = [
      ...(data.Versions ?? []),
      ...(data.DeleteMarkers ?? []),
    ].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    if (!objects.length) return;
    await save(".local/delete-objects.json", { Objects: objects, Quiet: true });
    const deleted = await awsJson(
      "s3api",
      "delete-objects",
      "--bucket",
      bucket,
      "--delete",
      "file://.local/delete-objects.json",
    );
    if (deleted.Errors?.length) throw new Error("bucket_delete");
  }
  throw new Error("bucket_inventory");
}
async function migrate(config, mode) {
  const i = await jsonFile(config.inventoryFile ?? ".local/inventory.json");
  if (
    !validateDelivery(
      { ...config.request, action: "destroy" },
      { ...config.context, now: new Date().toISOString(), inventory: i },
    ).allowed ||
    !new RegExp(
      `^arn:aws:ecs:ap-southeast-2:${config.context.expectedAccount}:task-definition/${config.request.sessionId}-maintenance:[0-9]+$`,
    ).test(i.maintenanceTask ?? "") ||
    Date.now() >= Date.parse(config.context.cleanupAt)
  )
    throw new Error("migration_inventory");
  const result = await awsJson(
    "ecs",
    "run-task",
    "--cluster",
    i.clusterArn,
    "--task-definition",
    i.maintenanceTask,
    "--launch-type",
    "FARGATE",
    "--count",
    "1",
    "--tags",
    "key=SessionId,value=" + i.sessionId,
    "key=Project,value=p14",
    "--network-configuration",
    JSON.stringify({
      awsvpcConfiguration: {
        subnets: i.publicSubnets,
        securityGroups: [i.maintenanceSecurityGroup],
        assignPublicIp: "ENABLED",
      },
    }),
    "--overrides",
    JSON.stringify({
      containerOverrides: [{ name: "maintenance", command: [mode] }],
    }),
  );
  const arn = result.tasks?.[0]?.taskArn;
  if (!arn || result.failures?.length) throw new Error("migration_start");
  const waited = await aws(
    "ecs",
    "wait",
    "tasks-stopped",
    "--cluster",
    i.clusterArn,
    "--tasks",
    arn,
  );
  if (waited.code !== 0) throw new Error("migration_wait");
  const task = (
    await awsJson(
      "ecs",
      "describe-tasks",
      "--cluster",
      i.clusterArn,
      "--tasks",
      arn,
    )
  ).tasks?.[0];
  const code = task?.containers?.find(
    (c) => c.name === "maintenance",
  )?.exitCode;
  await save(".local/" + mode + "-receipt.json", {
    taskArn: arn,
    exitCode: code ?? null,
  });
  return code ?? 1;
}
async function execute() {
  const request = await jsonFile(".local/request.json"),
    context = await jsonFile(".local/context.json");
  context.privateConfigVerified = false;
  delete context.actualAccount;
  try {
    return await executePrepared(request, context);
  } catch (error) {
    const evidence = await retainFailureEvidence(request, context).catch(
      () => ({
        retained: false,
        code: "capture_failed",
      }),
    );
    process.stderr.write(
      JSON.stringify({ code: "private_failure_evidence", ...evidence }) + "\n",
    );
    throw error;
  }
}
async function retainFailureEvidence(request, context) {
  const bucket = process.env.STATE_BUCKET,
    runId = process.env.GITHUB_RUN_ID ?? "owner";
  if (
    !context.privateConfigVerified ||
    context.actualAccount !== context.expectedAccount ||
    !/^p14-[a-z0-9-]+$/.test(bucket ?? "") ||
    !/^(?:[0-9]{1,20}|owner)$/.test(runId)
  )
    return { retained: false, code: "unverified_binding" };
  const paths = [
    ...[
      "terraform-init",
      "terraform-plan",
      "terraform-apply",
      "terraform-destroy",
      "image-pull",
    ].map((name) => `.local/logs/${name}.log`),
    ...[
      "delivery-summary",
      "migrate-receipt",
      "seed-receipt",
      "plan-receipt",
      "inventory",
    ].map((name) => `.local/${name}.json`),
  ];
  const deadline = Date.now() + 60000;
  let files = 0;
  for (const file of paths) {
    let stat;
    try {
      stat = await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.size > 16 * 1024 * 1024 ||
      Date.now() >= deadline
    )
      return { retained: false, code: "capture_limit", files };
    const name = file.split("/").at(-1);
    const result = await command(
      "aws",
      [
        "--no-cli-pager",
        "--region",
        context.region,
        "s3api",
        "put-object",
        "--bucket",
        bucket,
        "--key",
        `evidence/${request.sessionId}/${request.sourceCommit}/${runId}/${name}`,
        "--body",
        file,
        "--server-side-encryption",
        "AES256",
      ],
      { timeout: Math.min(15000, deadline - Date.now()) },
    );
    if (result.code !== 0)
      return { retained: false, code: "upload_failed", files };
    files++;
  }
  return { retained: files > 0, files };
}
async function executePrepared(request, context) {
  context.now = new Date().toISOString();
  const local = validateDispatch(request, context);
  if (!local.allowed) throw new Error(local.code);
  context.actualAccount = await identity(context.expectedAccount);
  const stateBucket = process.env.STATE_BUCKET,
    configKey = process.env.CONFIG_KEY;
  if (
    !/^p14-[a-z0-9-]+$/.test(stateBucket ?? "") ||
    configKey !== `configs/${request.sessionId}/${request.sourceCommit}.json`
  )
    throw new Error("config_key");
  const fetched = await aws(
    "s3api",
    "get-object",
    "--bucket",
    stateBucket,
    "--key",
    configKey,
    ".local/session.json",
  );
  if (fetched.code !== 0) throw new Error("config_download");
  const bytes = await readFile(".local/session.json");
  if (sha(bytes) !== context.configSha256) throw new Error("config_hash");
  const vars = JSON.parse(bytes);
  for (const [key, value] of Object.entries({
    account_id: context.expectedAccount,
    region: context.region,
    session_id: request.sessionId,
    source_commit: request.sourceCommit,
    image_digest: request.imageDigest,
    cleanup_at: context.cleanupAt,
    session_end: context.sessionEnd,
  }))
    if (vars[key] !== value) throw new Error("config_binding");
  if (vars.state_bucket !== stateBucket) throw new Error("state_binding");
  context.privateConfigVerified = true;
  context.inventory = inventory(request, context);
  if (request.action !== "destroy")
    await publishedImage(request, context, vars.image_repository_url);
  const planKey = `plans/${request.sessionId}/${request.sourceCommit}/plan.bin`;
  if (request.action === "apply") {
    for (const [key, file] of [
      [request.planKey, ".local/plan.bin"],
      [planKey + ".receipt.json", ".local/plan-receipt.json"],
    ]) {
      const r = await aws(
        "s3api",
        "get-object",
        "--bucket",
        stateBucket,
        "--key",
        key,
        file,
      );
      if (r.code !== 0) throw new Error("plan_download");
    }
    context.savedPlanSha256 = sha(await readFile(".local/plan.bin"));
    context.receipt = await jsonFile(".local/plan-receipt.json");
  }
  const guard = validateDelivery(request, context);
  if (!guard.allowed) throw new Error(guard.code);
  const config = {
    request,
    context,
    stateBucket,
    configFile: ".local/session.json",
    inventoryFile: ".local/inventory.json",
  };
  await tfInit(config);
  const clients = {
    now: () => new Date().toISOString(),
    async plan() {
      await terraformOperation(
        context,
        "plan",
        [
          "-chdir=infra/session",
          "plan",
          "-input=false",
          "-var-file=../../.local/session.json",
          "-out=../../.local/plan.bin",
        ],
        ".local/logs/terraform-plan.log",
      );
      const digest = sha(await readFile(".local/plan.bin"));
      const receipt = {
        sourceCommit: request.sourceCommit,
        sessionId: request.sessionId,
        imageDigest: request.imageDigest,
        planKey,
        planSha256: digest,
        ref: context.ref,
        repository: context.repository,
        environment: context.environment,
        accountId: context.actualAccount,
        region: context.region,
        configSha256: context.configSha256,
        cleanupAt: context.cleanupAt,
        sessionEnd: context.sessionEnd,
      };
      await save(".local/plan-receipt.json", receipt);
      for (const [file, key] of [
        [".local/plan.bin", planKey],
        [".local/plan-receipt.json", planKey + ".receipt.json"],
      ]) {
        const r = await aws(
          "s3api",
          "put-object",
          "--bucket",
          stateBucket,
          "--key",
          key,
          "--body",
          file,
          "--server-side-encryption",
          "AES256",
        );
        if (r.code !== 0) throw new Error("plan_save");
      }
    },
    async apply() {
      const readyObject = await aws(
        "s3api",
        "get-object",
        "--bucket",
        stateBucket,
        "--key",
        `supervision/${request.sessionId}/ready.json`,
        ".local/supervisor-ready.json",
      );
      context.now = new Date().toISOString();
      if (
        readyObject.code !== 0 ||
        !validateDispatch(request, context).allowed ||
        !readyMatches(
          request,
          context,
          await jsonFile(".local/supervisor-ready.json"),
        )
      )
        throw new Error("supervisor_required");
      await terraformOperation(
        context,
        "apply",
        [
          "-chdir=infra/session",
          "apply",
          "-input=false",
          "../../.local/plan.bin",
        ],
        ".local/logs/terraform-apply.log",
      );
      const outputs = JSON.parse(
        await must("terraform", ["-chdir=infra/session", "output", "-json"]),
      );
      await save(config.inventoryFile, outputs.inventory.value);
      await save(".local/live-session.json", {
        ...config,
        sessionId: request.sessionId,
        cleanupAt: context.cleanupAt,
        sessionEnd: context.sessionEnd,
      });
    },
    migrate: () => migrate(config, "migrate"),
    seed: () => migrate(config, "seed"),
    async start(name, count) {
      if (count !== 1 || Date.now() >= Date.parse(context.cleanupAt))
        throw new Error("service_count_or_deadline");
      const r = await aws(
        "ecs",
        "update-service",
        "--cluster",
        context.inventory.clusterArn,
        "--service",
        context.inventory.serviceArns.find((a) => a.endsWith("-" + name)),
        "--desired-count",
        "1",
      );
      if (r.code !== 0) throw new Error("service_start");
    },
    async destroy() {
      await destroySession(config);
    },
    cleanup: () => ownedCompute(context.inventory),
  };
  const result = await runDelivery(request, context, clients);
  await save(".local/delivery-summary.json", {
    ...result,
    sourceCommit: request.sourceCommit,
    sessionId: request.sessionId,
    imageDigest: request.imageDigest,
  });
  if (!result.allowed) throw new Error(result.code);
  return result;
}
export async function destroySession(config) {
  await identity(config.context.expectedAccount);
  const vars = await jsonFile(config.configFile);
  if (
    sha(await readFile(config.configFile)) !== config.context.configSha256 ||
    vars.session_id !== config.request.sessionId
  )
    throw new Error("config_hash");
  await tfInit(config);
  let i;
  try {
    i = await jsonFile(config.inventoryFile ?? ".local/inventory.json");
  } catch {
    i = null;
  }
  if (
    i &&
    !validateDelivery(
      { ...config.request, action: "destroy" },
      { ...config.context, now: new Date().toISOString(), inventory: i },
    ).allowed
  )
    throw new Error("destroy_inventory");
  const backupBucket =
    i?.backupBucket ??
    `${config.request.sessionId}-${config.context.expectedAccount}-backup`;
  await mkdir(".local/export/" + config.request.sessionId, { recursive: true });
  const exported = await aws(
    "s3",
    "sync",
    "s3://" + backupBucket,
    ".local/export/" + config.request.sessionId + "/backup",
  );
  if (exported.code !== 0 && !/NoSuchBucket/.test(exported.stderr))
    throw new Error("evidence_export_failed");
  const logs = await aws(
    "logs",
    "filter-log-events",
    "--log-group-name",
    "/p14/" + config.request.sessionId,
    "--limit",
    "10000",
    "--no-paginate",
    "--output",
    "json",
  );
  if (logs.code === 0)
    await writeFile(
      ".local/export/" + config.request.sessionId + "/logs.json",
      logs.stdout,
      { mode: 0o600 },
    );
  else if (!/ResourceNotFoundException/.test(logs.stderr))
    throw new Error("evidence_export_failed");
  await emptyBucket(backupBucket);
  await terraformOperation(
    config.context,
    "destroy",
    [
      "-chdir=infra/session",
      "destroy",
      "-input=false",
      "-auto-approve",
      "-var-file=../../" + config.configFile,
    ],
    ".local/logs/terraform-destroy.log",
  );
}
export function responseIsAbsent(r, empty, allowEmptyOutput = false) {
  if (r.code === null) return false;
  if (r.code !== 0)
    return /\((?:404|ResourceNotFoundException|DBInstanceNotFound|DBInstanceNotFoundFault|DBInstanceAutomatedBackupNotFound|AWS.SimpleQueueService.NonExistentQueue|QueueDoesNotExist|NoSuchEntity|NoSuchBucket|NoSuchHostedZone|InvalidVpcID.NotFound|RepositoryNotFoundException|NamespaceNotFound|ServiceNotFound|NotFoundException)\)/.test(
      r.stderr,
    );
  try {
    const value = JSON.parse(
      allowEmptyOutput && !r.stdout.trim() ? "{}" : r.stdout,
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.IsTruncated === true ||
      [
        "NextToken",
        "nextToken",
        "Marker",
        "marker",
        "NextMarker",
        "NextContinuationToken",
      ].some((key) => value[key])
    )
      return false;
    return empty(value);
  } catch {
    return false;
  }
}
async function absence(args, empty) {
  return responseIsAbsent(
    await aws(...args, "--output", "json"),
    empty,
    args[0] === "sqs" && args[1] === "list-queues",
  );
}
export function supervisorBinding(config) {
  return (
    !!config &&
    config.sessionId === config.request?.sessionId &&
    config.cleanupAt === config.context?.cleanupAt &&
    config.sessionEnd === config.context?.sessionEnd
  );
}
export function readyMatches(request, context, ready) {
  if (!ready || typeof ready !== "object") return false;
  for (const [key, value] of Object.entries({
    sessionId: request.sessionId,
    sourceCommit: request.sourceCommit,
    imageDigest: request.imageDigest,
    accountId: context.actualAccount,
    configSha256: context.configSha256,
    cleanupAt: context.cleanupAt,
    sessionEnd: context.sessionEnd,
  }))
    if (ready[key] !== value) return false;
  const age = Date.parse(context.now) - Date.parse(ready.at);
  return Number.isFinite(age) && age >= 0 && age <= 60000;
}
export async function verifyClosure(config) {
  const actualAccount = await identity(config.context.expectedAccount);
  let physical;
  try {
    physical = await jsonFile(config.inventoryFile ?? ".local/inventory.json");
  } catch {
    physical = null;
  }
  if (
    physical &&
    !validateDelivery(
      { ...config.request, action: "destroy" },
      {
        ...config.context,
        actualAccount,
        now: new Date().toISOString(),
        inventory: physical,
      },
    ).allowed
  )
    return {};
  const sessionId = config.request.sessionId;
  const i = {
    ...inventory(config.request, config.context),
    backupBucket: `${sessionId}-${config.context.expectedAccount}-backup`,
    logGroup: "/p14/" + sessionId,
    alarmNames: [sessionId + "-dlq-visible", sessionId + "-failed"],
    cleanupFunction: sessionId + "-cleanup",
    cleanupSchedule: sessionId + "-cleanup",
    iamRoleNames: [
      "application",
      "worker",
      "maintenance",
      "application-execution",
      "receiver-execution",
      "worker-execution",
      "maintenance-execution",
      "cleanup",
      "scheduler",
    ].map((n) => sessionId + "-" + n),
    vpcId: physical?.vpcId,
  };
  const region = "ap-southeast-2",
    session = i.sessionId;
  const checks = {};
  checks.compute = await absence(
    ["ecs", "describe-clusters", "--clusters", i.clusterArn],
    (r) =>
      !r.clusters?.length || r.clusters.every((c) => c.status === "INACTIVE"),
  );
  checks.database =
    (await absence(
      [
        "rds",
        "describe-db-instances",
        "--db-instance-identifier",
        i.dbIdentifier,
      ],
      (r) => !r.DBInstances?.length,
    )) &&
    (await absence(
      [
        "rds",
        "describe-db-snapshots",
        "--db-instance-identifier",
        i.dbIdentifier,
      ],
      (r) => !r.DBSnapshots?.length,
    )) &&
    (await absence(
      [
        "rds",
        "describe-db-instance-automated-backups",
        "--db-instance-identifier",
        i.dbIdentifier,
      ],
      (r) => !r.DBInstanceAutomatedBackups?.length,
    ));
  checks.queues = await absence(
    ["sqs", "list-queues", "--queue-name-prefix", session + "-"],
    (r) => !r.QueueUrls?.length,
  );
  checks.buckets = await absence(
    ["s3api", "head-bucket", "--bucket", i.backupBucket],
    () => false,
  );
  checks.secrets = await absence(
    [
      "secretsmanager",
      "list-secrets",
      "--include-planned-deletion",
      "--filters",
      "Key=tag-value,Values=" +
        session +
        "," +
        `arn:aws:rds:ap-southeast-2:${config.context.expectedAccount}:db:${session}`,
    ],
    (r) => !r.SecretList?.length,
  );
  checks.logs = await absence(
    ["logs", "describe-log-groups", "--log-group-name-prefix", i.logGroup],
    (r) => !(r.logGroups ?? []).some((g) => g.logGroupName === i.logGroup),
  );
  checks.alarms = await absence(
    ["cloudwatch", "describe-alarms", "--alarm-names", ...i.alarmNames],
    (r) => !r.MetricAlarms?.length && !r.CompositeAlarms?.length,
  );
  checks.discovery =
    (await absence(
      ["servicediscovery", "list-namespaces"],
      (r) =>
        !(r.Namespaces ?? []).some((n) => n.Name === session + ".internal"),
    )) &&
    (await absence(
      [
        "route53",
        "list-hosted-zones-by-name",
        "--dns-name",
        session + ".internal.",
      ],
      (r) =>
        !(r.HostedZones ?? []).some((z) => z.Name === session + ".internal."),
    ));
  checks.network =
    (await absence(
      [
        "ec2",
        "describe-vpcs",
        "--filters",
        "Name=tag:SessionId,Values=" + session,
      ],
      (r) => !r.Vpcs?.length,
    )) &&
    (!i.vpcId ||
      (await absence(
        [
          "ec2",
          "describe-network-interfaces",
          "--filters",
          "Name=vpc-id,Values=" + i.vpcId,
        ],
        (r) => !r.NetworkInterfaces?.length,
      )));
  checks.cleanup =
    (await absence(
      ["lambda", "get-function", "--function-name", i.cleanupFunction],
      () => false,
    )) &&
    (await absence(
      ["scheduler", "get-schedule", "--name", i.cleanupSchedule],
      () => false,
    ));
  checks.iam =
    Array.isArray(i.iamRoleNames) &&
    (
      await Promise.all(
        i.iamRoleNames.map((name) =>
          absence(["iam", "get-role", "--role-name", name], () => false),
        ),
      )
    ).every(Boolean);
  checks.bootstrap = false;
  if (config.bootstrap) {
    checks.bootstrap =
      (await absence(
        ["s3api", "head-bucket", "--bucket", config.bootstrap.stateBucket],
        () => false,
      )) &&
      (await absence(
        [
          "ecr",
          "describe-repositories",
          "--repository-names",
          "p14-retail-integration",
        ],
        (r) => !r.repositories?.length,
      )) &&
      (await absence(
        ["iam", "get-role", "--role-name", "p14-delivery"],
        () => false,
      )) &&
      (await absence(
        [
          "iam",
          "get-open-id-connect-provider",
          "--open-id-connect-provider-arn",
          config.bootstrap.oidcProviderArn,
        ],
        () => false,
      )) &&
      (await absence(
        [
          "budgets",
          "describe-budget",
          "--account-id",
          config.context.expectedAccount,
          "--budget-name",
          "p14-gross-monthly",
        ],
        () => false,
      ));
  }
  return checks;
}
export function destroyPhases(clients, resumed = false) {
  let sessionComplete = resumed;
  return async () => {
    if (!sessionComplete) {
      await clients.session();
      await clients.recordSession();
      sessionComplete = true;
    }
    await clients.bootstrap();
  };
}
export async function supervisorClients(config) {
  if (
    !supervisorBinding(config) ||
    sha(await readFile(config.configFile)) !== config.context.configSha256
  )
    throw new Error("supervisor_binding");
  if (
    config.bootstrap &&
    (config.bootstrap.stateBucket !== config.stateBucket ||
      config.bootstrap.oidcProviderArn !==
        `arn:aws:iam::${config.context.expectedAccount}:oidc-provider/token.actions.githubusercontent.com`)
  )
    throw new Error("bootstrap_binding");
  await mkdir(".local/logs", { recursive: true });
  const request = { ...config.request, action: "destroy" },
    context = {
      ...config.context,
      now: new Date().toISOString(),
      actualAccount: await identity(config.context.expectedAccount),
      inventory: inventory(request, config.context),
    };
  const guard = validateDelivery(request, context);
  if (!guard.allowed) throw new Error(guard.code);
  const phaseFile = `.local/session-destroyed-${request.sessionId}.json`;
  const phaseBinding = sha(
    JSON.stringify({
      sessionId: request.sessionId,
      sourceCommit: request.sourceCommit,
      imageDigest: request.imageDigest,
      accountId: context.actualAccount,
      configSha256: context.configSha256,
      stateBucket: config.stateBucket,
    }),
  );
  let resumed = false;
  try {
    const receipt = await jsonFile(phaseFile);
    if (
      receipt.phase !== "session_destroyed" ||
      receipt.binding !== phaseBinding
    )
      throw new Error("destroy_phase_binding");
    resumed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let heartbeatAt = 0;
  return {
    async heartbeat() {
      if (Date.now() - heartbeatAt < 30000) return;
      await identity(context.expectedAccount);
      const ready = {
        sessionId: request.sessionId,
        sourceCommit: request.sourceCommit,
        imageDigest: request.imageDigest,
        accountId: context.actualAccount,
        configSha256: context.configSha256,
        cleanupAt: context.cleanupAt,
        sessionEnd: context.sessionEnd,
        at: new Date().toISOString(),
      };
      await save(".local/supervisor-ready.json", ready);
      const r = await aws(
        "s3api",
        "put-object",
        "--bucket",
        config.stateBucket,
        "--key",
        `supervision/${request.sessionId}/ready.json`,
        "--body",
        ".local/supervisor-ready.json",
        "--server-side-encryption",
        "AES256",
      );
      if (r.code !== 0) throw new Error("heartbeat_failed");
      heartbeatAt = Date.now();
    },
    async cleanup() {
      await identity(context.expectedAccount);
      const { cleanupCostDrivers, awsCleanupClients } =
        await import("../dist/src/operations/cleanup.js");
      await cleanupCostDrivers(context.inventory, awsCleanupClients());
    },
    destroy: destroyPhases(
      {
        session: () => destroySession(config),
        recordSession: () =>
          save(phaseFile, {
            phase: "session_destroyed",
            binding: phaseBinding,
          }),
        async bootstrap() {
          if (config.bootstrap) {
            await identity(context.expectedAccount);
            await emptyBucket(config.bootstrap.stateBucket);
            const imageResult = await aws(
              "ecr",
              "list-images",
              "--repository-name",
              "p14-retail-integration",
              "--output",
              "json",
            );
            if (
              imageResult.code !== 0 &&
              !responseIsAbsent(imageResult, () => false)
            )
              throw new Error("ecr_inspect");
            const images =
              imageResult.code === 0 ? JSON.parse(imageResult.stdout) : {};
            if (images.imageIds?.length) {
              await save(".local/ecr-delete.json", images.imageIds);
              const r = await aws(
                "ecr",
                "batch-delete-image",
                "--repository-name",
                "p14-retail-integration",
                "--image-ids",
                "file://.local/ecr-delete.json",
              );
              if (r.code !== 0) throw new Error("ecr_delete");
            }
            await terraformOperation(
              context,
              "destroy",
              [
                "-chdir=infra/bootstrap",
                "destroy",
                "-input=false",
                "-auto-approve",
                "-var-file=../../" + config.bootstrap.configFile,
              ],
              ".local/logs/bootstrap-destroy.log",
            );
          }
        },
      },
      resumed,
    ),
    verify: () => verifyClosure(config),
  };
}
async function publish() {
  const { request, context } = await prepare(true);
  await identity(context.expectedAccount);
  if (
    (await must("git", ["rev-parse", "HEAD"])).trim() !==
      request.sourceCommit ||
    (await must("git", ["status", "--porcelain"])).trim()
  )
    throw new Error("source_dirty");
  const repository = `${context.expectedAccount}.dkr.ecr.ap-southeast-2.amazonaws.com/p14-retail-integration`,
    tag = repository + ":source-" + request.sourceCommit;
  await must(
    "docker",
    [
      "build",
      "--target",
      "runtime",
      "--build-arg",
      "SOURCE_COMMIT=" + request.sourceCommit,
      "-t",
      tag,
      ".",
    ],
    { log: ".local/logs/image-build.log" },
  );
  await must("docker", ["tag", tag, "p14-runtime:offline"]);
  await must("docker", ["compose", "--profile", "test", "build", "tooling"], {
    log: ".local/logs/tooling-build.log",
  });
  await must(
    "docker",
    [
      "compose",
      "--profile",
      "test",
      "run",
      "--rm",
      "tooling",
      "npm",
      "run",
      "check",
    ],
    { log: ".local/logs/check.log" },
  );
  await must(
    "docker",
    [
      "compose",
      "-f",
      "compose.yaml",
      "-f",
      "compose.image.yaml",
      "--profile",
      "test",
      "run",
      "--rm",
      "tooling",
      "npm",
      "run",
      "test:one",
      "--",
      "tests/integration/image.test.ts",
    ],
    { log: ".local/logs/image-smoke.log", timeout: 420000 },
  );
  context.now = new Date().toISOString();
  if (!validateDispatch(request, context).allowed) throw new Error("deadline");
  await identity(context.expectedAccount);
  await login(repository.split("/")[0]);
  try {
    await must("docker", ["push", tag], { log: ".local/logs/image-push.log" });
  } finally {
    await command("docker", ["logout", repository.split("/")[0]]);
  }
  const image = await awsJson(
    "ecr",
    "describe-images",
    "--repository-name",
    "p14-retail-integration",
    "--image-ids",
    "imageTag=source-" + request.sourceCommit,
  );
  const digest = image.imageDetails?.[0]?.imageDigest;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
    throw new Error("image_digest");
  await save(".local/published-image.json", {
    sourceCommit: request.sourceCommit,
    imageDigest: digest,
    sessionId: request.sessionId,
  });
  return {
    allowed: true,
    code: "image_published",
    sourceCommit: request.sourceCommit,
    imageDigest: digest,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result =
      process.argv[2] === "prepare"
        ? await prepare(false)
        : process.argv[2] === "prepare-publication"
          ? await prepare(true)
          : process.argv[2] === "publish"
            ? await publish()
            : process.argv[2] === "execute"
              ? await execute()
              : (() => {
                  throw new Error("invalid_action");
                })();
    process.stdout.write(
      JSON.stringify(
        result.request ? { allowed: true, code: "prepared" } : result,
      ) + "\n",
    );
  } catch {
    process.stderr.write(
      '{"allowed":false,"code":"session_operation_failed"}\n',
    );
    process.exitCode = 1;
  }
}
