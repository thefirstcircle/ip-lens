import * as https from 'https';
import * as http from 'http';
import * as dns from 'dns';

export interface ResolvedInfo {
  ptr?: string;           // reverse DNS hostname
  asn?: string;           // e.g. "AS15169"
  org?: string;           // e.g. "Google LLC"
  country?: string;       // e.g. "US"
  countryName?: string;   // e.g. "United States"
  region?: string;
  city?: string;
  isp?: string;
  query: string;          // the original IP/hostname queried
  cloudProvider?: string; // "AWS" | "Azure" | "GCP" | "Cloudflare" | etc.
  isPrivate?: boolean;
  privateKind?: string;   // e.g. "Loopback" | "RFC 1918 — Class A" | "Link-local"
  resolvedVia?: string;   // data source label shown in hover
  error?: string;
}

interface CacheEntry {
  info: ResolvedInfo;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

let cacheTTL = 300_000; // ms, updated from config

export function setCacheTTL(seconds: number) {
  cacheTTL = seconds * 1000;
}

// ── Local DNS resolver config ─────────────────────────────────────────────
let localDnsResolverAddress: string = '';

export function setLocalDnsResolver(address: string) {
  localDnsResolverAddress = address.trim();
}

/** PTR lookup for private IPs using the system resolver (or an optional override). */
async function fetchPrivatePTR(ip: string): Promise<string | undefined> {
  if (ip.includes(':')) { return undefined; } // IPv6 PTR skipped
  try {
    if (localDnsResolverAddress) {
      // Optional override: point at a specific server (e.g. an internal DNS)
      const resolver = new dns.promises.Resolver();
      const server = localDnsResolverAddress.includes(':')
        ? localDnsResolverAddress
        : `${localDnsResolverAddress}:53`;
      resolver.setServers([server]);
      const hostnames = await resolver.reverse(ip);
      return hostnames[0];
    }
    // Default: inherit the OS/system resolver — resolves internal names automatically
    const hostnames = await dns.promises.reverse(ip);
    return hostnames[0];
  } catch {
    return undefined;
  }
}

// ── Provider config ───────────────────────────────────────────────────────
type DohProvider = 'dns.google' | 'cloudflare' | 'quad9';
type IpInfoProvider = 'ip-api.com' | 'ipwho.is';

let activeDoh: DohProvider = 'dns.google';
let activeIpInfo: IpInfoProvider = 'ip-api.com';

const DOH_CONFIGS: Record<DohProvider, { baseUrl: string; headers?: Record<string, string> }> = {
  'dns.google':  { baseUrl: 'https://dns.google/resolve' },
  'cloudflare':  { baseUrl: 'https://cloudflare-dns.com/dns-query', headers: { 'Accept': 'application/dns-json' } },
  'quad9':       { baseUrl: 'https://dns.quad9.net/dns-query',       headers: { 'Accept': 'application/dns-json' } },
};

export function setDohProvider(provider: string) {
  if (provider in DOH_CONFIGS) { activeDoh = provider as DohProvider; }
}

export function setIpInfoProvider(provider: string) {
  if (provider === 'ip-api.com' || provider === 'ipwho.is') {
    activeIpInfo = provider;
  }
}

export function clearCache() {
  cache.clear();
}

function getCached(key: string): ResolvedInfo | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.info;
  }
  cache.delete(key);
  return undefined;
}

function setCached(key: string, info: ResolvedInfo) {
  cache.set(key, { info, expiresAt: Date.now() + cacheTTL });
}

function fetchJson(url: string, extraHeaders?: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'vscode-ip-lens/0.1', ...extraHeaders };
    const req = mod.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('JSON parse error'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function classifyPrivateIP(ip: string): string | undefined {
  if (/^127\./.test(ip) || ip === '::1') { return 'Loopback'; }
  if (/^169\.254\./.test(ip) || /^fe80:/i.test(ip)) { return 'Link-local'; }
  if (/^10\./.test(ip)) { return 'RFC 1918 \u2014 Class A'; }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) { return 'RFC 1918 \u2014 Class B'; }
  if (/^192\.168\./.test(ip)) { return 'RFC 1918 \u2014 Class C'; }
  if (/^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) { return 'IPv6 ULA (fc00::/7)'; }
  return undefined;
}

// Detect well-known cloud provider ASNs / org strings
const CLOUD_PROVIDERS: Array<[RegExp, string]> = [
  [/amazon|aws|EC2/i, 'AWS'],
  [/microsoft|azure/i, 'Azure'],
  [/google|GCP|google cloud/i, 'GCP'],
  [/cloudflare/i, 'Cloudflare'],
  [/fastly/i, 'Fastly'],
  [/akamai/i, 'Akamai'],
  [/digitalocean/i, 'DigitalOcean'],
  [/linode/i, 'Linode'],
  [/hetzner/i, 'Hetzner'],
  [/vultr/i, 'Vultr'],
  [/ovh/i, 'OVH'],
];

function detectCloudProvider(org?: string, isp?: string): string | undefined {
  const haystack = `${org ?? ''} ${isp ?? ''}`;
  for (const [pattern, name] of CLOUD_PROVIDERS) {
    if (pattern.test(haystack)) return name;
  }
  return undefined;
}

