# Architecture and failure boundaries

The API validates raw UTF-8 JSON before accepting a sale. It rejects unknown
fields, invalid calendars, unsupported versions/currency, unsafe quantities,
invalid minor-unit strings and inconsistent totals. It preserves original bytes
and their SHA-256. A separate canonical business digest excludes transport event
ID while retaining line order.

One PostgreSQL transaction creates the tenant/business identity, event alias,
generation, audit event and outbox row. Concurrent equal submissions return the
same delivery. Changed business content or a reused conflicting event alias
returns 409 and leaves no partial accepted work. Tenant scope comes from bearer
credentials, with separate submit/read/replay/fault permissions.

The publisher leases due outbox rows and sends only references to the queue.
SQL remains authoritative for amounts and original bytes. A crash after acceptance
or after send/before publish marking remains recoverable; duplicate messages are
expected. Five publish failures terminate that generation without editing input.

The worker validates every envelope and digest, reserves one attempt transactionally,
then performs HTTP outside the SQL transaction. It uses a 30-second lease, fencing
token and five-second HTTP timeout. Visibility is 45 seconds; long polling is 20.
There are at most five reserved business attempts per generation, waits of
2/5/10/20 seconds and one absolute 300-second lifetime. Retry-After cannot extend
that lifetime. Expired/stale completions cannot replace a newer terminal outcome.

The receiver has a separate schema and SQL credential. Its transaction inserts
the sale and durable response receipt under tenant/sale-reference and delivery
uniqueness. Repeated equal input returns that receipt. A committed sale followed
by a dropped connection can therefore reconcile on retry with one durable effect.
Unknown outcomes are preserved as `delivery_unconfirmed` at exhaustion/deadline.

Replay requires a failed current generation, expected generation and tenant-scoped
request ID. It creates the next generation/outbox/audit transactionally. Repeated
identical requests retain that result, while changed reuse or stale generations
conflict. Original bytes, business digest and receiver key remain fixed.

SQS receive-count exhaustion is distinct from business-attempt exhaustion. The
collector stores a bounded message/body hash before acknowledgement. Poison,
unknown and forged references cannot fabricate a sale or fail an unrelated delivery.
An old-generation dead letter cannot fail a newer replay or delivered result.

Logs admit only bounded correlation fields and codes. Five EMF metrics share one
session dimension. Metric emission is best effort; durable SQL history is the
authoritative delivery record. Backup requires stopped writers/workers and drained
SQL/queue state. Restore refuses original targets and verifies canonical table
hashes and grants before a known-sale duplicate check.

The local queue emulator establishes local adapter/recovery behaviour. It does
not prove real SQS redrive, CloudWatch ingestion/alarms, IAM, Fargate, RDS availability,
network behaviour or AWS teardown. Those require a separately approved live run.

The proposed AWS task contains loopback API plus a private receiver, with a
separate worker task and private Single-AZ database. Fargate public IPv4 provides
outbound access through restricted security groups; there is no public API ingress,
NAT or ALB. Receiver discovery uses private Cloud Map DNS. RDS connections require
verified TLS; receiver HTTP stays private and is explicitly synthetic.

One database server hosts both schemas, so server-failure independence is not
demonstrated. Runtime credentials/privileges are distinct; the application role
cannot write receiver sales and the receiver cannot read application tables.
ECS Exec is privileged owner access that can inspect container secrets. It is not
an IAM security boundary for fictional tenants. API tenant checks are tested
directly, including pooled connection reuse; database RLS is outside scope.
