# Outbound webhook destinations

Test-webhook dispatch requires a verified JWT belonging to the stream sender or
an owning-organization member. Both test dispatch and v2 PATCH validate public
destinations. HTTPS is required in production; development may explicitly allow
HTTP. Userinfo, non-approved ports, private/link-local/loopback/shared/multicast
IPv4, non-global IPv6 and IPv4-mapped private IPv6 are rejected.

DNS lookup returns all addresses and fails closed if any address is non-public
or resolution fails. The test transport connects through a lookup pinned to the
validated address while retaining the original URL hostname for Host and TLS
certificate verification/SNI. Native HTTP requests never follow redirects.
Destination response bodies are discarded. Callers receive only success and
timeout/non_2xx/connection_failed categories, not raw connection errors.

Range references: RFC 1918, RFC 3927, RFC 4193, RFC 4291 and RFC 6598.
The synchronous form validator is only an early syntax/literal check; server
DNS validation and the pinned transport are the security boundary.
