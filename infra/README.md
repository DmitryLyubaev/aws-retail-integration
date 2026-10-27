# Offline infrastructure checks

Build the cleanup bundle with `npm run build:cleanup` in the tooling container,
then run `node scripts/infra.mjs` from the product repository. Windows uses a
pinned official Terraform 1.15.8 Linux container through the existing WSL Docker
engine; Linux CI uses that exact Terraform version natively. Providers are locked
for Windows and Linux: AWS 6.70.0 and Archive 2.8.1.

Only formatting, `init -backend=false -lockfile=readonly`, validation and mocked
tests run. Every test provider is mocked. The successful session test uses a
mock-only apply to resolve computed dependent values, while negative tests use
mocked plans. No real AWS plan/apply, profile or backend initialization occurs.
Raw local logs go to ignored `results/infra-*.log`.

Windows host init succeeded, but provider schema/test calls failed at their local
gRPC TLS handshake with x509 unknown authority on 27 October 2026. The exact
Windows trust cause is unproven. TLS was kept enabled and checks were moved to
Linux. A Windows success is not claimed.

Bootstrap creates private versioned encrypted state storage, immutable ECR,
repository/environment-bound OIDC and gross cost alerts. Its owner-managed state
starts local and private. Session state uses S3 native locking and encryption;
live backend bucket/key parameters are supplied only after owner approval.

Session services start at desired count zero. The reviewed delivery command owns
starting exactly one application task and one worker after migration and seed
success. Terraform ignores desired_count because those runtime counts, including
cleanup zero, must not be reset by subsequent plans. No autoscaling exists.

The application task contains loopback API and private receiver processes using
separate SQL roles. Its execution role reads only their two injected secrets.
The worker and owner-only maintenance task have separate task/execution roles.
ECR authorization, ECS Exec channel creation and selected create/list APIs require
wildcard resources; the remaining runtime permissions name the owned resources.
The bootstrap Terraform role is privileged operator access for this personal
demo. Protected environment approval and exact-account/source/plan guards remain
required. This does not create an IAM boundary for fictional tenants.

The master DB secret is RDS-managed and separate from the four runtime/maintenance
secrets. Generated role/tenant credentials are sensitive Terraform inputs and
remain in private encrypted state. Task definitions contain secret references,
not their plaintext values. Maintenance constructs its verified TLS connection
from injected master-secret parts. Recheck Free plan access, supported DB minor
version/CA, IAM operations, budget activation and the saved plan during live
preflight. Mocked tests cannot prove those live properties.

The hour-four Scheduler invokes a Lambda with immutable cluster/service/database
configuration. It ignores event-supplied targets, checks ownership, stops/scales
the dedicated tasks and requests DB deletion. In-progress deletion fails visibly
for a later bounded retry. Scheduler delivery has a one-hour event age; Lambda
asynchronous events have a 900-second age and two retries. This reduces running
costs; full closure also requires the independent supervisor, Terraform
reconciliation and the resource inventory
checks described in the live runbook. Approval of these definitions does not
authorize provisioning, identity changes, public publication or paid upgrades.
