# Local synthetic demonstration

Run Docker Compose through the existing Linux Docker engine. On Windows, prefix
commands with `wsl -d Ubuntu --cd /mnt/e/Projects/aws-retail-integration --`.

```sh
docker compose --profile test run --rm tooling npm run check
docker compose --profile test run --rm tooling npm run demo:offline
```

The harness creates isolated PostgreSQL databases and fresh ElasticMQ queues,
exercises real HTTP, and removes its local test resources in `finally` blocks.
It writes private raw TAP, load measurements, a logical dump and restore manifest
under ignored `results/`. Inputs and required check names are frozen in
`fixtures/cases.json` and `fixtures/manifest.json`. Run after changes to prevent
source and evidence drift. Source hashes cover source, tests, migrations, fixtures and the package lock, while the manifest
hash identifies the declared checks and fixed load configuration.

The load sample submits 200 synthetic sales and 40 duplicates across two tenants
at five submissions per second, with at most five concurrent HTTP requests. It
measures API latency, receiver commit latency, drain time, errors, retries, process
CPU, resident memory and database connections. These are local harness process
observations. Container CPU/memory and AWS RDS/ECS metrics require live evidence.
This single sample makes no capacity or availability promise.

Crash tests kill actual worker/publisher child processes at named barriers. Lease
expiry and the late-restart clock are deliberate, labelled fault injections.
The receiver commit/drop fault is persisted once. The ordinary CLI never changes
SQL to force a successful result. The small restore fixture labels its explicitly
drained setup; the load restore uses the fully delivered 200-sale dataset.

## CLI

Start `node dist/src/main.js api`, `receiver` and `worker` with separate role
database URLs. `migrate` and `seed` are owner-only maintenance commands. Set
`DEMO_TOKEN` or `DEMO_CREDENTIAL_FILE` privately, and `DEMO_API_ORIGIN` to the API.

```sh
node dist/src/main.js cli submit --file fixtures/cases.json --json
node dist/src/main.js cli list --json
node dist/src/main.js cli show --id DELIVERY_UUID --json
node dist/src/main.js cli fault --sale SALE-0001 --mode reject_422
node dist/src/main.js cli fault --sale SALE-0001 --mode accept
node dist/src/main.js cli replay --id DELIVERY_UUID --generation 1 --request-id replay-1
```

All five product commands call authenticated HTTP. Fault controls require explicit
demo mode and an operator token. Tenant identity comes from that token. API binds
loopback by default. AWS mode rejects public API binding, queue endpoint overrides
and static credential environment configuration. Use ECS task credentials only.

## Diagnosis and metrics

Logs allow only timestamp, session, component, bounded code and synthetic
tenant/delivery/generation/attempt IDs, plus optional duration. Original payloads,
tokens and database URLs do not belong in logs. Five EMF metrics share exactly one
`SessionId` dimension: accepted, delivered, retry, failed and outbox-pending.
Use Sum for event counters and Maximum/last observation for the pending gauge.

```sql
-- Internal maintenance read, with explicit synthetic tenant scope.
SELECT generation, at, kind, code, attempt_id
FROM app.audit
WHERE tenant_id = $1 AND delivery_id = $2
ORDER BY id;
```

CloudWatch Logs Insights, after a live session exists:

```text
fields @timestamp, component, code, tenantId, deliveryId, generation, attemptId
| filter SessionId = "YOUR_SESSION" and deliveryId = "SYNTHETIC_DELIVERY_UUID"
| sort @timestamp asc
```

Local EMF output does not prove CloudWatch ingestion, queries or alarm transitions.
A7 AWS redrive, A9 CloudWatch and A12 deployment/teardown remain not run locally.

## Logical backup and restore

Stop API writes and workers, drain source/DLQ, and explicitly confirm quiescence.
The maintenance operation checks unfinished generations/outbox/attempts, active
database writers and all three queue counters. AWS counters are approximate, so
the operator must also stop producers/consumers and repeat stable zero observations
before the live backup. It never treats a running producer as safely quiesced.

Use matching PostgreSQL 17 `pg_dump` custom archive and `pg_restore` with a single
transaction. Connection secrets are passed through child environment, not argument
strings. The local dump and manifest are private ignored files. Live mode requires
an explicitly configured private S3 bucket and writes AES256 encrypted objects.
Before restore, verify the dump hash and require a different database identity,
an empty target and two distinct empty queues that reuse neither original queue.
No worker starts inside the restore function. Compare all canonical table hashes
and then resubmit a known sale; grants and receiver effect counts must still hold.

This is a logical database restore on the same database server. It does not
demonstrate RDS snapshots, PITR, new-instance restore or regional recovery.
The commands follow the PostgreSQL 17
[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) and
[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) documentation.
