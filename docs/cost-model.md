# Dated planning estimate

27 October 2026, Sydney ap-southeast-2, USD before tax, six-hour envelope. These
are gross estimates before credits, discounts and free allowances. No AWS usage
or bill has been measured for this project.

| Driver                                             |  Unit estimate USD | Six-hour estimate USD |
| -------------------------------------------------- | -----------------: | --------------------: |
| Fargate CPU, total 0.75 vCPU                       |  0.04856/vCPU-hour |               0.21852 |
| Fargate memory, total 1.5 GiB                      |   0.00532/GiB-hour |               0.04788 |
| Two public IPv4 addresses                          | 0.005/address-hour |               0.06000 |
| RDS PostgreSQL db.t4g.micro, Single-AZ             |         0.025/hour |               0.15000 |
| RDS gp3 20 GiB, 730-hour planning month            |    0.138/GiB-month |               0.02269 |
| Maintenance/race task, 0.5 vCPU/1 GiB and one IPv4 |   0.0346/task-hour |               0.03460 |
| Private hosted zone, reserve full monthly minimum  |    0.50/zone-month |               0.50000 |

Base estimate: approximately **USD1.04**. Planning allowance: **USD5**. Operating
limit: **USD10 before tax**. The owner approved these planning limits; provisioning,
identity changes, paid upgrades and actual expenditure require live approval.

The gross budget covers the personal account, excluding credits, refunds and tax.
The owner creates its alert before billing bootstrap work and imports it into
private Terraform state. This avoids depending on activation of a new allocation
tag during the short session. Other personal AWS usage can cause an earlier stop.

Allow at most 0.2 GB logs (about USD0.134 ingestion plus storage/query), five custom
metrics, two standard alarms, 50,000 SQS request units (about USD0.02), 1 GB ECR
images and 1 GB combined S3 state versions/dump. Include up to six secrets, Cloud
Map registration, API requests, small data transfers, RDS CPU credits, cleanup
controls and contingency. Reprice all drivers and the exact saved plan before
the live session. Credits never enlarge the operating limit.

Excluded from this topology: paid NAT gateway, ALB, interface endpoints, extra RDS
instance, customer-managed KMS key, paid support, Container Insights and enhanced
monitoring. Adding one requires a revised costed plan. The deployment uses public
task IPv4 for outbound access and security groups with no API ingress.

Stop application work and begin teardown at hour four. The scheduled Lambda
reduces primary running costs by scaling/stopping owned ECS tasks and requesting
owned RDS deletion. It fails visibly while DB deletion remains unfinished. It
does not remove all resources or prove full teardown. The independent local
supervisor reconciles state and verifies closure by hour six.

Inspect idle DB/storage/backups/snapshots, public IPv4 and ENIs, ECR images, S3
objects and versions, secrets and their deletion windows, logs, alarms, scheduler,
Lambda, discovery namespace/zone and bootstrap state resources. Retained objects
and minimum charges can outlive stopped compute. Budget alerts are notifications,
not a hard spending cap. Reconcile the actual bill after usage has settled.

Sources: official regional
[ECS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-southeast-2/index.json),
[RDS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-southeast-2/index.json),
[VPC](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/ap-southeast-2/index.json)
price files, and [Route 53](https://aws.amazon.com/route53/pricing/) pricing,
read during design on 27 October 2026. These dated inputs need live revalidation.
