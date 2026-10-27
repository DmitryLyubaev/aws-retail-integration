locals {
  task_trust           = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = var.account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:ecs:${var.region}:${var.account_id}:*" } } }] })
  image_repository_arn = "arn:aws:ecr:${var.region}:${var.account_id}:repository/${split("/", var.image_repository_url)[1]}"
}
resource "aws_iam_role" "execution" {
  for_each           = toset(["application", "receiver", "worker", "maintenance"])
  name               = "${var.session_id}-${each.key}-execution"
  assume_role_policy = local.task_trust
}
resource "aws_iam_role_policy" "execution" {
  for_each = aws_iam_role.execution
  role     = each.value.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = local.image_repository_arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.session.arn}:*" },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.runtime[each.key].arn] }
  ], each.key == "maintenance" ? [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_db_instance.demo.master_user_secret[0].secret_arn] }] : []) })
}
resource "aws_iam_role" "application" {
  name               = "${var.session_id}-application"
  assume_role_policy = local.task_trust
}
resource "aws_iam_role" "worker" {
  name               = "${var.session_id}-worker"
  assume_role_policy = local.task_trust
}
resource "aws_iam_role" "maintenance" {
  name               = "${var.session_id}-maintenance"
  assume_role_policy = local.task_trust
}
resource "aws_iam_role_policy" "exec" {
  for_each = { application = aws_iam_role.application.id, worker = aws_iam_role.worker.id, maintenance = aws_iam_role.maintenance.id }
  role     = each.value
  # ECS Exec channel APIs do not support resource-level permissions.
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"], Resource = "*" }] })
}
resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = aws_sqs_queue.source.arn },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.source.arn, aws_sqs_queue.dlq.arn] }
  ] })
}
resource "aws_iam_role_policy" "maintenance" {
  role = aws_iam_role.maintenance.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["sqs:GetQueueAttributes"], Resource = [aws_sqs_queue.source.arn, aws_sqs_queue.dlq.arn] },
    { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.backup.arn}/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.backup.arn }
  ] })
}
