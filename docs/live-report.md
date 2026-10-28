# Live synthetic AWS demonstration

29 October 2026, Brisbane. One owner-run sample on ECS/Fargate, real SQS and a
private, encrypted Single-AZ RDS PostgreSQL 17.9 instance. The deployed source was
[`329ff16`](https://github.com/DmitryLyubaev/aws-retail-integration/commit/329ff16c9847fee507323080c67bf54ed3e1a7de),
with image digest `sha256:58561a2c0a14343ed5dd7354aae3ae5756d8b8c0285ee5f5654b324b9103d90b`.
The [curated machine-readable evidence](evidence/live-2026-10-29.json) separates
observations, operator corrections and limits. Raw credentials, plans, state,
logs and database dumps remain private.

The [hosted offline check](https://github.com/DmitryLyubaev/aws-retail-integration/actions/runs/40778374515),
[tested private image](https://github.com/DmitryLyubaev/aws-retail-integration/actions/runs/40779349794),
[exact plan](https://github.com/DmitryLyubaev/aws-retail-integration/actions/runs/40780231519)
and [application apply](https://github.com/DmitryLyubaev/aws-retail-integration/actions/runs/40780606308)
passed. Migration and seed exited zero using that image. One application task
and one worker ran with their restricted SQL roles. The CLI was exercised through
ECS Exec; the API had no public ingress. RDS used its actual
`rds-ca-rsa2048-g1` certificate, with hostname and certificate verification.

## Observed acceptance

| Case                  | Live observation                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Validation         | Valid exact amounts produced one receiver effect; invalid input created no accepted work.                                                                                                                        |
| A2 Identity           | Ten simultaneous equal resubmissions retained one identity/effect; changed content and conflicting event identity returned 409.                                                                                  |
| A3 Tenants            | The same sale reference worked independently for two tenants. Cross-tenant read/replay returned 404; submit-only credentials could not read or replay.                                                           |
| A4 Outbox             | Actual publisher child processes were killed after SQL acceptance and after queue send. Restart recovered delivery with unchanged input and one receiver effect.                                                 |
| A5 Lost reply         | The receiver committed and dropped its reply. An actual worker child was killed and restarted; the receiver retained one effect.                                                                                 |
| A6 Retry/replay       | A transient 503 retried successfully. Permanent 422 failure was isolated, then corrected and replayed idempotently into generation two without changing the original hashes.                                     |
| A7 DLQ                | Real SQS redrove a controlled poison after five receives. Its alarm changed from OK to ALARM without forcing state. Collection persisted one matching quarantine record and healthy work still delivered.        |
| A8 Fencing            | Two worker children contended; the stale completion remained fenced and independent SQL checks found one receiver effect.                                                                                        |
| A9 Diagnosis          | An actual CloudWatch query returned accepted, failed and recovered correlation rows for the injected failure.                                                                                                    |
| A10 Load              | The declared 240 submissions produced 200 exact receiver effects, with zero HTTP failures and zero delivery retries.                                                                                             |
| A11 Restore           | An encrypted S3 dump was downloaded, hash-checked and restored into a different logical database. Separate queues and temporary ECS API/worker tasks verified dedupe, tenant isolation and restricted SQL roles. |
| A12 Delivery/teardown | Hosted delivery succeeded. Owner recovery completed teardown, followed by an independent twelve-category absence recheck. The cleanup defect and recovery are recorded below.                                    |

Named process barriers and explicit SQL lease-expiry injections made the crash/race
checks deterministic. These are controlled fault tests. The separate local
47-check suite includes additional fault permutations; this report does not claim
that every local check ran on AWS.

## Declared load sample

The driver ran inside the AWS API container through authenticated loopback HTTP.
It submitted 200 unique sales and 40 duplicates across two tenants at a configured
five submissions/second, with at most five requests in flight. Sample size: one.

| Measurement                               |         Observed |
| ----------------------------------------- | ---------------: |
| Submissions / unique receiver effects     |        240 / 200 |
| Achieved submission rate                  |           5.02/s |
| HTTP failures / delivery retries          |            0 / 0 |
| API p50 / p95                             |   17.6 / 37.4 ms |
| End-to-end p50 / p95                      |   691 / 1,181 ms |
| Drain after last submission               |           162 ms |
| Total sample duration                     |          47.97 s |
| Driver user / system CPU time             |      754 / 47 ms |
| Driver resident memory                    | 99,749,888 bytes |
| Database connections at final observation |               10 |

Driver CPU/RSS describe that process. Actual ECS service and RDS minute aggregates
for the overlapping 08:47-08:49 Brisbane window are retained in the JSON evidence.
They include adjacent seconds; unavailable five-minute credit series remain empty.
This sample establishes neither a capacity ceiling nor an availability SLA.

## Logical restore

The frozen dataset contained 210 application sales and 210 receiver effects,
including the load sample and ten other live fixtures. Source and DLQ counters
were observed at stable zero after pausing the sole owner producers and stopping
the primary worker. The original API continued read-only health/list traffic.

The 177,848-byte custom dump was stored with AES256 encryption in the private
backup bucket, downloaded and verified against its manifest. PostgreSQL 17.11
client tools restored both schemas on the same RDS server. All sixteen table
counts and the canonical dataset hash matched:

`af594fd77cf55df8c079e7b1359475a1fa2615348e237e36ddcb60ba8824bdc0`

Temporary API, receiver and worker connections used `p14_app` and `p14_receiver`
against the restored database. The worker's temporary policy permitted the same
SQS actions only on the two new owned restore queues. It was removed with the
queues, tasks, task definitions and logical database. Known-sale resubmission
preserved its identity, receiver count and dataset hash. This demonstrates a
logical restore on one server; PITR, snapshots and regional recovery were not tested.

## Teardown and remaining limits

The session began at 08:21:02 Brisbane. Its fixed cleanup/closure deadlines were
12:21:02 and 14:21:02. Early teardown passed all twelve absence checks at
09:36:42; an independent recheck passed at 09:42:32. Bootstrap state had zero
managed instances, and owner cleanup/tunnel processes had stopped.

Initial destruction rejected a valid physical inventory because the code checked
STS identity, then discarded that observation before inventory validation. Owner
recovery supplied the freshly verified account without removing the guard. The
bootstrap provider directory also required initialization in the supervisor's
actual environment. Both failure cycles are retained privately. The subsequent
code correction in `a5ef86a` passed missing/stale-account regressions while
preserving rejection of a different actual account or physical inventory. It was
not redeployed into this closed session.

The final regional audit found zero ACTIVE or INACTIVE owned task definitions
across the three known attempts. Seven entries were in AWS-managed
DELETE_IN_PROGRESS metadata retention. The scheduled hour-four fallback did not
fire because the session closed earlier. The protected hosted-destroy workflow
and six-hour credential survival were not exercised by this early teardown.

Operator preparation also required correcting the API forwarding document,
policy-simulation request format and local dump-container UID/GID. Failed
preparations and their cleanup receipts remain distinct from the successful
logical restore. The measured load sample was not rerun or tuned.

The cumulative planning allowance remained USD5 and the gross pre-tax operating
limit USD10, including prior attempts and excluding credit offsets. **Settled
gross billing remains pending.** The account stayed on its Free plan. This
synthetic demonstration makes no production availability, RLS, end-to-end
receiver TLS or commercial AWS-tenure claim.
