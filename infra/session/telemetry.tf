resource "aws_cloudwatch_log_group" "session" {
  name              = "/p14/${var.session_id}"
  retention_in_days = 1
}
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${var.session_id}-dlq-visible"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
}
resource "aws_cloudwatch_metric_alarm" "failed" {
  alarm_name          = "${var.session_id}-failed"
  namespace           = "Portfolio/RetailIntegration"
  metric_name         = "failed"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { SessionId = var.session_id }
}
