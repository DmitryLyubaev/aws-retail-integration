import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function discover(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? discover(`${dir}/${e.name}`)
          : e.name.endsWith(".test.ts")
            ? [`${dir}/${e.name}`]
            : [],
      ),
    )
  ).flat();
}
const files = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    ...(files.length ? files : (await discover("tests")).sort()),
  ],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
