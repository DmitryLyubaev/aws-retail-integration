provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags { tags = { Project = "p14", SessionId = var.session_id, SourceCommit = var.source_commit, Owner = "personal-portfolio" } }
}
data "aws_caller_identity" "current" {}
resource "terraform_data" "identity" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Actual AWS account differs from owner approval."
    }
  }
}
resource "aws_vpc" "session" {
  cidr_block           = "10.84.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  depends_on           = [terraform_data.identity]
}
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.session.id
  cidr_block              = "10.84.${count.index}.0/24"
  availability_zone       = "${var.region}${count.index == 0 ? "a" : "b"}"
  map_public_ip_on_launch = false
}
resource "aws_subnet" "database" {
  count                   = 2
  vpc_id                  = aws_vpc.session.id
  cidr_block              = "10.84.${count.index + 10}.0/24"
  availability_zone       = "${var.region}${count.index == 0 ? "a" : "b"}"
  map_public_ip_on_launch = false
}
resource "aws_internet_gateway" "egress" { vpc_id = aws_vpc.session.id }
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.session.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.egress.id
  }
}
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_security_group" "application" {
  name        = "${var.session_id}-application"
  vpc_id      = aws_vpc.session.id
  description = "No API ingress; receiver rule is worker-only."
}
resource "aws_security_group" "worker" {
  name   = "${var.session_id}-worker"
  vpc_id = aws_vpc.session.id
}
resource "aws_security_group" "maintenance" {
  name   = "${var.session_id}-maintenance"
  vpc_id = aws_vpc.session.id
}
resource "aws_security_group" "database" {
  name   = "${var.session_id}-database"
  vpc_id = aws_vpc.session.id
}
locals {
  client_groups = { application = aws_security_group.application.id, worker = aws_security_group.worker.id, maintenance = aws_security_group.maintenance.id }
}
resource "aws_vpc_security_group_ingress_rule" "receiver" {
  security_group_id            = aws_security_group.application.id
  referenced_security_group_id = aws_security_group.worker.id
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
}
resource "aws_vpc_security_group_ingress_rule" "database" {
  for_each                     = local.client_groups
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "https" {
  for_each          = local.client_groups
  security_group_id = each.value
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_egress_rule" "database" {
  for_each                     = local.client_groups
  security_group_id            = each.value
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "receiver" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.application.id
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
}
resource "aws_service_discovery_private_dns_namespace" "session" {
  name = "${var.session_id}.internal"
  vpc  = aws_vpc.session.id
}
resource "aws_service_discovery_service" "receiver" {
  name = "receiver"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.session.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config {}
  force_destroy = false
}
