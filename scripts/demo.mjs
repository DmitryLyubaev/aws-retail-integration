import { runCases } from "../dist/src/operations/evidence.js";
const report = await runCases();
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = report.status === "passed" ? 0 : 1;
if (report.status === "passed") await import("./summarize-offline.mjs");
