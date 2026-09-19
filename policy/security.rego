package security

default allow = true

# Clause 1: Deny if critical vulnerability count > 0
deny contains msg if {
    input.metadata.vulnerabilities.critical > 0
    msg := sprintf("Build denied by OPA policy: %v critical vulnerabilities detected in dependencies", [input.metadata.vulnerabilities.critical])
}

# Clause 2: Deny if high vulnerability count > 5
deny contains msg if {
    input.metadata.vulnerabilities.high > 5
    msg := sprintf("Build denied by OPA policy: %v high vulnerabilities detected (threshold is 5)", [input.metadata.vulnerabilities.high])
}

# Clause 3: Set allow to false if any deny rule matches
allow = false if {
    count(deny) > 0
}
