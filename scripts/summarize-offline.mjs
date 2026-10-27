import { format } from "prettier";
import { readFile, writeFile, mkdir, copyFile, chmod } from "node:fs/promises";
const read = async (name) =>
  JSON.parse(await readFile("results/" + name + ".json", "utf8"));
const [acceptance, load, restore] = await Promise.all(
  ["acceptance", "load", "restore"].map(read),
);
if (
  acceptance.status !== "passed" ||
  load.status !== "passed" ||
  restore.dedupeVerified !== true
)
  throw new Error("Evidence is incomplete");
if (!/^[a-f0-9-]{36}$/.test(acceptance.runId))
  throw new Error("Invalid evidence run");
const receipts = "results/runs/" + acceptance.runId;
await mkdir(receipts, { recursive: true });
for (const name of [
  "acceptance.json",
  "acceptance.tap",
  "load.json",
  "restore.json",
  "load.dump",
  "load.dump.manifest.json",
]) {
  await copyFile("results/" + name, receipts + "/" + name);
  await chmod(receipts + "/" + name, 0o600);
}
const n = (value) => Number(value).toFixed(2);
await writeFile(
  "docs/offline-report.md",
  `# Observed offline result

Observed ${acceptance.at} UTC (${acceptance.brisbane} Australia/Brisbane).
Run: ${acceptance.runId}. This is a synthetic local demonstration.

All A1-A11 local required assertions passed. The run includes real PostgreSQL,
ElasticMQ, HTTP and actual child-process crash/restart checks. Injected faults and
clock/lease changes are explicit test controls. A7 AWS redrive, A9 CloudWatch query
and alarm transition, and A12 hosted delivery/teardown remain **not run**.

| Measurement | Observed |
|---|---:|
| Submissions / receiver sales | ${load.submissionCount} / ${load.uniqueReceiverEffects} |
| HTTP failures / receiver retries | ${load.failures} / ${load.retries} |
| Achieved submissions/second | ${n(load.achievedPerSecond)} |
| API p50 / p95 milliseconds | ${n(load.apiP50Ms)} / ${n(load.apiP95Ms)} |
| Receiver commit p50 / p95 milliseconds | ${n(load.endToEndP50Ms)} / ${n(load.endToEndP95Ms)} |
| Drain after last submission milliseconds | ${n(load.drainMs)} |
| Load duration milliseconds | ${n(load.durationMs)} |
| Harness CPU user / system milliseconds | ${n(load.cpuUserMs)} / ${n(load.cpuSystemMs)} |
| Harness RSS bytes / database connections | ${load.rssBytes} / ${load.dbConnections} |
| Backup bytes / milliseconds | ${restore.backup.bytes} / ${n(restore.backup.durationMs)} |
| Restore and comparison milliseconds | ${n(restore.restored.durationMs)} |

The fixed sample is 200 unique sales plus 40 duplicates, two tenants, five
submissions per second and at most five concurrent requests. It is one local
sample, with process-level CPU and memory observations. AWS/container metrics,
costs and performance are unmeasured. No capacity or availability claim follows.

The 200-sale dataset restored into a different logical database with fresh empty
queues. Every application and receiver table hash matched before resubmission.
Resubmitting a known sale returned its existing delivery; the receiver retained
200 sales. Separate restore tests verified grants and refusal of original targets,
busy datasets and a corrupt dump hash. This is a logical restore on one server.

Source/tests/migrations/fixtures/lock hash: ${acceptance.sourceSha256}.
Acceptance manifest hash: ${acceptance.configSha256}.
Load dataset hash: ${load.datasetSha256}.
Dump hash: ${restore.backup.sha256}.
Canonical backup/restored dataset hash: ${restore.restored.datasetSha256}.

Private raw receipts are retained in ignored ${receipts}/,
including acceptance.tap, acceptance.json, load.json, restore.json and load.dump.
Reproduce with npm run demo:offline in the Compose tooling container.
The acceptance runner refuses source changes during a run and missing/skipped
required assertions. Local evidence cannot mark AWS acceptance complete.
`,
);

await writeFile(
  "docs/offline-report.md",
  await format(await readFile("docs/offline-report.md", "utf8"), {
    parser: "markdown",
  }),
);
