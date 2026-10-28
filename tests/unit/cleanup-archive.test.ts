import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as session from "../../scripts/aws-session.mjs";

// A valid empty ZIP and its independently calculated SHA256, not the helper's hash.
const zip = Buffer.from("UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==", "base64");
const plannedHash = "hznHbmgfkAkjuQDJ3w73XPQh05yrtUZQxLmtGbanbYU=";
const transfer = (session as any).transferCleanupArchive;

async function fixture(work: (f: any) => Promise<void>) {
  assert.equal(
    typeof transfer,
    "function",
    "saved-plan cleanup archive transfer is required",
  );
  const directory = await mkdtemp(path.join(tmpdir(), "p14-cleanup-archive-"));
  const planned = path.join(directory, "plan-job");
  const applied = path.join(directory, "fresh-apply-job");
  const storage = path.join(directory, "private-storage");
  await Promise.all([planned, applied, storage].map((p) => mkdir(p)));
  const archiveFile = path.join(planned, "cleanup.zip");
  const downloaded = path.join(applied, "build", "cleanup.zip");
  await writeFile(archiveFile, zip);
  const plan = {
    resource_changes: [
      {
        address: "aws_lambda_function.cleanup",
        mode: "managed",
        change: { after: { source_code_hash: plannedHash } },
      },
    ],
  };
  let failRender = false;
  let failDownload = false;
  const ok = { code: 0, stdout: "{}", stderr: "" };
  const run = async (binary: string, args: string[]) => {
    if (binary === "terraform")
      return failRender
        ? { code: 1, stdout: "", stderr: "plan rendering failed" }
        : { ...ok, stdout: JSON.stringify(plan) };
    assert.equal(binary, "aws");
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const stored = path.join(storage, value("--bucket"), value("--key"));
    const operation = args[args.indexOf("s3api") + 1];
    if (operation === "put-object") {
      if (value("--server-side-encryption") !== "AES256")
        return { code: 1, stdout: "", stderr: "unencrypted uploads refused" };
      await mkdir(path.dirname(stored), { recursive: true });
      await copyFile(value("--body"), stored);
      return ok;
    }
    assert.equal(operation, "get-object");
    if (failDownload) return { code: 1, stdout: "", stderr: "access denied" };
    await copyFile(stored, args.at(-1)!);
    return ok;
  };
  const options = {
    stateBucket: "p14-private-test-state",
    planKey: "plans/p14-test/source/plan.bin",
    planFile: path.join(directory, "approved-plan.bin"),
    archiveFile,
  };
  const stored = path.join(
    storage,
    "p14-private-test-state",
    options.planKey + ".cleanup.zip",
  );
  try {
    await work({
      options,
      downloaded,
      stored,
      plan,
      run,
      failRender: () => {
        failRender = true;
      },
      failDownload: () => {
        failDownload = true;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a fresh apply job obtains the exact ZIP bound to the saved Lambda plan", () =>
  fixture(async ({ options, downloaded, stored, run }) => {
    await transfer("plan", options, run);
    assert.deepEqual(await readFile(stored), zip);
    await assert.rejects(readFile(downloaded), { code: "ENOENT" });
    await transfer("apply", { ...options, archiveFile: downloaded }, run);
    assert.deepEqual(await readFile(downloaded), zip);
  }));

test("changed ZIP bytes cannot be substituted for the approved plan archive", () =>
  fixture(async ({ options, downloaded, stored, run }) => {
    await transfer("plan", options, run);
    await writeFile(stored, Buffer.concat([zip, Buffer.from("changed")]));
    await assert.rejects(
      transfer("apply", { ...options, archiveFile: downloaded }, run),
      /cleanup_archive/,
    );
  }));

test("a plan without the cleanup Lambda digest cannot publish an unbound archive", () =>
  fixture(async ({ options, stored, plan, run }) => {
    delete plan.resource_changes[0].change.after.source_code_hash;
    await assert.rejects(transfer("plan", options, run), /cleanup_archive/);
    await assert.rejects(readFile(stored), { code: "ENOENT" });
  }));

test("a missing generated ZIP prevents plan artifact publication", () =>
  fixture(async ({ options, stored, run }) => {
    await assert.rejects(
      transfer(
        "plan",
        { ...options, archiveFile: options.archiveFile + ".missing" },
        run,
      ),
    );
    await assert.rejects(readFile(stored), { code: "ENOENT" });
  }));

test("a failed private archive download cannot reach an apply-ready result", () =>
  fixture(async ({ options, downloaded, run, failDownload }) => {
    await transfer("plan", options, run);
    failDownload();
    await assert.rejects(
      transfer("apply", { ...options, archiveFile: downloaded }, run),
      /cleanup_archive/,
    );
    await assert.rejects(readFile(downloaded), { code: "ENOENT" });
  }));

test("a failed saved-plan render cannot publish a cleanup archive", () =>
  fixture(async ({ options, stored, run, failRender }) => {
    failRender();
    await assert.rejects(transfer("plan", options, run), /cleanup_archive/);
    await assert.rejects(readFile(stored), { code: "ENOENT" });
  }));
