locals {
  cluster_arn  = "arn:aws:ecs:${var.region}:${var.account_id}:cluster/${var.session_id}"
  service_arns = [for name in ["application", "worker"] : "arn:aws:ecs:${var.region}:${var.account_id}:service/${var.session_id}/${var.session_id}-${name}"]
  database_arn = "arn:aws:rds:${var.region}:${var.account_id}:db:${var.session_id}"
}
data "archive_file" "cleanup" {
  type        = "zip"
  source_file = "${path.module}/../../build/cleanup/index.cjs"
  output_path = "${path.module}/../../build/cleanup.zip"
}
resource "aws_iam_role" "cleanup" {
  name               = "${var.session_id}-cleanup"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "cleanup" {
  role = aws_iam_role.cleanup.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecs:DescribeClusters"], Resource = local.cluster_arn },
    { Effect = "Allow", Action = ["ecs:DescribeServices", "ecs:UpdateService"], Resource = local.service_arns },
    { Effect = "Allow", Action = ["ecs:ListTasks"], Resource = "*", Condition = { ArnEquals = { "ecs:cluster" = local.cluster_arn } } },
    { Effect = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"], Resource = "arn:aws:ecs:${var.region}:${var.account_id}:task/${var.session_id}/*" },
    { Effect = "Allow", Action = ["rds:DescribeDBInstances", "rds:ListTagsForResource", "rds:DeleteDBInstance"], Resource = local.database_arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.session.arn}:*" }
  ] })
}
resource "aws_lambda_function" "cleanup" {
  function_name                  = "${var.session_id}-cleanup"
  role                           = aws_iam_role.cleanup.arn
  runtime                        = "nodejs24.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.cleanup.output_path
  source_code_hash               = data.archive_file.cleanup.output_base64sha256
  timeout                        = 180
  memory_size                    = 256
  reserved_concurrent_executions = -1
  environment { variables = { CLEANUP_CONFIG = jsonencode({ sessionId = var.session_id, clusterArn = local.cluster_arn, serviceArns = local.service_arns, dbIdentifier = var.session_id }) } }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.session.name
  }
  depends_on = [aws_iam_role_policy.cleanup]
}
resource "aws_iam_role" "scheduler" {
  name               = "${var.session_id}-scheduler"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = var.account_id }, ArnEquals = { "aws:SourceArn" = "arn:aws:scheduler:${var.region}:${var.account_id}:schedule-group/default" } } }] })
}
resource "aws_lambda_function_event_invoke_config" "cleanup" {
  function_name                = aws_lambda_function.cleanup.function_name
  maximum_event_age_in_seconds = 900
  maximum_retry_attempts       = 2
}
resource "aws_iam_role_policy" "scheduler" {
  role   = aws_iam_role.scheduler.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_function.cleanup.arn }] })
}
resource "aws_scheduler_schedule" "cleanup" {
  name                         = "${var.session_id}-cleanup"
  schedule_expression          = "at(${substr(var.cleanup_at, 0, 19)})"
  schedule_expression_timezone = "UTC"
  action_after_completion      = "DELETE"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.cleanup.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = "{}"
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 12
    }
  }
  depends_on = [aws_iam_role_policy.scheduler, aws_lambda_function_event_invoke_config.cleanup]
}
