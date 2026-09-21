output "instance_id" {
  description = "ID of the provisioned compute instance"
  value       = aws_instance.taskflow_server.id
}

output "instance_address" {
  description = "Public IP / Address of the provisioned instance (Lab 08 Task 1 Requirement)"
  value       = aws_instance.taskflow_server.public_ip
}

output "instance_private_ip" {
  description = "Private IP address of the provisioned instance"
  value       = aws_instance.taskflow_server.private_ip
}

output "security_group_id" {
  description = "ID of the attached security group"
  value       = aws_security_group.taskflow_sg.id
}
