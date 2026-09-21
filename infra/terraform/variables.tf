variable "aws_region" {
  description = "AWS region for provisioning resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name"
  type        = string
  default     = "production"
}

variable "instance_type" {
  description = "EC2 instance type for taskflow-api host"
  type        = string
  default     = "t3.micro"
}

variable "ami_id" {
  description = "AMI ID for the compute instance"
  type        = string
  default     = "ami-0c55b159cbfafe1f0"
}
