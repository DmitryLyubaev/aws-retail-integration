output "state_bucket" { value = aws_s3_bucket.state.id }
output "image_repository_url" { value = aws_ecr_repository.image.repository_url }
output "delivery_role_arn" { value = aws_iam_role.delivery.arn }
output "oidc_provider_arn" { value = aws_iam_openid_connect_provider.github.arn }
