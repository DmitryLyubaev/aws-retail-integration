variable "region" {
  type    = string
  default = "ap-southeast-2"
  validation {
    condition     = var.region == "ap-southeast-2"
    error_message = "Only the approved Sydney region is allowed."
  }
}
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "An owner-approved personal account ID is required."
  }
}
variable "repository" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/aws-retail-integration$", var.repository))
    error_message = "An approved exact repository is required."
  }
}
variable "github_owner_id" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_owner_id))
    error_message = "Use the verified immutable GitHub owner ID."
  }
}
variable "github_repository_id" {
  type = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_repository_id))
    error_message = "Use the verified immutable GitHub repository ID."
  }
}
variable "state_bucket" {
  type = string
  validation {
    condition     = can(regex("^p14-[a-z0-9-]{3,55}$", var.state_bucket))
    error_message = "State bucket must have a unique p14- name."
  }
}
variable "budget_email" {
  type      = string
  sensitive = true
  validation {
    condition     = can(regex("^[^ @]+@[^ @]+\\.[^ @]+$", var.budget_email))
    error_message = "The owner must choose a budget alert recipient."
  }
}
