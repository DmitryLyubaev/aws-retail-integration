# Gated AWS session runbook

This document is a future execution contract. Offline implementation approval
does not authorize AWS provisioning, identity/security changes, a Paid plan
upgrade, public repository creation/push or hosted execution. A live run requires
the owner to approve those concrete actions and their costed saved plans first.

## Readiness and ownership

1. Confirm the personal account's actual ID through STS and the console, selected
   Sydney region, current plan/credit balance, gross usage and expiry. Verify ECS
   Fargate/Exec, RDS PostgreSQL 17/db.t4g.micro, SQS, Secrets Manager, Cloud Map,
   Scheduler, Lambda Node 24 and required networking are available on that plan.
   Stop for an owner decision if an upgrade or topology change is required.
2. The owner secures root with MFA and establishes short-lived non-root operator
   access. Root credentials and permanent access keys are not deployment inputs.
   Verify the operator is the approved personal account before any write.
3. Establish a Linux operator environment with Node 24.22.1, Terraform 1.15.8,
   AWS CLI v2, Docker/Compose and Session Manager plugin for ECS Exec. Prove the
   credential profile can refresh across the six-hour envelope. Windows Terraform
   provider TLS failed locally; its native host path is not a verified fallback.
   Installing tools or changing access is a separate owner action.
4. Before anything can bill, create the `p14-gross-monthly` account-wide USD10
   budget alert with the owner's email, excluding credits, refunds and tax. Then
   import that owned budget into private bootstrap state before its first apply.
   It does not wait for activation of new cost-allocation tags. Other personal
   account usage counts conservatively. Alerts and credits do not enforce a cap.
5. Approve publication scope explicitly. Only then create/push the product repo,
   run hosted offline CI and configure protected `aws-demo`: required owner review,
   deployment branch restricted to `main`, `APPROVED_REPOSITORY` variable and
   environment secrets `AWS_ACCOUNT_ID`, `AWS_ROLE_ARN`, `AWS_STATE_BUCKET`.
   Resolve every identity to the same personal account. Do not import a shared
   GitHub OIDC provider or shared project resources into this disposable bootstrap.

Before preparing bootstrap inputs, read the repository's actual OIDC subject
format and immutable IDs:

```sh
gh api repos/DmitryLyubaev/aws-retail-integration/actions/oidc/customization/sub
gh api repos/DmitryLyubaev/aws-retail-integration --jq '{repository: .full_name, github_owner_id: (.owner.id | tostring), github_repository_id: (.id | tostring)}'
```

Set `github_owner_id` and `github_repository_id` in the private bootstrap
configuration from that verified response. Confirm `use_immutable_subject` is
true and `sub_claim_prefix` matches
`repo:OWNER@OWNER_ID/aws-retail-integration@REPOSITORY_ID`. The trust policy adds
`:environment:aws-demo` and keeps the exact `sts.amazonaws.com` audience. New
repositories use this immutable format; do not disable it to match a legacy
name-only trust. These IDs are public GitHub metadata, not AWS credentials.

The dated [cost model](cost-model.md) reserves approximately USD1.04 base, USD5
planning allowance and USD10 operating limit before tax, without credit offsets.
Reprice the actual saved plan. No NAT, ALB, interface endpoints, extra database,
customer-managed KMS key, Container Insights or enhanced monitoring is included.

## Bootstrap and source-bound image

Keep all account identifiers, generated credentials, budget recipient, state,
plans and unredacted logs in ignored `.local/` with private permissions. Generate
distinct high-entropy SQL role passwords, two tenant operator tokens and two
receiver integration tokens. No credentials go in command arguments or public CI
artifacts. Sensitive Terraform values remain in private state and Secrets Manager.

Prepare `.local/bootstrap.json` matching `infra/bootstrap/variables.tf`. With the
approved personal operator identity, initialize the local bootstrap backend,
import `aws_budgets_budget.session` using `ACCOUNT_ID:p14-gross-monthly`, review a
saved bootstrap plan and obtain owner approval for its first billing apply and
OIDC changes. Save the non-secret outputs privately as
`.local/bootstrap-output.json`. Verify state bucket privacy, versioning/encryption,
immutable ECR, exact repository/environment trust and the budget subscription.

