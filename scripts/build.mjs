import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("build/cleanup", { recursive: true });
await build({
  entryPoints: ["src/operations/cleanup.ts"],
  outfile: "build/cleanup/index.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: true,
});
