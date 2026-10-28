provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags { tags = { Project = "p14", Owner = "personal-portfolio" } }
}
data "aws_caller_identity" "current" {}
resource "terraform_data" "identity" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Actual account differs from owner approval."
    }
  }
}
resource "aws_s3_bucket" "state" {
  bucket        = var.state_bucket
  force_destroy = false
  depends_on    = [terraform_data.identity]
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_ecr_repository" "image" {
  name                 = "p14-retail-integration"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_role" "delivery" {
  name                 = "p14-delivery"
  max_session_duration = 3600
  assume_role_policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Federated = "arn:aws:iam::${var.account_id}:oidc-provider/token.actions.githubusercontent.com" }, Action = "sts:AssumeRoleWithWebIdentity", Condition = { StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = local.github_subject } } }] })
  depends_on           = [aws_iam_openid_connect_provider.github]
}
locals {
  prefix         = "arn:aws"
  regional       = "${var.region}:${var.account_id}"
  github_subject = "repo:${split("/", var.repository)[0]}@${var.github_owner_id}/${split("/", var.repository)[1]}@${var.github_repository_id}:environment:aws-demo"
}
resource "aws_iam_role_policy" "delivery" {
  role = aws_iam_role.delivery.id
  # This owner-only Terraform role is privileged within the named personal demo.
  # Some create/list and ECS Exec APIs have no resource-level authorization.
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucket*", "s3:PutBucket*", "s3:CreateBucket", "s3:DeleteBucket", "s3:DeleteBucketPolicy", "s3:GetEncryptionConfiguration", "s3:PutEncryptionConfiguration", "s3:ListBucketVersions", "s3:TagResource", "s3:UntagResource", "s3:ListTagsForResource", "s3:GetAccelerateConfiguration", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration"], Resource = [aws_s3_bucket.state.arn, "arn:aws:s3:::p14-*"] },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion", "s3:DeleteObjectVersion"], Resource = ["${aws_s3_bucket.state.arn}/*", "arn:aws:s3:::p14-*/*"] },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages", "ecr:BatchDeleteImage"], Resource = aws_ecr_repository.image.arn },
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:PassRole", "iam:UpdateAssumeRolePolicy"], Resource = "arn:aws:iam::${var.account_id}:role/p14-*" },
    { Effect = "Allow", Action = ["iam:CreateServiceLinkedRole"], Resource = "arn:aws:iam::${var.account_id}:role/aws-service-role/*", Condition = { StringEquals = { "iam:AWSServiceName" = ["ecs.amazonaws.com", "rds.amazonaws.com", "servicediscovery.amazonaws.com"] } } },
    { Effect = "Allow", Action = ["ecs:CreateCluster", "ecs:DeleteCluster", "ecs:DescribeClusters", "ecs:UpdateCluster", "ecs:PutClusterCapacityProviders", "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:DescribeServices", "ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:TagResource", "ecs:UntagResource", "ecs:ListTagsForResource", "ecs:ExecuteCommand"], Resource = ["arn:aws:ecs:${local.regional}:cluster/p14-*", "arn:aws:ecs:${local.regional}:service/p14-*/*", "arn:aws:ecs:${local.regional}:task/p14-*/*", "arn:aws:ecs:${local.regional}:task-definition/p14-*:*", "arn:aws:ecs:${local.regional}:container-instance/p14-*/*"] },
    { Effect = "Allow", Action = ["ecs:RegisterTaskDefinition", "ecs:ListTasks", "ecs:DescribeTaskDefinition", "ecs:DeregisterTaskDefinition", "ec2:Describe*"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    { Effect = "Allow", Action = ["ec2:CreateVpc", "ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateInternetGateway", "ec2:CreateSecurityGroup", "ec2:CreateTags"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region }, StringLike = { "aws:RequestTag/Project" = "p14" } } },
    { Effect = "Allow", Action = ["ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup"], Resource = "arn:aws:ec2:${local.regional}:vpc/*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region, "aws:ResourceTag/Project" = "p14" } } },
    { Effect = "Allow", Action = ["ec2:ModifyVpcAttribute", "ec2:DeleteVpc", "ec2:DeleteSubnet", "ec2:ModifySubnetAttribute", "ec2:DeleteRouteTable", "ec2:CreateRoute", "ec2:DeleteRoute", "ec2:AssociateRouteTable", "ec2:DisassociateRouteTable", "ec2:AttachInternetGateway", "ec2:DetachInternetGateway", "ec2:DeleteInternetGateway", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress", "ec2:DeleteSecurityGroup", "ec2:DeleteTags"], Resource = ["arn:aws:ec2:${local.regional}:vpc/*", "arn:aws:ec2:${local.regional}:subnet/*", "arn:aws:ec2:${local.regional}:route-table/*", "arn:aws:ec2:${var.region}::internet-gateway/*", "arn:aws:ec2:${local.regional}:internet-gateway/*", "arn:aws:ec2:${local.regional}:security-group/*", "arn:aws:ec2:${local.regional}:security-group-rule/*"], Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    { Effect = "Allow", Action = ["rds:CreateDBInstance", "rds:ModifyDBInstance", "rds:DeleteDBInstance", "rds:AddTagsToResource", "rds:RemoveTagsFromResource", "rds:ListTagsForResource", "rds:CreateDBSubnetGroup", "rds:DeleteDBSubnetGroup", "rds:DescribeDBSubnetGroups", "rds:CreateDBParameterGroup", "rds:DeleteDBParameterGroup", "rds:DescribeDBParameterGroups", "rds:DescribeDBParameters", "rds:ModifyDBParameterGroup"], Resource = ["arn:aws:rds:${local.regional}:db:p14-*", "arn:aws:rds:${local.regional}:subgrp:p14-*", "arn:aws:rds:${local.regional}:pg:p14-*"] },
    { Effect = "Allow", Action = ["rds:DescribeDBInstances"], Resource = "arn:aws:rds:${local.regional}:db:*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    { Effect = "Allow", Action = ["kms:DescribeKey"], Resource = "arn:aws:kms:${local.regional}:key/*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    { Effect = "Allow", Action = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource", "secretsmanager:GetResourcePolicy"], Resource = ["arn:aws:secretsmanager:${local.regional}:secret:p14-*", "arn:aws:secretsmanager:${local.regional}:secret:rds!db-*"] },
    { Effect = "Allow", Action = ["sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue", "sqs:ListQueueTags"], Resource = "arn:aws:sqs:${local.regional}:p14-*" },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:PutRetentionPolicy", "logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"], Resource = "arn:aws:logs:${local.regional}:log-group:/p14/*:*" },
    { Effect = "Allow", Action = ["logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource"], Resource = "arn:aws:logs:${local.regional}:log-group:/p14/*" },
    { Effect = "Allow", Action = ["logs:DescribeLogGroups", "cloudwatch:DescribeAlarms", "servicediscovery:ListNamespaces", "servicediscovery:ListServices", "servicediscovery:GetOperation"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    { Effect = "Allow", Action = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:TagResource", "cloudwatch:UntagResource"], Resource = "arn:aws:cloudwatch:${local.regional}:alarm:p14-*" },
    { Effect = "Allow", Action = ["servicediscovery:CreatePrivateDnsNamespace", "servicediscovery:DeleteNamespace", "servicediscovery:GetNamespace", "servicediscovery:CreateService", "servicediscovery:DeleteService", "servicediscovery:GetService", "servicediscovery:ListTagsForResource", "servicediscovery:TagResource", "servicediscovery:UntagResource"], Resource = "arn:aws:servicediscovery:${local.regional}:*/*" },
    { Effect = "Allow", Action = ["route53:GetHostedZone", "route53:DeleteHostedZone", "route53:AssociateVPCWithHostedZone", "route53:ListResourceRecordSets", "route53:ChangeResourceRecordSets"], Resource = "arn:aws:route53:::hostedzone/*" },
    { Effect = "Allow", Action = ["route53:CreateHostedZone"], Resource = "*" },
    { Effect = "Allow", Action = ["route53:GetChange"], Resource = "arn:aws:route53:::change/*" },
    { Effect = "Allow", Action = ["route53:ListHostedZonesByName"], Resource = "*" },
    { Effect = "Allow", Action = ["secretsmanager:ListSecrets", "sqs:ListQueues"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    { Effect = "Allow", Action = ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:ListVersionsByFunction", "lambda:TagResource", "lambda:UntagResource", "lambda:PutFunctionEventInvokeConfig", "lambda:GetFunctionEventInvokeConfig", "lambda:DeleteFunctionEventInvokeConfig"], Resource = "arn:aws:lambda:${local.regional}:function:p14-*" },
    { Effect = "Allow", Action = ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"], Resource = "arn:aws:scheduler:${local.regional}:schedule/default/p14-*" }
  ] })
}
resource "aws_budgets_budget" "session" {
  name         = "p14-gross-monthly"
  budget_type  = "COST"
  limit_amount = "10"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_types {
    include_credit = false
    include_tax    = false
    include_refund = false
    use_blended    = false
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "ACTUAL"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.budget_email]
  }
}
