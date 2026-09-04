# Agent Miki Network Security Runbook

Agent Miki’s safe default is a loopback-only Node topology: the gateway listens on `127.0.0.1:18800`, the core API listens on `127.0.0.1:8000`, and a reverse proxy terminates TLS when remote browser access is required. The core API should not be exposed directly. The gateway already rejects a non-loopback bind unless public-bind opt-in, a restricted CIDR allowlist, and explicit CORS origins are present. The core has a separate `MIKI_ALLOW_PUBLIC_CORE=true` opt-in and the same restricted CIDR/CORS requirements; this should normally remain disabled.

## TLS and reverse proxy

Use a certificate-managed reverse proxy such as NGINX or an equivalent platform proxy. NGINX’s documented model is to receive the client request, pass it to an upstream application with `proxy_pass`, and explicitly set forwarded headers when the upstream needs the original host, client address, or scheme.[1] The repository includes [`deploy/reverse-proxy/nginx-agent-miki.conf.example`](../deploy/reverse-proxy/nginx-agent-miki.conf.example) with HTTPS redirect, TLS 1.2/1.3, WebSocket upgrade headers, long-lived WebSocket timeouts, and loopback upstream routing.

Before enabling the proxy, replace the example hostname and certificate paths, validate the certificate chain, and run `nginx -t`. Start with HSTS only after HTTPS is confirmed for every intended client; a mistaken HSTS policy can make recovery harder. Do not forward or log API keys in proxy access logs. The proxy should preserve `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`; the application trusts forwarded client information only from its loopback gateway hop.

## LAN exposure and CIDR policy

Expose only the reverse proxy’s HTTPS port to the trusted LAN or management subnet. Set the smallest possible `MIKI_ALLOWED_CIDRS` value, for example `192.168.1.0/24`, and set `MIKI_ALLOWED_ORIGINS` to the exact HTTPS dashboard origin. Do not use `*` for a public deployment, and do not use `0.0.0.0/0` or `::/0` as a remote allowlist. The application checks the CIDR as well as the host firewall; both layers are required.

A normal remote configuration is:

```dotenv
GATEWAY_HOST=0.0.0.0
MIKI_ALLOW_PUBLIC_BIND=true
MIKI_ALLOWED_CIDRS=192.168.1.0/24
MIKI_ALLOWED_ORIGINS=https://miki.example.com
CORE_HOST=127.0.0.1
MIKI_ALLOW_PUBLIC_CORE=false
ENABLE_API_KEY_AUTH=true
```

Do not copy this block without replacing the example subnet and origin. On a public Internet deployment, prefer a private network, VPN, identity-aware proxy, or an upstream access-control layer rather than exposing the dashboard directly.

## Host firewall

Apply host-firewall rules separately from application configuration. The repository provides preview-first Linux UFW and Windows Defender Firewall examples in [`deploy/firewall/agent-miki-firewall-examples.md`](../deploy/firewall/agent-miki-firewall-examples.md). Ubuntu documents source-network-scoped UFW rules and `--dry-run` previews.[2] Microsoft’s firewall cmdlets support local-port and remote-address scoping, and firewall rules should be inspected after creation.[3]

The intended rule shape is **allow TCP 443 only from the trusted subnet**, optionally allow TCP 80 only for an explicitly planned certificate challenge/redirect, and block direct inbound access to ports `8000` and `18800`. Never expose the local llama runtime, memory service, database, or internal control ports. Verify both an allowed-host success and an unlisted-host rejection after applying rules. Do not disable the host firewall as a troubleshooting shortcut.[4]

## API-key rotation

API-key authentication is disabled by default for local development but should be enabled before remote exposure. `API_KEY_SECRET` must be a unique secret of at least 16 characters and must not use the known development placeholders. The application compares keys in constant time.

Rotation uses a bounded overlap window:

| Stage | Action | Expected result |
|---|---|---|
| 1. Prepare | Generate a new random key outside the repository. | The new value is never placed in Git, screenshots, URLs, or logs. |
| 2. Overlap | Set `API_KEY_SECRET` to the new key and `API_KEY_SECRET_PREVIOUS` to the old key in the protected service environment. | Both keys are accepted after the controlled service restart. |
| 3. Migrate | Update dashboard clients, scripts, reverse-proxy health checks, and operators to the new key. | New-key requests succeed; old-key requests are used only to detect incomplete migration. |
| 4. Retire | Remove `API_KEY_SECRET_PREVIOUS`, restart the service, and verify old-key requests return `401`. | Only the new key remains valid. |
| 5. Recover | If a client migration fails, restore the previous protected environment snapshot and restart; do not paste secrets into logs or chat. | The previous key can be reintroduced only during a deliberate, short recovery window. |

Because service environments are loaded at process start, a controlled restart is required after changing the protected environment file. The Linux installer protects `/etc/agent-miki/agent-miki.env`; on Windows, keep the environment file ACL restricted to the service account and administrators. Do not store API keys in the repository, browser local storage, query strings, or reverse-proxy access logs.

After rotation, verify `/health` remains available, an authenticated API request succeeds with the new key, an unauthenticated request is rejected, and the old key is rejected after the overlap window is closed. Revoke the old key at the upstream identity provider if one exists. This repository cannot revoke a provider-issued key or prove that every external client has migrated.

## Target-host limitations

The sandbox cannot prove a clean target host’s public DNS, certificate issuance, router/NAT behavior, Windows Defender Firewall enforcement, or remote-LAN packet path. It also must not mutate the user’s real firewall or production proxy without a separately authorized target-host operation. The repository-level safeguards, templates, and deterministic tests are complete; target-host deployment evidence remains an operator responsibility.

## References

[1]: https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/ — NGINX Documentation, NGINX Reverse Proxy.

[2]: https://ubuntu.com/server/docs/how-to/security/firewalls/ — Ubuntu Server documentation, Firewall/UFW.

[3]: https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025 — Microsoft Learn, New-NetFirewallRule.

[4]: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/configure-with-command-line — Microsoft Learn, Manage Windows Firewall with the command line.
