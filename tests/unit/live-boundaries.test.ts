import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = process.cwd();
const linux = { skip: process.platform !== "linux" };
const source = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
async function fixture(
  run: (directory: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "p14-live-boundaries-"));
  try {
    await mkdir(path.join(directory, "bin"));
    const aws = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),services=['sts','s3api','ecr','rds','sqs','ecs','logs','cloudwatch','servicediscovery','route53','ec2','lambda','scheduler','iam','budgets'];
const i=args.findIndex(a=>services.includes(a)),[service,operation]=args.slice(i);
const key=service+' '+operation, opt=(name)=>args[args.indexOf(name)+1];
fs.appendFileSync('aws-calls.jsonl',JSON.stringify({key,args})+String.fromCharCode(10));
const responses=JSON.parse(fs.readFileSync('responses.json'));
if(responses[key]){ const r=responses[key];process.stdout.write(typeof r.stdout==='object'?JSON.stringify(r.stdout):r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.code??0); }
if(key==='s3api get-object'){fs.copyFileSync('config-fixture.json',args.at(-1));process.stdout.write('{}');}
else if(key==='s3api put-object'){const target=path.join('archive',opt('--key'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(opt('--body'),target);process.stdout.write('{}');}
else{process.stderr.write('An error occurred (AccessDenied)');process.exit(254);}
`;
    await writeFile(path.join(directory, "bin/aws"), aws, { mode: 0o755 });
    await writeFile(path.join(directory, "responses.json"), "{}");
    await run(directory, {
      ...process.env,
      PATH: path.join(directory, "bin") + ":" + process.env.PATH,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function deliveryFixture(directory: string) {
  const config = JSON.stringify({
    account_id: "111122223333",
    region: "ap-southeast-2",
    session_id: "p14-synthetic",
    source_commit: source,
    image_digest: digest,
    image_repository_url:
      "111122223333.dkr.ecr.ap-southeast-2.amazonaws.com/p14-retail-integration",
    state_bucket: "p14-synthetic-state",
    cleanup_at: "2030-01-01T04:00:00Z",
    session_end: "2030-01-01T06:00:00Z",
    role_passwords: { migrator: "private-configuration-sentinel" },
  });
  await writeFile(path.join(directory, "config-fixture.json"), config);
  await writeFile(
    path.join(directory, "responses.json"),
    JSON.stringify({
      "sts get-caller-identity": { stdout: { Account: "111122223333" } },
      "ecr get-login-password": { stdout: "synthetic-only-password" },
    }),
  );
  for (const [name, body] of [
    [
      "terraform",
      "if(process.argv.includes('plan')){process.stderr.write('private-terraform-diagnostic');process.exit(42)}",
    ],
    [
      "docker",
      `if(process.argv.includes('inspect'))process.stdout.write(JSON.stringify([{Config:{Labels:{'org.opencontainers.image.revision':'${source}'}}}]))`,
    ],
  ])
    await writeFile(
      path.join(directory, "bin", name!),
      [`#!${process.execPath}`, body, ""].join("\n"),
      { mode: 0o755 },
    );
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "example-owner/aws-retail-integration",
    APPROVED_REPOSITORY: "example-owner/aws-retail-integration",
    GITHUB_SHA: source,
    GITHUB_RUN_ID: "1234",
    DEPLOYMENT_ENVIRONMENT: "aws-demo",
    EXPECTED_ACCOUNT: "111122223333",
    AWS_REGION: "ap-southeast-2",
    STATE_BUCKET: "p14-synthetic-state",
    REQUEST_ACTION: "plan",
    REQUEST_SOURCE: source,
    REQUEST_SESSION: "p14-synthetic",
    REQUEST_IMAGE: digest,
    SESSION_START: "2030-01-01T00:00:00Z",
    CONFIG_KEY: `configs/p14-synthetic/${source}.json`,
    CONFIG_SHA256: createHash("sha256").update(config).digest("hex"),
  };
}
async function runDelivery(
  directory: string,
  env: NodeJS.ProcessEnv,
  input: Record<string, string>,
  overrides: Record<string, string> = {},
) {
  const start = new Date(Math.floor(Date.now() / 1000) * 1000);
  const config = JSON.parse(
    await readFile(path.join(directory, "config-fixture.json"), "utf8"),
  );
  config.cleanup_at = new Date(+start + 14400000)
    .toISOString()
    .replace(".000Z", "Z");
  config.session_end = new Date(+start + 21600000)
    .toISOString()
    .replace(".000Z", "Z");
  const bytes = JSON.stringify(config);
  await writeFile(path.join(directory, "config-fixture.json"), bytes);
  const context = {
    ...env,
    ...input,
    SESSION_START: start.toISOString().replace(".000Z", "Z"),
    CONFIG_SHA256: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
  const args = [path.join(root, "scripts/aws-session.mjs")];
  const prepared = spawnSync(process.execPath, [...args, "prepare"], {
    cwd: directory,
    env: context,
    encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  return spawnSync(process.execPath, [...args, "execute"], {
    cwd: directory,
    env: context,
    encoding: "utf8",
  });
}

test(
  "publication retains its redacted receipt when container results are not writable by the runner",
  linux,
  async () => {
    await fixture(async (directory, env) => {
      await chmod(directory, 0o755);
      await mkdir(path.join(directory, ".local"), { mode: 0o755 });
      const receipt = JSON.stringify({
        sourceCommit: source,
        imageDigest: digest,
        sessionId: "p14-synthetic",
      });
      await writeFile(
        path.join(directory, ".local/published-image.json"),
        receipt,
        { mode: 0o644 },
      );
      await mkdir(path.join(directory, "results"), { mode: 0o555 });
      const runner = path.join(directory, "runner");
      await mkdir(runner, { mode: 0o777 });
      await chmod(runner, 0o777);
      const workflow = (
        await readFile(
          path.join(root, ".github/workflows/publish-image.yml"),
          "utf8",
        )
      ).replaceAll("\r\n", "\n");
      const block = workflow.match(
        /- name: Retain the immutable manifest receipt\n\s+run: \|\n([\s\S]*?)(?=\n\s+- )/,
      )!;
      assert.ok(block);
      const script = block[1]!
        .split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      const result = spawnSync("sh", ["-eu", "-c", script], {
        cwd: directory,
        env: { ...env, RUNNER_TEMP: runner },
        encoding: "utf8",
        ...(process.getuid!() === 0 ? { uid: 65534, gid: 65534 } : {}),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        await readFile(path.join(runner, "p14-image-publication.json"), "utf8"),
        receipt,
      );
    });
  },
);

test(
  "failed delivery retains lifecycle diagnostics only in encrypted session-bound private objects",
  linux,
  async () => {
    await fixture(async (directory, env) => {
      const input = await deliveryFixture(directory);
      const result = await runDelivery(directory, env, input);
      assert.equal(result.status, 1);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /private-terraform-diagnostic|private-configuration-sentinel/,
      );
      assert.ok(
        (
          await readdir(path.join(directory, ".local/logs")).catch(() => [])
        ).includes("terraform-plan.log"),
        JSON.stringify({
          result,
          calls: await readFile(
            path.join(directory, "aws-calls.jsonl"),
            "utf8",
          ).catch(() => "none"),
          context: await readFile(
            path.join(directory, ".local/context.json"),
            "utf8",
          ).catch(() => "none"),
        }),
      );
      assert.match(
        await readFile(
          path.join(directory, ".local/logs/terraform-plan.log"),
          "utf8",
        ),
        /private-terraform-diagnostic/,
      );
      const target = path.join(
        directory,
        "archive/evidence/p14-synthetic",
        source,
        "1234/terraform-plan.log",
      );
      assert.match(
        await readFile(target, "utf8"),
        /private-terraform-diagnostic/,
      );
      const calls = (
        await readFile(path.join(directory, "aws-calls.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((x) => JSON.parse(x));
      const uploads = calls.filter((x) => x.key === "s3api put-object");
      assert.ok(uploads.length >= 2);
      for (const upload of uploads) {
        assert.equal(
          upload.args[upload.args.indexOf("--bucket") + 1],
          "p14-synthetic-state",
        );
        assert.equal(
          upload.args[upload.args.indexOf("--server-side-encryption") + 1],
          "AES256",
        );
        assert.doesNotMatch(
          upload.args.join(" "),
          /session\.json|plan\.bin|tfstate/,
        );
      }
      assert.deepEqual((await readdir(path.dirname(target))).sort(), [
        "delivery-summary.json",
        "image-pull.log",
        "terraform-init.log",
        "terraform-plan.log",
      ]);
    });
  },
);

test(
  "failed private evidence upload preserves the failed delivery decision",
  linux,
  async () => {
    await fixture(async (directory, env) => {
      const input = await deliveryFixture(directory);
      const file = path.join(directory, "responses.json");
      const responses = JSON.parse(await readFile(file, "utf8"));
      responses["s3api put-object"] = {
        code: 254,
        stderr: "An error occurred (AccessDenied): private-upload-error",
      };
      await writeFile(file, JSON.stringify(responses));
      const result = await runDelivery(directory, env, input);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /"code":"upload_failed"/);
      assert.match(result.stderr, /session_operation_failed/);
      assert.doesNotMatch(
        result.stderr,
        /private-upload-error|private-terraform-diagnostic/,
      );
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(directory, ".local/delivery-summary.json"),
            "utf8",
          ),
        ).code,
        "plan_failed",
      );
    });
  },
);

test(
  "wrong account or unverified private configuration cannot upload failure evidence",
  linux,
  async () => {
    for (const scenario of ["wrong-account", "config-hash", "bucket-binding"]) {
      await fixture(async (directory, env) => {
        const input = await deliveryFixture(directory);
        if (scenario === "wrong-account") {
          const file = path.join(directory, "responses.json");
          const responses = JSON.parse(await readFile(file, "utf8"));
          responses["sts get-caller-identity"].stdout.Account = "999900001111";
          await writeFile(file, JSON.stringify(responses));
        }
        if (scenario === "bucket-binding") {
          const file = path.join(directory, "config-fixture.json");
          const config = JSON.parse(await readFile(file, "utf8"));
          config.state_bucket = "p14-unreviewed-state";
          await writeFile(file, JSON.stringify(config));
        }
        const result = await runDelivery(
          directory,
          env,
          input,
          scenario === "config-hash" ? { CONFIG_SHA256: "f".repeat(64) } : {},
        );
        assert.equal(result.status, 1);
        assert.match(result.stderr, /unverified_binding/);
        const calls = (
          await readFile(path.join(directory, "aws-calls.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x));
        assert.equal(
          calls.some((x) => x.key === "s3api put-object"),
          false,
        );
      });
    }
  },
);
