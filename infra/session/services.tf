resource "aws_ecs_cluster" "session" {
  name = var.session_id
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
  configuration {
    execute_command_configuration { logging = "DEFAULT" }
  }
}
locals {
  image = "${var.image_repository_url}@${var.image_digest}"
  common_environment = [
    { name = "AWS_MODE", value = "true" },
    { name = "AWS_REGION", value = var.region },
    { name = "SESSION_ID", value = var.session_id },
    { name = "SOURCE_COMMIT", value = var.source_commit },
    { name = "DEMO_MODE", value = "true" },
    { name = "API_HOST", value = "127.0.0.1" },
    { name = "DATABASE_OPTIONS", value = "?sslmode=verify-full&sslrootcert=/app/config/rds-ca.pem" },
    { name = "RECEIVER_ORIGIN", value = "http://receiver.${aws_service_discovery_private_dns_namespace.session.name}:3001" }
  ]
  log_options    = { "awslogs-group" = aws_cloudwatch_log_group.session.name, "awslogs-region" = var.region }
  base_container = { image = local.image, essential = true, readonlyRootFilesystem = false, linuxParameters = { initProcessEnabled = true }, stopTimeout = 15 }
}
resource "aws_ecs_task_definition" "application" {
  family                   = "${var.session_id}-application"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution["application"].arn
  task_role_arn            = aws_iam_role.application.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  # Both containers share the task execution role. Limit it to their two secrets.
  container_definitions = jsonencode([
    merge(local.base_container, { name = "api", command = ["api"], cpu = 256, memory = 512, environment = local.common_environment, secrets = [{ name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime["application"].arn}:database_url::" }, { name = "DEMO_TOKEN", valueFrom = "${aws_secretsmanager_secret.runtime["application"].arn}:demo_token::" }], logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { "awslogs-stream-prefix" = "api" }) }, healthCheck = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/v1/deliveries',{headers:{authorization:'Bearer '+process.env.DEMO_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 20 } }),
    merge(local.base_container, { name = "receiver", command = ["receiver"], cpu = 256, memory = 512, environment = concat(local.common_environment, [{ name = "RECEIVER_HOST", value = "0.0.0.0" }, { name = "PORT", value = "3001" }]), secrets = [{ name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime["receiver"].arn}:database_url::" }], portMappings = [{ containerPort = 3001, hostPort = 3001, protocol = "tcp" }], logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { "awslogs-stream-prefix" = "receiver" }) }, healthCheck = { command = ["CMD-SHELL", "node -e 'process.kill(1,0)'"], interval = 30, timeout = 5, retries = 3 } })
  ])
}
resource "aws_iam_role_policy" "receiver_execution" {
  role   = aws_iam_role.execution["application"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.runtime["receiver"].arn }] })
}
resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.session_id}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.worker.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge(local.base_container, { name = "worker", command = ["worker"], cpu = 256, memory = 512, environment = concat(local.common_environment, [{ name = "SOURCE_QUEUE_URL", value = aws_sqs_queue.source.url }, { name = "DLQ_URL", value = aws_sqs_queue.dlq.url }]), secrets = [{ name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.runtime["worker"].arn}:database_url::" }, { name = "RECEIVER_TOKENS", valueFrom = "${aws_secretsmanager_secret.runtime["worker"].arn}:receiver_tokens::" }], logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { "awslogs-stream-prefix" = "worker" }) }, healthCheck = { command = ["CMD-SHELL", "node -e 'process.kill(1,0)'"], interval = 30, timeout = 5, retries = 3 } })])
}
resource "aws_ecs_task_definition" "maintenance" {
  family                   = "${var.session_id}-maintenance"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution["maintenance"].arn
  task_role_arn            = aws_iam_role.maintenance.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge(local.base_container, { name = "maintenance", command = ["migrate"], cpu = 512, memory = 1024, environment = concat(local.common_environment, [{ name = "DATABASE_HOST", value = aws_db_instance.demo.address }, { name = "DATABASE_USER", value = "p14owner" }, { name = "DATABASE_NAME", value = "retaildemo" }]), secrets = [{ name = "DATABASE_PASSWORD", valueFrom = "${aws_db_instance.demo.master_user_secret[0].secret_arn}:password::" }, { name = "ROLE_PASSWORDS", valueFrom = "${aws_secretsmanager_secret.runtime["maintenance"].arn}:role_passwords::" }, { name = "SEED_DATA", valueFrom = "${aws_secretsmanager_secret.runtime["maintenance"].arn}:seed_data::" }, { name = "LOAD_TOKENS", valueFrom = "${aws_secretsmanager_secret.runtime["maintenance"].arn}:load_tokens::" }], logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { "awslogs-stream-prefix" = "maintenance" }) } })])
}
resource "aws_ecs_service" "application" {
  name                               = "${var.session_id}-application"
  cluster                            = aws_ecs_cluster.session.id
  task_definition                    = aws_ecs_task_definition.application.arn
  desired_count                      = 0
  launch_type                        = "FARGATE"
  enable_execute_command             = true
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  propagate_tags                     = "SERVICE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.application.id]
    assign_public_ip = true
  }
  service_registries { registry_arn = aws_service_discovery_service.receiver.arn }
  # Runtime count is owned by the bounded migration/delivery and cleanup commands.
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.receiver_execution, aws_secretsmanager_secret_version.runtime]
}
resource "aws_ecs_service" "worker" {
  name                               = "${var.session_id}-worker"
  cluster                            = aws_ecs_cluster.session.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = 0
  launch_type                        = "FARGATE"
  enable_execute_command             = true
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
  propagate_tags                     = "SERVICE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = true
  }
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.worker, aws_secretsmanager_secret_version.runtime]
}
