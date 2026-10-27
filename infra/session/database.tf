resource "aws_db_subnet_group" "session" {
  name       = var.session_id
  subnet_ids = aws_subnet.database[*].id
}
resource "aws_db_parameter_group" "session" {
  name   = var.session_id
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}
resource "aws_db_instance" "demo" {
  identifier                   = var.session_id
  engine                       = "postgres"
  engine_version               = "17"
  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  storage_type                 = "gp3"
  storage_encrypted            = true
  db_name                      = "retaildemo"
  username                     = "p14owner"
  manage_master_user_password  = true
  publicly_accessible          = false
  multi_az                     = false
  db_subnet_group_name         = aws_db_subnet_group.session.name
  parameter_group_name         = aws_db_parameter_group.session.name
  vpc_security_group_ids       = [aws_security_group.database.id]
  backup_retention_period      = 0
  delete_automated_backups     = true
  deletion_protection          = false
  skip_final_snapshot          = true
  performance_insights_enabled = false
  monitoring_interval          = 0
  auto_minor_version_upgrade   = true
  copy_tags_to_snapshot        = true
}
locals {
  database_suffix = "@${aws_db_instance.demo.address}:5432/retaildemo?sslmode=verify-full&sslrootcert=/app/config/rds-ca.pem"
  seed_data = {
    application = [for tenant in ["retailer-a", "retailer-b"] : { tenantId = tenant, actorId = "operator", permissions = ["submit", "read", "replay", "fault"], token = var.operator_tokens[tenant] }]
    receiver    = concat([for tenant in ["retailer-a", "retailer-b"] : { tenantId = tenant, actorId = "operator", permissions = ["fault"], purpose = "operator", token = var.operator_tokens[tenant] }], [for tenant in ["retailer-a", "retailer-b"] : { tenantId = tenant, actorId = "integration", permissions = ["submit"], purpose = "integration", token = var.receiver_tokens[tenant] }])
  }
  runtime_secrets = {
    application = jsonencode({ database_url = "postgresql://p14_app:${var.role_passwords.application}${local.database_suffix}", demo_token = var.operator_tokens["retailer-a"] })
    receiver    = jsonencode({ database_url = "postgresql://p14_receiver:${var.role_passwords.receiver}${local.database_suffix}" })
    worker      = jsonencode({ database_url = "postgresql://p14_app:${var.role_passwords.application}${local.database_suffix}", receiver_tokens = jsonencode(var.receiver_tokens) })
    maintenance = jsonencode({ role_passwords = jsonencode(var.role_passwords), seed_data = jsonencode(local.seed_data), load_tokens = jsonencode([var.operator_tokens["retailer-a"], var.operator_tokens["retailer-b"]]) })
  }
}
resource "aws_secretsmanager_secret" "runtime" {
  for_each                = toset(["application", "receiver", "worker", "maintenance"])
  name                    = "${var.session_id}-${each.key}"
  recovery_window_in_days = 0
}
resource "aws_secretsmanager_secret_version" "runtime" {
  for_each      = aws_secretsmanager_secret.runtime
  secret_id     = each.value.id
  secret_string = local.runtime_secrets[each.key]
}
resource "aws_s3_bucket" "backup" {
  bucket        = "${var.session_id}-${var.account_id}-backup"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "backup" {
  bucket                  = aws_s3_bucket.backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  bucket = aws_s3_bucket.backup.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "backup" {
  bucket = aws_s3_bucket.backup.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.backup.arn, "${aws_s3_bucket.backup.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
