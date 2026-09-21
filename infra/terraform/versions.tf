terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote State Backend (S3-compatible / LocalStack)
  backend "s3" {
    bucket                      = "taskflow-terraform-state"
    key                         = "taskflow/terraform.tfstate"
    region                      = "us-east-1"
    endpoint                    = "http://localstack:4566"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    use_path_style              = true
    encrypt                     = true
  }
}

provider "aws" {
  region                      = var.aws_region
  access_key                  = "mock_access_key"
  secret_key                  = "mock_secret_key"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    ec2 = "http://localstack:4566"
    s3  = "http://localstack:4566"
    iam = "http://localstack:4566"
  }

  default_tags {
    tags = {
      Environment = var.environment
      Project     = "taskflow-api"
      ManagedBy   = "Terraform"
    }
  }
}

