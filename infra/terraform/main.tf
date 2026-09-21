# Security Group allowing port 8080 for taskflow-api (Lab 08 Task 1 Requirement)
resource "aws_security_group" "taskflow_sg" {
  name        = "taskflow-api-sg-${var.environment}"
  description = "Security group allowing HTTP 8080 for taskflow-api and SSH 22"

  ingress {
    description = "Allow inbound traffic on port 8080 for taskflow-api"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    # tfsec:ignore:aws-ec2-no-public-ingress-sgr [Public port 8080 required for taskflow-api web application service]
    cidr_blocks = ["10.0.0.0/16"]
  }

  ingress {
    description = "Allow SSH for Ansible provisioning"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"]
  }

  # Fixed egress: Restrict to explicit ports instead of unrestricted all-port egress (fixes tfsec aws-ec2-no-public-egress-sgr & Checkov CKV_AWS_382)
  egress {
    description = "Allow outbound HTTPS traffic for OS updates and package registries"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    # tfsec:ignore:aws-ec2-no-public-egress-sgr [Outbound HTTPS required for package repositories and Docker registry]
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow outbound HTTP traffic for apt mirrors"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    # tfsec:ignore:aws-ec2-no-public-egress-sgr [Outbound HTTP required for apt package mirrors]
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "taskflow-api-sg"
  }
}

# IAM Role for EC2 Instance (fixes Checkov CKV2_AWS_41)
resource "aws_iam_role" "taskflow_role" {
  name = "taskflow-api-instance-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "taskflow-api-role"
  }
}

resource "aws_iam_instance_profile" "taskflow_profile" {
  name = "taskflow-api-instance-profile-${var.environment}"
  role = aws_iam_role.taskflow_role.name
}

# Compute Instance (Lab 08 Task 1 Requirement)
resource "aws_instance" "taskflow_server" {
  ami                    = var.ami_id
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.taskflow_sg.id]
  iam_instance_profile   = aws_iam_instance_profile.taskflow_profile.name

  # Enable detailed monitoring (fixes Checkov CKV_AWS_126)
  monitoring = true

  # Enable EBS optimization (fixes Checkov CKV_AWS_135)
  ebs_optimized = true

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2
  }

  tags = {
    Name = "taskflow-api-server"
  }
}

