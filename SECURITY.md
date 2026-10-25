# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in StreamPay,
please **do not** open a public GitHub issue. Instead, contact the
maintainers privately so we can investigate and ship a fix before
disclosure.

When reporting, include as much of the following as you can:

- A clear description of the issue and its impact.
- Reproduction steps or proof-of-concept code.
- Affected versions / commit SHA.
- Any suggested mitigation.

We aim to acknowledge reports within two business days and to issue a
fix or mitigation plan within ten business days for high-severity
issues.

## Scope

In-scope:

- Source under this repository (frontend, API routes, contract).
- Build/release tooling under `scripts/` and `.github/workflows/`.

Out of scope:

- Issues only reachable with attacker-controlled developer machines.
- Denial-of-service against public testnet infrastructure.
- Vulnerabilities in third-party services we link to but do not operate.

## Disclosure

Once a fix has been merged and a release published, we will credit the
reporter in the release notes unless they prefer to remain anonymous.

See also `docs/SECURITY-SCANNING-GUIDE.md` for the internal security
scanning workflow.

## Outbound Webhook URLs and SSRF Protections

All outbound webhook endpoints and stream webhook destination URLs are validated using a centralized outbound URL guard (`assertSafeOutboundUrl`) prior to dispatch or persistence.

Key security controls:
- **HTTPS Enforcement**: In production environments, only `https:` endpoints are allowed. `http:` is permitted only in local/development environments.
- **Port Allowlist**: Allowed ports are restricted to `443` and `8443` (plus `80` in non-production when HTTP is allowed).
- **Userinfo Rejection**: URLs carrying embedded credentials (`user:pass@host`) are strictly rejected.
- **Private, Loopback, Link-Local & Metadata IP Filtering**:
  - `0.0.0.0/8` (RFC 1122 Current network)
  - `10.0.0.0/8` (RFC 1918 Private)
  - `100.64.0.0/10` (RFC 6598 Shared Address Space / CGNAT)
  - `127.0.0.0/8` (RFC 1122 Loopback)
  - `169.254.0.0/16` (RFC 3927 Link-Local / Cloud Metadata)
  - `172.16.0.0/12` (RFC 1918 Private)
  - `192.0.0.0/24` (RFC 6890 IETF Protocol Assignments)
  - `192.0.2.0/24` (RFC 5737 TEST-NET-1)
  - `192.88.99.0/24` (RFC 7526 6to4 Relay Anycast)
  - `192.168.0.0/16` (RFC 1918 Private)
  - `198.18.0.0/15` (RFC 2544 Benchmarking)
  - `198.51.100.0/24` (RFC 5737 TEST-NET-2)
  - `203.0.113.0/24` (RFC 5737 TEST-NET-3)
  - `224.0.0.0/4` (RFC 5771 Multicast)
  - `240.0.0.0/4` (RFC 1112 Reserved)
  - IPv6: `::/128`, `::1/128` (RFC 4291 Loopback), `fe80::/10` (RFC 4291 Link-Local), `fc00::/7` (RFC 4193 ULA), `ff00::/8` (RFC 4291 Multicast), `::ffff:0:0/96` (IPv4-mapped IPv6), and `64:ff9b::/96`.
- **DNS Resolution & Rebinding Defence**: Hostnames are resolved to all corresponding IP addresses (`dns.promises.lookup` with `all: true`). If any resolved address falls within a restricted range, the request is rejected immediately. Webhook test deliveries connect directly to the pinned IP address to prevent DNS rebinding attacks.
- **Redirects**: Automated redirect following is disabled (`redirect: "manual"`). Any HTTP redirect is classified as `non_2xx` without following hops to prevent redirect-based SSRF.
- **Error Minimization**: Detailed error strings and internal port responses are sanitized. The caller only receives a coarse status (`success`, `timeout`, `non_2xx`, `connection_failed`) to prevent port scanning.

