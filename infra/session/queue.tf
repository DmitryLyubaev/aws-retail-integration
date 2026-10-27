resource "aws_sqs_queue" "dlq" {
  name                       = "${var.session_id}-dlq"
  fifo_queue                 = false
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  receive_wait_time_seconds  = 20
  visibility_timeout_seconds = 45
}
resource "aws_sqs_queue" "source" {
  name                       = "${var.session_id}-source"
  fifo_queue                 = false
  visibility_timeout_seconds = 45
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5 })
}
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url            = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.source.arn] })
}
