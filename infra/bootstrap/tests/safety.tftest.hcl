mock_provider "aws" {
  override_during = plan
  mock_data "aws_caller_identity" { defaults = { account_id = "111122223333" } }
}
variables {
  account_id   = "111122223333"
  repository   = "example-owner/aws-retail-integration"
  state_bucket = "p14-example-private-state"
  budget_email = "owner@example.com"
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
    condition     = strcontains(aws_iam_role.delivery.assume_role_policy, "environment:aws-demo") && !strcontains(aws_iam_role.delivery.assume_role_policy, "repo:*")
    error_message = "OIDC must bind the exact repository and protected environment."
  }
}
run "wrong_account" {
  command = plan
  variables { account_id = "999900001111" }
  expect_failures = [terraform_data.identity]
}
