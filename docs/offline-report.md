# Observed offline result

Observed 2026-10-27T12:14:20.883Z UTC (27/10/2026, 22:14:20 Australia/Brisbane).
Run: cebb9691-cd10-4373-8325-7205e7f4f290. This is a synthetic local demonstration.

All A1-A11 local required assertions passed. The run includes real PostgreSQL,
ElasticMQ, HTTP and actual child-process crash/restart checks. Injected faults and
clock/lease changes are explicit test controls. A7 AWS redrive, A9 CloudWatch query
and alarm transition, and A12 hosted delivery/teardown remain **not run**.

| Measurement                              |          Observed |
| ---------------------------------------- | ----------------: |
| Submissions / receiver sales             |         240 / 200 |
| HTTP failures / receiver retries         |             0 / 0 |
| Achieved submissions/second              |              5.02 |
| API p50 / p95 milliseconds               |     12.42 / 36.08 |
| Receiver commit p50 / p95 milliseconds   |  712.00 / 1112.00 |
| Drain after last submission milliseconds |             40.20 |
| Load duration milliseconds               |          47844.60 |
| Harness CPU user / system milliseconds   | 5111.26 / 1256.53 |
| Harness RSS bytes / database connections |    241065984 / 10 |
| Backup bytes / milliseconds              |   170181 / 853.48 |
| Restore and comparison milliseconds      |            297.72 |

The fixed sample is 200 unique sales plus 40 duplicates, two tenants, five
submissions per second and at most five concurrent requests. It is one local
sample, with process-level CPU and memory observations. AWS/container metrics,
costs and performance are unmeasured. No capacity or availability claim follows.

The 200-sale dataset restored into a different logical database with fresh empty
queues. Every application and receiver table hash matched before resubmission.
Resubmitting a known sale returned its existing delivery; the receiver retained
200 sales. Separate restore tests verified grants and refusal of original targets,
busy datasets and a corrupt dump hash. This is a logical restore on one server.

Source/tests/migrations/fixtures/lock hash: 6f0ee19a2ac494a6e36b3bf6e8262f02ae044a457030f42cc6c60124b8962123.
Acceptance manifest hash: 4d6abdc2448eae59a2708c6d06c0d527fc620d193a9ee8430a4c76133922bff6.
Load dataset hash: 91ea9eec315caf0caf17f3a91b996e59e3d18c052dd1eba3fc93adeed16d90a8.
Dump hash: a79548c693fdcd691a06bab38496d17597f74b76601f9aa2094baf2e7420725b.
Canonical backup/restored dataset hash: 570d1fd47b34827c1eda5c264d3ea91549ac3ef4116f93539ee07eb6a4753eaa.

Private raw receipts are retained in ignored results/runs/cebb9691-cd10-4373-8325-7205e7f4f290/,
including acceptance.tap, acceptance.json, load.json, restore.json and load.dump.
Reproduce with npm run demo:offline in the Compose tooling container.
The acceptance runner refuses source changes during a run and missing/skipped
required assertions. Local evidence cannot mark AWS acceptance complete.