Run the protected **Publish tested private image** workflow for the exact current
main commit, unique `p14-...` session ID and approved UTC start. It checks local
dispatch before OIDC, verifies STS account, builds/tests/smokes that exact source,
then pushes its private immutable source tag. Retain the returned manifest digest.
The redacted publication receipt is copied through `RUNNER_TEMP`, so a container's
ownership of checkout `results/` cannot prevent its GitHub artifact upload.
Publication is preparatory: plan/apply never replace the requested image digest.
One failed image push is not permission for an unbounded rebuild/storage loop.

## Exact session plan and independent cleanup

Choose one UTC start and never reuse a closed session ID. Cleanup starts exactly
four hours later and verified closure is due at hour six. No script extends them.

Create `.local/session.json` matching `infra/session/variables.tf`, including the
exact account/region/source/ECR manifest, bootstrap state bucket, role passwords,
tenant credentials and all three timestamps. Hash the file and upload it privately
with AES256 encryption to `configs/SESSION/SOURCE_COMMIT.json` in the state bucket.
Review its sensitive contents locally. Check the RDS engine minor/CA availability,
the pinned public CA bundle and the precise current prices before accepting a plan.

Dispatch **Reviewed AWS plan or apply**, action `plan`, with that exact source,
digest, session, start, private config key and SHA-256. Only private S3 receives
the plan binary and receipt. Download both privately and render the plan locally.
Check every resource, quantity, network rule, initial service count zero, task
sizes, gross budget and cleanup schedule. The receipt binds repository/ref,
environment, account, region, source, image, configuration, plan hash and deadlines.

Before action `apply`, start the independent local supervisor under the owner's
short-lived profile, which must survive deletion of the CI delivery role. Keep
its private terminal and credential refresh available until closure. Build local
dependencies, compiled sources and cleanup first. Create `.local/supervisor.json`
from the reviewed plan receipt and configuration with these fields:

- `sessionId`, `cleanupAt`, `sessionEnd` copied unchanged from the receipt;
- `request`: `action: apply`, source/session/image, exact private `planKey` and
  `planSha256`;
- `context`: recorded `eventName: workflow_dispatch`, `ref: refs/heads/main`, exact
  `repository`/`approvedRepository`, `environment: aws-demo`, `expectedAccount`,
  `region`, source/image, config SHA and both deadlines;
- `stateBucket`, `configFile: .local/session.json`,
  `inventoryFile: .local/inventory.json`;
- `bootstrap`: owned `stateBucket`, exact `oidcProviderArn` from bootstrap outputs
  and `configFile: .local/bootstrap.json`. Retain its original local Terraform state.

The context is the recorded, owner-reviewed dispatch, not authority supplied by
a fictional tenant. The supervisor validates binding/account/configuration before
writes. Launch it in the operator environment:

```sh
node scripts/supervise-cleanup.mjs .local/supervisor.json
```

Closure inventory validation uses a fresh STS account observation. The recorded
`expectedAccount` remains the approved account; an omitted or stale `actualAccount`
field does not replace that observation.

It writes an encrypted private readiness heartbeat every 30 seconds. Apply requires
a matching heartbeat no older than 60 seconds. A heartbeat error remains visible
and does not cancel the absolute cleanup loop. Independently, the AWS hour-four
Scheduler/Lambda stops/scales only the configured owned cluster/services/tasks and
requests owned RDS deletion. Scheduler delivery age is one hour; Lambda async age
is 900 seconds with two retries. Neither fallback claims full teardown.

Dispatch action `apply` only after reviewing that exact saved plan, supplying its
key/hash and explicit reviewed-plan flag. No replacement plan is generated. Migration
and seed run as one-off owner tasks with recorded exit codes. Failure prevents
service start; compute is stopped while evidence remains available. Success enables
exactly one application and one worker. Counts cannot be restarted after cleanup
has begun. The independent supervisor remains active through failed stages.

## Live acceptance and evidence

Verify actual task image/source, application/worker counts, migration/seed receipts,
private DNS and verified RDS TLS. Run A1-A12 against the deployed services with
invented data. Use owner ECS Exec into the API container for the loopback CLI;
pass application credentials through environment/private files, not arguments.
Maintenance load/backup needs separate owner SQL access. If injected temporarily
into an Exec process, keep it private, remove the temporary file afterwards and
retain only redacted command/audit evidence. Runtime API/receiver/worker processes
continue using their restricted SQL roles.

Record real SQS redrive/quarantine and a DLQ visible-message alarm transition.
Trace an injected failure through delivery/history and the documented CloudWatch
query. Clear the fault and replay once with its original identity. Repeat the
declared load sample once; report actual rates, latency, errors/retries, drain,
ECS/RDS metrics and sample limits. Local emulator/EMF results cannot substitute.

