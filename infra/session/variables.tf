variable "region" {
  type    = string
  default = "ap-southeast-2"
  validation {
    condition     = var.region == "ap-southeast-2"
    error_message = "Only approved Sydney is allowed."
  }
}
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "An owner-approved personal account is required."
  }
}
variable "session_id" {
  type = string
  validation {
    condition     = can(regex("^p14-[a-z0-9][a-z0-9-]{0,23}$", var.session_id))
    error_message = "Use a unique bounded p14- session name."
  }
}
variable "source_commit" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.source_commit))
    error_message = "An exact source commit is required."
  }
}
variable "image_digest" {
  type = string
  validation {
    condition     = can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Only an immutable image digest is accepted."
  }
}
variable "image_repository_url" {
  type = string
  validation {
    condition     = startswith(var.image_repository_url, "${var.account_id}.dkr.ecr.${var.region}.amazonaws.com/p14")
    error_message = "Image must come from the approved account and project ECR."
  }
}
variable "state_bucket" {
  type = string
  validation {
    condition     = can(regex("^p14-[a-z0-9-]+$", var.state_bucket))
    error_message = "Use the approved private bootstrap state bucket."
  }
}
variable "session_start" {
  type = string
  validation {
    condition     = can(timeadd(var.session_start, "0h")) && can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.session_start))
    error_message = "Session start must be an explicit RFC3339 UTC timestamp."
  }
}
variable "cleanup_at" {
  type = string
  validation {
    condition     = try(timecmp(var.cleanup_at, timeadd(var.session_start, "4h")) == 0, false) && can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.cleanup_at))
    error_message = "Cleanup must begin exactly four hours after session start."
  }
}
variable "session_end" {
  type = string
  validation {
    condition     = try(timecmp(var.session_end, timeadd(var.session_start, "6h")) == 0, false)
    error_message = "Closure deadline must be six hours after session start."
  }
}
variable "role_passwords" {
  type      = object({ migrator = string, application = string, receiver = string })
  sensitive = true
  validation {
    condition     = alltrue([for password in values(var.role_passwords) : can(regex("^[A-Za-z0-9_-]{20,128}$", password))])
    error_message = "Supply generated private role credentials."
  }
}
variable "operator_tokens" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.operator_tokens)) == toset(["retailer-a", "retailer-b"]) && alltrue([for token in values(var.operator_tokens) : length(token) >= 32 && length(token) <= 256])
    error_message = "Provide two private synthetic tenant operator credentials."
  }
}
variable "receiver_tokens" {
  type      = map(string)
  sensitive = true
  validation {
    condition     = toset(keys(var.receiver_tokens)) == toset(["retailer-a", "retailer-b"]) && alltrue([for token in values(var.receiver_tokens) : length(token) >= 32 && length(token) <= 256])
    error_message = "Provide separate receiver integration credentials for two tenants."
  }
}
