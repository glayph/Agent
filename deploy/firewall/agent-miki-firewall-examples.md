# Agent Miki Firewall Examples

These examples are operator runbooks, not automatic firewall mutations. Replace the placeholder subnet with the smallest trusted management/LAN CIDR and review the output before applying rules. Keep the Node gateway on loopback unless a reverse proxy or deliberately scoped LAN deployment is required. The core API port must remain loopback-only in the normal topology.

## Linux with UFW

Ubuntu documents UFW as a host-firewall frontend and supports source-network-scoped rules and `--dry-run` previews.[1]

```bash
# Inspect current rules first.
sudo ufw status verbose

# Preview before applying. Replace 192.168.1.0/24 with the trusted subnet.
sudo ufw --dry-run allow proto tcp from 192.168.1.0/24 to any port 443 comment 'Agent Miki HTTPS'

# Apply only after reviewing the preview.
sudo ufw allow proto tcp from 192.168.1.0/24 to any port 443 comment 'Agent Miki HTTPS'
sudo ufw deny 8000/tcp comment 'Agent Miki core is not directly exposed'
sudo ufw deny 18800/tcp comment 'Agent Miki gateway is behind HTTPS proxy'
sudo ufw logging on
sudo ufw status numbered
```

If HTTP is needed only for ACME HTTP-01 challenge or redirect, allow port 80 temporarily from the required source, validate certificate renewal, and remove the rule if the chosen certificate workflow no longer needs it. Do not open ports `8000`, `18700`, `39200`, or the database/data services to the LAN or Internet.

## Windows Defender Firewall

Microsoft’s `New-NetFirewallRule` supports `-RemoteAddress`, `-LocalPort`, and `-Action`; use a stable rule `-Name` and inspect the rule after creation.[2]

```powershell
# Run in an elevated PowerShell window. Replace the placeholder subnet.
$TrustedSubnet = '192.168.1.0/24'
$RuleName = 'AgentMiki-HTTPS-In'

Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue
New-NetFirewallRule `
  -Name $RuleName `
  -DisplayName 'Agent Miki HTTPS inbound' `
  -Description 'Allow HTTPS only from the trusted Agent Miki subnet' `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 443 `
  -RemoteAddress $TrustedSubnet `
  -Profile Domain,Private `
  -EdgeTraversalPolicy Block

# Keep application ports private; use the reverse proxy on 443.
New-NetFirewallRule -Name 'AgentMiki-Core-Block' `
  -DisplayName 'Block Agent Miki core inbound' `
  -Direction Inbound -Action Block -Protocol TCP `
  -LocalPort 8000 -Profile Domain,Private,Public

Get-NetFirewallRule -Name $RuleName,'AgentMiki-Core-Block' |
  Format-Table Name,Enabled,Direction,Action,Profile
```

Use `-WhatIf` or query the rule set before changing an existing rule. Do not disable Windows Defender Firewall to troubleshoot Agent Miki; fix the narrowly scoped rule or application binding instead.[3]

## Verification checklist

After applying a rule, verify from an allowed host that HTTPS and WebSocket traffic work through the reverse proxy, then verify from an unlisted host that the request is rejected. Confirm `127.0.0.1:8000` is not reachable from the LAN, and inspect firewall logs for unexpected inbound traffic. A firewall rule is not a substitute for API-key authentication, explicit CORS origins, TLS certificate validation, or the application CIDR gate.

## References

[1]: https://ubuntu.com/server/docs/how-to/security/firewalls/ — Ubuntu Server documentation, Firewall/UFW.

[2]: https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025 — Microsoft Learn, New-NetFirewallRule.

[3]: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/configure-with-command-line — Microsoft Learn, Manage Windows Firewall with the command line.
