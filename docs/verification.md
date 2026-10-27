# Verification record

Offline verification is in progress on 27 October 2026. The current completed
baseline is 81 passing application checks, eight mocked Terraform runs, and a
built-image smoke that exercised all nine dispatcher modes and completed the
compiled 47-check acceptance set. Final fresh-install/build checks and independent
whole-branch review are pending; this file will be updated with their receipts.

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
