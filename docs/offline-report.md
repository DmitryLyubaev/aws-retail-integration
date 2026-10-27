# Observed offline result

Observed 2026-10-27T09:50:47.814Z UTC (27/10/2026, 19:50:47 Australia/Brisbane).
Run: 44714c5d-c445-4609-b0db-c3fb5b05c915. This is a synthetic local demonstration.

All A1-A11 local required assertions passed. The run includes real PostgreSQL,
ElasticMQ, HTTP and actual child-process crash/restart checks. Injected faults and
clock/lease changes are explicit test controls. A7 AWS redrive, A9 CloudWatch query
and alarm transition, and A12 hosted delivery/teardown remain **not run**.

| Measurement                              |          Observed |
| ---------------------------------------- | ----------------: |
| Submissions / receiver sales             |         240 / 200 |
| HTTP failures / receiver retries         |             0 / 0 |
| Achieved submissions/second              |              5.02 |
| API p50 / p95 milliseconds               |     11.81 / 33.94 |
| Receiver commit p50 / p95 milliseconds   |  670.00 / 1051.00 |
| Drain after last submission milliseconds |             35.55 |
| Load duration milliseconds               |          47840.90 |
| Harness CPU user / system milliseconds   | 4962.91 / 1180.13 |
| Harness RSS bytes / database connections |    216932352 / 10 |
| Backup bytes / milliseconds              |   170119 / 337.40 |
| Restore and comparison milliseconds      |            234.83 |

The fixed sample is 200 unique sales plus 40 duplicates, two tenants, five
submissions per second and at most five concurrent requests. It is one local
sample, with process-level CPU and memory observations. AWS/container metrics,
costs and performance are unmeasured. No capacity or availability claim follows.

The 200-sale dataset restored into a different logical database with fresh empty
queues. Every application and receiver table hash matched before resubmission.
Resubmitting a known sale returned its existing delivery; the receiver retained
200 sales. Separate restore tests verified grants and refusal of original targets,
busy datasets and a corrupt dump hash. This is a logical restore on one server.

Source/tests/migrations/fixtures/lock hash: c3a0f3414752a5ccdc7801eaf9fb27bf272812f65364dfefd1cb5567bf4df7cf.
Acceptance manifest hash: 4d6abdc2448eae59a2708c6d06c0d527fc620d193a9ee8430a4c76133922bff6.
Load dataset hash: c12c80cab8094108865e7aa17ac5939a360ffd5bd9707e83d183adc5b188a99f.
Dump hash: c2bff3426a8e36844edde3dd87121d4fad8a5688eade71a355dbe01e874066f3.
Canonical backup/restored dataset hash: ca592b58abd8ef9ba9c783888d843de4373467b89d0259408e63f51582d61227.

Private raw receipts are in ignored results/acceptance.tap,
acceptance.json, load.json, restore.json and load.dump.
Reproduce with npm run demo:offline in the Compose tooling container.
The acceptance runner refuses source changes during a run and missing/skipped
required assertions. Local evidence cannot mark AWS acceptance complete.
