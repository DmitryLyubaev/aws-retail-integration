mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" { defaults = { account_id = "111122223333" } }
  mock_resource "aws_s3_bucket" { defaults = { arn = "arn:aws:s3:::p14-example-private-state" } }
  mock_resource "aws_ecr_repository" { defaults = { arn = "arn:aws:ecr:ap-southeast-2:111122223333:repository/p14-retail-integration" } }
}
variables {
  account_id           = "111122223333"
  repository           = "example-owner/aws-retail-integration"
  github_owner_id      = "123456"
  github_repository_id = "456789"
  state_bucket         = "p14-example-private-state"
  budget_email         = "owner@example.com"
}
run "private_bootstrap" {
  command = plan
  assert {
    condition     = aws_s3_bucket_public_access_block.state.block_public_acls && aws_s3_bucket_public_access_block.state.block_public_policy && aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "State must be private and versioned."
  }
  assert {
    condition     = aws_ecr_repository.image.image_tag_mutability == "IMMUTABLE" && aws_budgets_budget.session.limit_amount == "10"
    error_message = "Immutable images and gross budget guard required."
  }
  assert {
    condition     = length(aws_budgets_budget.session.cost_filter) == 0 && aws_budgets_budget.session.cost_types[0].include_credit == false
    error_message = "The gross account guard cannot depend on activation of a new allocation tag."
  }
  assert {
    condition = length(jsondecode(aws_iam_role.delivery.assume_role_policy).Statement) == 1 && jsondecode(aws_iam_role.delivery.assume_role_policy).Statement[0].Condition.StringEquals == {
      "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
      "token.actions.githubusercontent.com:sub" = "repo:example-owner@123456/aws-retail-integration@456789:environment:aws-demo"
    }
    error_message = "OIDC must bind immutable owner/repository IDs and the exact protected environment."
  }
}
run "wrong_account" {
  command = plan
  variables { account_id = "999900001111" }
  expect_failures = [terraform_data.identity]
}
run "invalid_owner_id" {
  command = plan
  variables { github_owner_id = "0" }
  expect_failures = [var.github_owner_id]
}
run "invalid_repository_id" {
  command = plan
  variables { github_repository_id = "not-an-id" }
  expect_failures = [var.github_repository_id]
}
run "delivery_resource_dependencies" {
  command = plan
  assert {
    condition = alltrue([for action in ["ec2:CreateSubnet", "ec2:CreateRouteTable", "ec2:CreateSecurityGroup"] : anytrue([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement :
      try(contains(statement.Action, action), false) &&
      try(statement.Resource == "arn:aws:ec2:ap-southeast-2:111122223333:vpc/*", false) &&
      try(statement.Condition.StringEquals["aws:ResourceTag/Project"] == "p14", false) &&
      try(statement.Condition.StringEquals["aws:RequestedRegion"] == "ap-southeast-2", false) &&
      !can(statement.Condition.StringLike["aws:RequestTag/Project"])
    ])])
    error_message = "Dependent VPC authorization must use its existing project tag, not a new resource's request tag."
  }
  assert {
    condition = alltrue([for action in ["s3:TagResource", "s3:UntagResource", "s3:ListTagsForResource", "s3:GetAccelerateConfiguration"] : anytrue([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement :
      contains(statement.Action, action) && try(contains(statement.Resource, "arn:aws:s3:::p14-*"), false)
    ])])
    error_message = "The locked provider's bucket tagging and acceleration reads must be authorized only for project buckets."
  }
  assert {
    condition = alltrue([for action in ["logs:TagResource", "logs:UntagResource", "logs:ListTagsForResource"] : anytrue([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement :
      contains(statement.Action, action) && statement.Resource == "arn:aws:logs:ap-southeast-2:111122223333:log-group:/p14/*"
    ])])
    error_message = "Log tag operations require the bare project log-group ARN, without the stream suffix."
  }
}
run "managed_password_key_metadata" {
  command = plan
  assert {
    condition = length([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement : statement
      if anytrue([for action in statement.Action : startswith(lower(action), "kms:")])
      ]) == 1 && anytrue([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement :
      length(statement.Action) == 1 && contains(statement.Action, "kms:DescribeKey") &&
      statement.Resource == "arn:aws:kms:ap-southeast-2:111122223333:key/*" &&
      try(statement.Condition.StringEquals["aws:RequestedRegion"] == "ap-southeast-2", false)
    ])
    error_message = "RDS-managed passwords need only DescribeKey metadata access on keys in the approved account and region."
  }
  assert {
    condition     = length(aws_iam_role_policy.delivery.policy) < 10240
    error_message = "The rendered delivery policy must remain within the IAM inline role policy size limit."
  }
}

run "provider_metadata_reads" {
  command = plan
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement :
      contains(statement.Action, "ecs:DescribeTaskDefinition") &&
      statement.Resource == "*" &&
      try(statement.Condition.StringEquals["aws:RequestedRegion"] == "ap-southeast-2", false)
    ])
    error_message = "ECS task-definition reads have no resource-level authorization and must be limited to Sydney."
  }
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement :
      contains(statement.Action, "rds:DescribeDBInstances") &&
      statement.Resource == "arn:aws:rds:ap-southeast-2:111122223333:db:*" &&
      try(statement.Condition.StringEquals["aws:RequestedRegion"] == "ap-southeast-2", false)
    ])
    error_message = "The provider's unfiltered RDS read needs db:* within only the approved account and region."
  }
  assert {
    condition = anytrue([
      for statement in jsondecode(aws_iam_role_policy.delivery.policy).Statement :
      contains(statement.Action, "s3:GetLifecycleConfiguration") &&
      try(contains(statement.Resource, "arn:aws:s3:::p14-*"), false)
    ])
    error_message = "The provider reads bucket lifecycle metadata even when this demonstration defines no lifecycle rule."
  }
}
