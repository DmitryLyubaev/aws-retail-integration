import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const image =
  "hashicorp/terraform:1.15.8@sha256:7ae513256f7ce67879e218ae8593d6fbe216ec9e123abe6c94e4e10704857963";
const windows = process.platform === "win32";
const mounted = windows
  ? "/mnt/" + root[0].toLowerCase() + root.slice(2).replaceAll("\\", "/")
  : root;
mkdirSync(path.join(root, "results"), { recursive: true });
for (const stack of ["bootstrap", "session"])
  for (const [label, args] of [
    ["format", ["fmt", "-check", "-recursive"]],
    ["init", ["init", "-backend=false", "-lockfile=readonly"]],
    ["validate", ["validate", "-no-color"]],
    ["test", ["test", "-no-color"]],
  ]) {
    const tfArgs = ["-chdir=infra/" + stack, ...args];
    const command = windows ? "wsl" : "terraform";
    const actual = windows
      ? [
          "-d",
          "Ubuntu",
          "--",
          "docker",
          "run",
          "--rm",
          "-v",
          mounted + ":/work",
          "-w",
          "/work",
          "-e",
          "TF_DATA_DIR=.terraform-linux",
          image,
          ...tfArgs,
        ]
      : tfArgs;
    const start = Date.now();
    const result = spawnSync(command, actual, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        TF_DATA_DIR: ".terraform-linux",
        AWS_EC2_METADATA_DISABLED: "true",
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(
      path.join(root, "results", `infra-${stack}-${label}.log`),
      (result.stdout ?? "") + (result.stderr ?? ""),
      { mode: 0o600 },
    );
    process.stdout.write(
      JSON.stringify({
        stack,
        step: label,
        exit: result.status,
        durationMs: Date.now() - start,
      }) + "\n",
    );
    if (result.status !== 0) {
      process.stderr.write(
        (result.stderr ?? result.stdout ?? "Infrastructure check failed").slice(
          -3000,
        ),
      );
      process.exit(1);
    }
  }
