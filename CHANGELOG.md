# Changelog

## [0.2.2] - 2026-03-09

### Fixed
- Hostnames with a hyphen-separated prefix length suffix (e.g. `hostname-172.24.1.5-32`) now correctly extract and resolve the embedded IP

## [0.2.1] - 2026-03-09

### Fixed
- Hostnames that encode a trailing IP address (e.g. `hostname-172.24.1.5`) now resolve correctly — the embedded IP is extracted and resolved directly instead of attempting a forward DNS lookup on the full string

## [0.2.0] - 2026-03-09

### Added
- Private/RFC 1918 addresses now resolve hostnames via the system's DNS resolver by default — internal network names appear in the hover card without any configuration
- New `ipLens.localDnsResolver` setting to override the DNS server used for private IP PTR lookups (e.g. `192.168.1.1` or `192.168.1.1:53`)

### Fixed
- Removed dead `akamai` alternative from the Linode cloud provider pattern (it was shadowed by the earlier Akamai entry and would never match)

## [0.1.0] - Initial release

- Dotted underline decorations on IPv4, IPv6, CIDR blocks, and hostnames
- Hover card with PTR/reverse DNS, ASN, organisation, ISP, country, city, and cloud provider
- Gutter icon on lines containing addresses
- Status bar counter with click-to-open Resolve All panel
- Resolve All panel with full address table; click any row to jump to that address in the editor
- Private IP classification (RFC 1918 Class A/B/C, Loopback, Link-local, IPv6 ULA)
- Configurable DNS-over-HTTPS provider (Google, Cloudflare, Quad9)
- Configurable IP info provider (ip-api.com, ipwho.is)
- TTL-based in-memory cache with configurable expiry