For logical restore, stop producers/workers, drain SQL and both queues and confirm
stable zero queue observations. Save the encrypted private dump and manifest.
Record the new logical DB and newly created, tagged `SESSION-restore-*` queues
before starting temporary workers. Reuse neither original queue. Compare both
schemas, roles/grants, canonical hashes and a known-sale resubmission. Stop/remove
temporary tasks, queues and logical DB afterwards. This does not demonstrate PITR,
snapshots, another RDS instance or regional recovery.

Export the private acceptance receipts, dump/manifests, query/alarm results and
redacted task/image/migration evidence before deleting stores. The script also
copies current backup objects and a bounded log sample to ignored `.local/export/`;
review any pagination marker and export the remaining required evidence yourself.
Keep plans/state and Exec/database raw logs out of public CI artifacts.

After a delivery failure with verified account and private configuration, selected
lifecycle logs and receipts are retained as AES256 objects under
`evidence/SESSION/SOURCE_COMMIT/GITHUB_RUN_ID/` in the existing private state bucket.
The public job prints only the bounded retention result and original failure.
Configuration, plan binaries and state are excluded from this diagnostic upload;
raw diagnostics never become GitHub artifacts. Retention is best effort and does
not turn a failed deployment or failed upload into success.

Before emptying the bootstrap bucket, the independent owner cleanup exports that
exact session/source evidence prefix to
`.local/export/SESSION/private-delivery/`, with directories mode 0700 and files 0600. An export access/transport failure prevents bootstrap deletion and requires
owner recovery within the original deadline. Preserve this directory with the
other private evidence before preparing any redacted publication.

## Teardown and closure

Begin at hour four even when acceptance fails. After the application window
expires, the protected **Owned AWS session destruction** workflow and independent
owner supervisor remain available within the six-hour closure envelope. Lifecycle
Terraform commands receive at most 45 minutes and stop at the applicable cleanup
or closure deadline. A timed-out apply never starts migration or services. At the
six-hour deadline, unfinished cleanup is a failure requiring immediate owner
recovery with the retained private configuration/state and direct Terraform
destruction; do not extend a workflow session to hide the breach. A successful destruction command only means that command completed;
it is not A12 closure. Do not leave an unverified cleanup unattended.

Inspect the owned inventory, including partial applies and restore extras:

- stop/delete both ECS services, dedicated cluster tasks and temporary maintenance
  tasks; check ENIs and their public IPv4 disappear;
- delete RDS without a final snapshot/automated backup; inspect manual/automated
  snapshots and retained automated backups;
- remove source/DLQ and recorded restore queues, discovery services/instances,
  namespace and private hosted zone;
- export then delete backup objects, state objects, all S3 versions/delete markers,
  ECR images and owned buckets;
- remove four runtime/maintenance secrets and inspect the RDS-managed secret,
  including pending deletion windows;
- remove logs, two alarms, Scheduler, Lambda/async configuration and session IAM roles;
- after session removal, use the independent owner profile to remove the disposable
  bootstrap role/OIDC provider, ECR, state bucket and owned budget. Preserve unrelated
  personal operator access and AWS-managed shared service-linked roles.

Terraform reconciles externally stopped/deleted resources. The supervisor verifies
actual AWS absence by resource/name/tag queries, not merely empty local state.
Access errors, missing inventory or unfinished deletion remain unverified. Retain
`.local/closure.json` and the explicit category checks. `closed_late` records a
deadline breach; partial deletion is not full closure. Closure and later billing
reconciliation must both be reported before claiming the live project complete.
Do not rerun, enlarge the envelope or raise the budget without a new owner decision.

The exact RDS `DBInstanceAutomatedBackupNotFound` response counts as absence.
Successful empty CLI output is accepted only for SQS `ListQueues`, using its own
empty-result predicate. Other empty output, malformed JSON, pagination markers,
interrupted commands and access errors cannot certify closure.

The independent supervisor persists a private, session/config/account-bound
session-destruction phase receipt before removing bootstrap resources. Retain
that receipt with its local state so retries can resume bootstrap removal after
the remote session state bucket has disappeared. Existing absent buckets and ECR
repositories are tolerated; access errors remain failures. The receipt records a
successful Terraform phase only, never complete AWS closure.
