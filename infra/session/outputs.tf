output "inventory" {
  value = {
    sessionId                = var.session_id
    accountId                = var.account_id
    region                   = var.region
    sourceCommit             = var.source_commit
    imageDigest              = var.image_digest
    sessionStart             = var.session_start
    cleanupAt                = var.cleanup_at
    sessionEnd               = var.session_end
    clusterArn               = aws_ecs_cluster.session.arn
    serviceArns              = [aws_ecs_service.application.id, aws_ecs_service.worker.id]
    applicationTask          = aws_ecs_task_definition.application.arn
    workerTask               = aws_ecs_task_definition.worker.arn
    maintenanceTask          = aws_ecs_task_definition.maintenance.arn
    dbIdentifier             = aws_db_instance.demo.identifier
    sourceQueue              = aws_sqs_queue.source.url
    dlq                      = aws_sqs_queue.dlq.url
    publicSubnets            = aws_subnet.public[*].id
    maintenanceSecurityGroup = aws_security_group.maintenance.id
    vpcId                    = aws_vpc.session.id
    discoveryNamespace       = aws_service_discovery_private_dns_namespace.session.id
    discoveryService         = aws_service_discovery_service.receiver.id
    backupBucket             = aws_s3_bucket.backup.id
    logGroup                 = aws_cloudwatch_log_group.session.name
    secretArns               = concat([for secret in aws_secretsmanager_secret.runtime : secret.arn], [aws_db_instance.demo.master_user_secret[0].secret_arn])
    alarmNames               = [aws_cloudwatch_metric_alarm.dlq.alarm_name, aws_cloudwatch_metric_alarm.failed.alarm_name]
    cleanupFunction          = aws_lambda_function.cleanup.function_name
    cleanupSchedule          = aws_scheduler_schedule.cleanup.name
  }
}
