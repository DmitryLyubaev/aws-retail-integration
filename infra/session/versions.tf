terraform {
  required_version = ">= 1.15.8, < 1.16.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "6.70.0" }
    archive = { source = "hashicorp/archive", version = "2.8.1" }
  }
  backend "s3" {
    region       = "ap-southeast-2"
    encrypt      = true
    use_lockfile = true
  }
}