// ── IP info providers ─────────────────────────────────────────────────────

async function fetchIPInfoIpApi(ip: string): Promise<Partial<ResolvedInfo>> {
  const data = await fetchJson(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,isp,org,as,query,reverse`
  ) as Record<string, string>;
  if (data.status !== 'success') {
    return { error: data.message ?? 'lookup failed' };
  }
  return {
    ptr: data.reverse || undefined,
    asn: data.as ? data.as.split(' ')[0] : undefined,
    org: data.org || data.isp || undefined,
    isp: data.isp || undefined,
    country: data.countryCode || undefined,
    countryName: data.country || undefined,
    region: data.regionName || undefined,
    city: data.city || undefined,
  };
}

async function fetchIPInfoIpwho(ip: string): Promise<Partial<ResolvedInfo>> {
  const data = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`) as {
    success?: boolean;
    message?: string;
    country?: string;
    country_code?: string;
    region?: string;
    city?: string;
    connection?: { asn?: number; org?: string; isp?: string };
  };
  if (!data.success) {
    return { error: data.message ?? 'lookup failed' };
  }
  const conn = data.connection ?? {};
  return {
    asn: conn.asn != null ? `AS${conn.asn}` : undefined,
    org: conn.org || conn.isp || undefined,
    isp: conn.isp || undefined,
    country: data.country_code || undefined,
    countryName: data.country || undefined,
    region: data.region || undefined,
    city: data.city || undefined,
  };
}

async function fetchIPInfo(ip: string): Promise<Partial<ResolvedInfo>> {
  try {
    return activeIpInfo === 'ipwho.is'
      ? await fetchIPInfoIpwho(ip)
      : await fetchIPInfoIpApi(ip);
  } catch (e) {
    return { error: String(e) };
  }
}

// ── DoH helpers ───────────────────────────────────────────────────────────

function dohFetch(name: string, type: string): Promise<{ Answer?: Array<{ data: string }> }> {
  const { baseUrl, headers } = DOH_CONFIGS[activeDoh];
  return fetchJson(
    `${baseUrl}?name=${encodeURIComponent(name)}&type=${type}`,
    headers
  ) as Promise<{ Answer?: Array<{ data: string }> }>;
}

async function fetchPTR(ip: string): Promise<string | undefined> {
  try {
    if (ip.includes(':')) { return undefined; } // IPv6 PTR reversal skipped
    const ptr = ip.split('.').reverse().join('.') + '.in-addr.arpa';
    const data = await dohFetch(ptr, 'PTR');
    return data.Answer?.[0]?.data?.replace(/\.$/, '');
  } catch {
    return undefined;
  }
}

async function fetchForwardDNS(hostname: string): Promise<string | undefined> {
  try {
    const data = await dohFetch(hostname, 'A');
    return data.Answer?.[0]?.data;
  } catch {
    return undefined;
  }
}

export async function resolve(address: string, kind: 'ipv4' | 'ipv6' | 'hostname'): Promise<ResolvedInfo> {
  // Strip CIDR suffix for lookup
  const target = address.includes('/') ? address.split('/')[0] : address;
  const cacheKey = target;

  const cached = getCached(cacheKey);
  if (cached) return cached;

  let info: ResolvedInfo = { query: target };

  if (kind === 'ipv4' || kind === 'ipv6') {
    const privateKind = classifyPrivateIP(target);
    if (privateKind) {
      info.isPrivate = true;
      info.privateKind = privateKind;
      const ptr = await fetchPrivatePTR(target);
      if (ptr) {
        info.ptr = ptr;
        info.resolvedVia = localDnsResolverAddress
          ? `local resolver (${localDnsResolverAddress})`
          : 'system resolver';
      }
    } else {
      const ipInfo = await fetchIPInfo(target);
      Object.assign(info, ipInfo);
      if (!info.ptr) {
        info.ptr = await fetchPTR(target);
      }
      info.cloudProvider = detectCloudProvider(info.org, info.isp);
      info.resolvedVia = `${activeIpInfo} · ${activeDoh}`;
    }
  } else {
    // hostname — check first for a trailing embedded IPv4 (e.g. "host-172.24.1.5")
    const EMBEDDED_IPV4 = /(?:^|[^.\d])((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3})(?:[-\/]\d+)?$/;
    const embedded = EMBEDDED_IPV4.exec(target);
    if (embedded) {
      const resolved = await resolve(embedded[1], 'ipv4');
      info = { ...resolved, query: target };
    } else {
      const ip = await fetchForwardDNS(target);
      if (ip) {
        const ipInfo = await fetchIPInfo(ip);
        Object.assign(info, ipInfo);
        if (!info.ptr) info.ptr = ip;
        info.cloudProvider = detectCloudProvider(info.org, info.isp);
        info.resolvedVia = `${activeDoh} · ${activeIpInfo}`;
      } else {
        info.error = 'DNS lookup returned no A record';
        info.resolvedVia = activeDoh;
      }
    }
  }

  setCached(cacheKey, info);
  return info;
}
