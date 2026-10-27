# Verification record

Final offline verification passed on 27 October 2026 against review-fix
commit `0467062437273f582321bea698f72a0c1a7a6b73`. The ordinary suite ran 104 tests:
103 passed and the one Docker-socket image profile was intentionally skipped there.
That profile ran separately and passed across all nine runtime modes. A separate
47-check acceptance run passed with no skipped required checks; both Terraform
stacks validated and all eight mocked runs passed. Independent review found no Critical, six Important and two Minor issues.
All six Important issues were reproduced RED and fixed GREEN in one pass; the
full suite and rebuilt image passed afterwards. No second review was performed.

| Check                                                                                         | Actual result                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `docker compose --profile test build --no-cache tooling`                                      | Fresh baseline ba354c0 locked dependency/build stages passed                                |
| `docker compose --profile test run --rm tooling npm ci --ignore-scripts --no-audit --no-fund` | 101 packages installed from the lockfile at baseline ba354c0                                |
| `docker compose --profile test run --rm tooling npm run check`                                | Format, strict typecheck, build, 103 pass / 1 image-profile skip                            |
| `docker compose --profile test run --rm tooling npm run build:cleanup`                        | Lambda bundle built                                                                         |
| Runtime build with exact `SOURCE_COMMIT`                                                      | Image label equals tested implementation commit                                             |
| Compose image-profile `image.test.ts`                                                         | Passed, all modes; runtime SQL roles and three clean SIGTERM exits                          |
| `docker compose --profile test run --rm tooling npm run demo:offline`                         | 47/47 required checks, 240 submissions / 200 effects, logical restore passed                |
| `node scripts/infra.mjs`                                                                      | Both fmt/init-backend-disabled/validate checks, 2 bootstrap + 6 session mock runs passed    |
| `git diff --check`                                                                            | Passed                                                                                      |
| Intended public tree/history scan                                                             | No matching secrets/private-employer references; all commits use approved personal identity |

Observed runtime: Node v24.22.1; pg_dump (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+2).
Docker reported image size: 211262327 bytes. Local engine image ID:
`sha256:17b7cb54b4efc4bac0e8ff1e5bb82622b9a20d6257ead93c82f61d1ad33a27b4`. This is local image evidence, not an ECR publication claim.
The built image's compiled evidence runner completed the same required acceptance
checks without installing production dev dependencies. Runtime roles observed:
`p14_app` and `p14_receiver`; migrations under the app role were refused.

Acceptance run `cebb9691-cd10-4373-8325-7205e7f4f290` completed at 2026-10-27T12:14:20.883Z UTC
(27/10/2026, 22:14:20 Australia/Brisbane). The run preserves its raw TAP,
measurements and dump under ignored `results/runs/cebb9691-cd10-4373-8325-7205e7f4f290/`.
The final identity scan covered 137 tracked files and branch history. An initial loose
pattern matched the public `typescript-7` npm URL; word-boundary checking confirmed
that was unrelated to private material. This heuristic scan is not a security audit.

The observed local load/restore sample is in [offline-report.md](offline-report.md).
Raw receipts are ignored and private. Image evidence is in `results/image.json`
and its named `results/image-*` directory. Pure delivery/supervisor tests also
cover rejected PR/fork/account/source/image/plan/deadline/inventory, failed
migration, fresh heartbeat binding and partial closure.

Terraform 1.15.8 host initialization succeeded on Windows. Provider schema/test
calls failed in local gRPC TLS with x509 unknown authority; exact cause is unproven.
TLS stayed enabled. The pinned official Linux image ran validate and all eight
mocked tests successfully with AWS 6.70.0/Archive 2.8.1 and both platform lock hashes.
No Windows provider-test success is claimed.

Official action tags resolved through their GitHub repository API on 27 October:

| Action tag                               | Pinned commit                            |
| ---------------------------------------- | ---------------------------------------- |
| actions/checkout v6                      | d23441a48e516b6c34aea4fa41551a30e30af803 |
| actions/setup-node v6                    | 249970729cb0ef3589644e2896645e5dc5ba9c38 |
| actions/upload-artifact v5               | 330a01c490aca151604b8cf639adc76d48f6c5d4 |
| aws-actions/configure-aws-credentials v5 | 61815dcd50bd041e203e49132bacad1fd04d2708 |
| hashicorp/setup-terraform v3             | b9cd54a3c349d3f38e8881555d616ced269862dd |

Not run: hosted CI, real AWS plan/apply, identity/OIDC setup, Free plan topology
availability, ECS/RDS/SQS/CloudWatch acceptance, actual charges or verified teardown.
Workflow files, mocks and an account registration do not establish those results.

Final review corrections preserve raw CLI bytes, pass the configured CA path to
PostgreSQL backup/restore subprocesses, finalize in-flight attempts on publish
exhaustion, use canonical workflow timestamps matching real Terraform validation,
bound Terraform lifecycle commands by the session deadlines with a 45-minute
maximum and forced process termination, and resume partial bootstrap destruction
using a session/config/account-bound private phase receipt. Timeout tests ran
without AWS provisioning. Phase receipts do not establish actual resource absence;
the separate closure probes remain required.

Deferred minor findings: the failed metric omits some terminal transitions outside
the consumer, so SQL history is authoritative; interactive CLI examples lack a
complete provisioning/environment recipe, while the automated demo is runnable.
Neither is a new production requirement. Live AWS results remain unverified.
