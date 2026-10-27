import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { sha256 } from "../domain/sale.js";
import manifest from "../../fixtures/manifest.json" with { type: "json" };
const exec = promisify(execFile);
export interface Observation {
  caseId: string;
  checks: Record<string, boolean>;
  effects?: number;
  submissionCount?: number;
  tenantLeak?: boolean;
  originalDigestUnchanged?: boolean;
  childRestarted?: boolean;
}
export interface CaseOptions {
  resultDirectory?: string;
}
export interface CaseReport {
  runId: string;
  at: string;
  brisbane: string;
  sourceSha256: string;
  configSha256: string;
  durationMs: number;
  status: "passed" | "failed";
  cases: {
    caseId: string;
    mode: "local" | "aws";
    status: "passed" | "failed" | "not_run";
    checks: Record<string, boolean>;
    note?: string;
  }[];
}
export function evaluateObservation(o: Observation): boolean {
  const c = manifest.cases.find((c) => c.caseId === o.caseId);
  return (
    !!c &&
    c.checks.every((k) => o.checks[k] === true) &&
    o.tenantLeak !== true &&
    o.originalDigestUnchanged !== false &&
    o.childRestarted !== false &&
    (o.effects === undefined || o.effects === 200) &&
    (o.submissionCount === undefined || o.submissionCount === 240)
  );
}
export function reportFromObservations(
  observations: readonly Observation[],
  sourceSha256: string,
  configSha256: string,
): CaseReport {
  const at = new Date();
  const cases: CaseReport["cases"] = manifest.cases.map((c) => {
    const o = observations.find((o) => o.caseId === c.caseId);
    return {
      caseId: c.caseId,
      mode: "local",
      status: o && evaluateObservation(o) ? "passed" : "failed",
      checks: o?.checks ?? {},
    };
  });
  cases.push(
    {
      caseId: "A7",
      mode: "aws",
      status: "not_run",
      checks: {},
      note: "ElasticMQ cannot prove real SQS redrive or AWS alarms.",
    },
    {
      caseId: "A9",
      mode: "aws",
      status: "not_run",
      checks: {},
      note: "CloudWatch query and alarm transition require live execution.",
    },
    {
      caseId: "A12",
      mode: "aws",
      status: "not_run",
      checks: {},
      note: "Deployment and teardown require separate approval.",
    },
  );
  return {
    runId: randomUUID(),
    at: at.toISOString(),
    brisbane: at.toLocaleString("en-AU", {
      timeZone: "Australia/Brisbane",
      hour12: false,
    }),
    sourceSha256,
    configSha256,
    durationMs: 0,
    status: cases.some((c) => c.status === "failed") ? "failed" : "passed",
    cases,
  };
}
async function sourceHash(directory: string): Promise<string> {
  const parts: string[] = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) parts.push(item.name + (await sourceHash(file)));
    else parts.push(item.name + sha256(await readFile(file)));
  }
  return sha256(parts.join("\n"));
}
export async function runCases(options: CaseOptions = {}): Promise<CaseReport> {
  const start = performance.now(),
    dir = options.resultDirectory ?? "results";
  await mkdir(dir, { recursive: true });
  const fingerprint = async () =>
    sha256(
      JSON.stringify(
        await Promise.all(
          ["src", "tests", "migrations", "fixtures"].map(sourceHash),
        ),
      ) + sha256(await readFile("package-lock.json")),
    );
  const initialSource = await fingerprint();
  const files = [
    ...new Set([...manifest.cases.map((c) => c.file), ...manifest.extraFiles]),
  ];
  let output = "",
    success = false;
  try {
    const r = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=tap",
        ...files,
      ],
      { timeout: 240000, maxBuffer: 8 * 1024 * 1024 },
    );
    output = r.stdout;
    success = true;
  } catch (e) {
    output =
      String((e as any).stdout ?? "") + "\n" + String((e as any).stderr ?? "");
  }
  await writeFile(path.join(dir, "acceptance.tap"), output, { mode: 0o600 });
  const finalSource = await fingerprint();
  success = success && initialSource === finalSource;
  const observations = manifest.cases.map((c) => ({
    caseId: c.caseId,
    checks: Object.fromEntries(
      c.checks.map((k) => [
        k,
        success &&
          output
            .split("\n")
            .some(
              (line) =>
                /^ok \d+ - /.test(line) &&
                line.slice(line.indexOf(" - ") + 3) === k,
            ),
      ]),
    ),
  }));
  const report = reportFromObservations(
    observations,
    finalSource,
    sha256(JSON.stringify(manifest)),
  );
  report.durationMs = performance.now() - start;
  await writeFile(
    path.join(dir, "acceptance.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  return report;
}
