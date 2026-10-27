# Observed offline result

Observed 2026-10-27T11:36:38.657Z UTC (27/10/2026, 21:36:38 Australia/Brisbane).
Run: c6ce4cf6-63ff-43f4-9732-9fa7f905206b. This is a synthetic local demonstration.

All A1-A11 local required assertions passed. The run includes real PostgreSQL,
ElasticMQ, HTTP and actual child-process crash/restart checks. Injected faults and
clock/lease changes are explicit test controls. A7 AWS redrive, A9 CloudWatch query
and alarm transition, and A12 hosted delivery/teardown remain **not run**.

| Measurement                              |          Observed |
| ---------------------------------------- | ----------------: |
| Submissions / receiver sales             |         240 / 200 |
| HTTP failures / receiver retries         |             0 / 0 |
| Achieved submissions/second              |              5.02 |
| API p50 / p95 milliseconds               |     11.82 / 35.43 |
| Receiver commit p50 / p95 milliseconds   |  698.00 / 1098.00 |
| Drain after last submission milliseconds |             34.56 |
| Load duration milliseconds               |          47839.00 |
| Harness CPU user / system milliseconds   | 5052.87 / 1233.35 |
| Harness RSS bytes / database connections |     229847040 / 9 |
| Backup bytes / milliseconds              |   169705 / 627.98 |
| Restore and comparison milliseconds      |            225.25 |

The fixed sample is 200 unique sales plus 40 duplicates, two tenants, five
submissions per second and at most five concurrent requests. It is one local
sample, with process-level CPU and memory observations. AWS/container metrics,
costs and performance are unmeasured. No capacity or availability claim follows.

The 200-sale dataset restored into a different logical database with fresh empty
queues. Every application and receiver table hash matched before resubmission.
Resubmitting a known sale returned its existing delivery; the receiver retained
200 sales. Separate restore tests verified grants and refusal of original targets,
busy datasets and a corrupt dump hash. This is a logical restore on one server.

Source/tests/migrations/fixtures/lock hash: 6bfd5a2488fa03f75086e9553432b6b73d78a6b60c7aff5357cfc0dfa4cd19a4.
Acceptance manifest hash: 4d6abdc2448eae59a2708c6d06c0d527fc620d193a9ee8430a4c76133922bff6.
Load dataset hash: ecc8ce5f9f55d36082c106733be8a795a232252426a44203b62f5148776151c9.
Dump hash: 8f97860ac7f49afdf8365a904633fe0c020ab992b5078c08edceb0d824e8b06b.
Canonical backup/restored dataset hash: 3c9d0fde88317812d5107b7d8edbe7f4e61f99b3f0f66d1b91149f578c9ed8ef.

Private raw receipts are retained in ignored results/runs/c6ce4cf6-63ff-43f4-9732-9fa7f905206b/,
including acceptance.tap, acceptance.json, load.json, restore.json and load.dump.
Reproduce with npm run demo:offline in the Compose tooling container.
The acceptance runner refuses source changes during a run and missing/skipped
required assertions. Local evidence cannot mark AWS acceptance complete.
