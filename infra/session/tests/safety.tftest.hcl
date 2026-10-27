mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "111122223333" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::111122223333:role/p14-synthetic" } }
  mock_resource "aws_secretsmanager_secret" { defaults = { arn = "arn:aws:secretsmanager:ap-southeast-2:111122223333:secret:p14-synthetic-abcdef" } }
  mock_resource "aws_cloudwatch_log_group" { defaults = { arn = "arn:aws:logs:ap-southeast-2:111122223333:log-group:/p14/p14-synthetic" } }
  mock_resource "aws_ecs_cluster" { defaults = { arn = "arn:aws:ecs:ap-southeast-2:111122223333:cluster/p14-synthetic" } }
  mock_resource "aws_service_discovery_service" { defaults = { arn = "arn:aws:servicediscovery:ap-southeast-2:111122223333:service/srv-synthetic" } }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:ap-southeast-2:111122223333:p14-synthetic", url = "https://sqs.ap-southeast-2.amazonaws.com/111122223333/p14-synthetic" } }
  mock_resource "aws_lambda_function" { defaults = { arn = "arn:aws:lambda:ap-southeast-2:111122223333:function:p14-synthetic-cleanup" } }
  mock_resource "aws_db_instance" { defaults = { address = "synthetic.database.invalid", master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-southeast-2:111122223333:secret:synthetic-master" }] } }
}
mock_provider "archive" {}
variables {
  account_id           = "111122223333"
  session_id           = "p14-synthetic"
  source_commit        = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  image_digest         = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  image_repository_url = "111122223333.dkr.ecr.ap-southeast-2.amazonaws.com/p14"
  state_bucket         = "p14-example-private-state"
  session_start        = "2030-01-01T00:00:00Z"
  cleanup_at           = "2030-01-01T04:00:00Z"
  session_end          = "2030-01-01T06:00:00Z"
  role_passwords       = { migrator = "synthetic_migrator_password", application = "synthetic_application_password", receiver = "synthetic_receiver_password" }
  operator_tokens      = { retailer-a = "synthetic_operator_a_000000000000000000", retailer-b = "synthetic_operator_b_000000000000000000" }
  receiver_tokens      = { retailer-a = "synthetic_receiver_a_000000000000000000", retailer-b = "synthetic_receiver_b_000000000000000000" }
}
run "initial_services_stopped" {
  # Mock-only application resolves dependent computed ARNs; no AWS provider calls.
  command = apply
  assert {
    condition     = aws_ecs_service.application.desired_count == 0 && aws_ecs_service.worker.desired_count == 0 && aws_ecs_service.application.deployment_maximum_percent == 100 && aws_ecs_service.application.deployment_minimum_healthy_percent == 0
    error_message = "Services must start stopped and avoid deployment overlap."
  }
  assert {
    condition     = aws_ecs_task_definition.application.cpu == "512" && aws_ecs_task_definition.application.memory == "1024" && aws_ecs_task_definition.worker.cpu == "256" && aws_ecs_task_definition.worker.memory == "512"
    error_message = "Task sizes exceed the bounded model."
  }
  assert {
    condition     = !aws_db_instance.demo.publicly_accessible && !aws_db_instance.demo.multi_az && aws_db_instance.demo.allocated_storage == 20 && aws_db_instance.demo.storage_type == "gp3" && aws_db_instance.demo.storage_encrypted
    error_message = "Database must be private, small, encrypted and Single-AZ."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.receiver.from_port == 3001 && aws_vpc_security_group_ingress_rule.receiver.referenced_security_group_id == aws_security_group.worker.id && length(aws_security_group.application.ingress) == 0
    error_message = "Only the worker may reach the receiver; the API has no ingress."
  }
  assert {
    condition     = !aws_sqs_queue.source.fifo_queue && aws_sqs_queue.source.visibility_timeout_seconds == 45 && aws_sqs_queue.source.receive_wait_time_seconds == 20 && aws_sqs_queue.source.message_retention_seconds == 86400 && aws_sqs_queue.dlq.message_retention_seconds == 345600 && jsondecode(aws_sqs_queue.source.redrive_policy).maxReceiveCount == 5
    error_message = "Queue timing and redrive must match the delivery contract."
  }
  assert {
    condition     = aws_scheduler_schedule.cleanup.flexible_time_window[0].mode == "OFF" && aws_scheduler_schedule.cleanup.target[0].retry_policy[0].maximum_event_age_in_seconds == 3600 && aws_lambda_function.cleanup.runtime == "nodejs24.x"
    error_message = "The bounded hour-four fallback is required."
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.cleanup.maximum_event_age_in_seconds == 900 && aws_lambda_function_event_invoke_config.cleanup.maximum_retry_attempts == 2
    error_message = "Lambda asynchronous retries must also fit within the remaining session window."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.worker.policy, "sqs:*") && strcontains(aws_ecs_task_definition.application.container_definitions, "sslmode=verify-full") && aws_cloudwatch_log_group.session.retention_in_days == 1
    error_message = "Scoped queue access, verified DB TLS and short logs are required."
  }
}
run "wrong_region" {
  command = plan
  variables { region = "us-east-1" }
  expect_failures = [var.region]
}
run "wrong_account" {
  command = plan
  variables {
    account_id           = "999900001111"
    image_repository_url = "999900001111.dkr.ecr.ap-southeast-2.amazonaws.com/p14"
  }
  expect_failures = [terraform_data.identity]
}
run "mutable_image" {
  command = plan
  variables { image_digest = "latest" }
  expect_failures = [var.image_digest]
}
run "missing_source" {
  command = plan
  variables { source_commit = "" }
  expect_failures = [var.source_commit]
}
run "late_cleanup" {
  command = plan
  variables { cleanup_at = "2030-01-01T05:00:00Z" }
  expect_failures = [var.cleanup_at]
}
