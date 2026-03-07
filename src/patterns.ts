// Regex patterns for IP addresses, CIDRs, and hostnames

// IPv4: 0-255 octets
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d|\\d)';
export const IPV4 = `${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}`;

// IPv6: all valid forms enumerated (RFC 5952)
const H16 = '[0-9a-fA-F]{1,4}';
const H16c = `${H16}:`;  // H16 followed by colon
const cH16 = `:${H16}`;  // colon followed by H16
export const IPV6 = `(?:${[
  `${H16c}${H16c}${H16c}${H16c}${H16c}${H16c}${H16c}${H16}`, // 8 full groups (no ::)
  `(?:${H16c}){1,7}:`,                                         // trailing ::  e.g. 1:: or 1:2:3:4:5:6:7::
  `(?:${H16c}){1,6}${cH16}`,                                   // ::8            e.g. 1:2:3:4:5:6::8
  `(?:${H16c}){1,5}(?:${cH16}){1,2}`,                         // ::7:8          e.g. 1:2:3:4:5::7:8
  `(?:${H16c}){1,4}(?:${cH16}){1,3}`,                         // ::6:7:8
  `(?:${H16c}){1,3}(?:${cH16}){1,4}`,                         // ::5:6:7:8
  `(?:${H16c}){1,2}(?:${cH16}){1,5}`,                         // ::4:5:6:7:8
  `${H16c}(?:${cH16}){1,6}`,                                   // ::3:4:5:6:7:8  e.g. 1::3:4:5:6:7:8
  `:(?:${cH16}){1,7}`,                                         // leading ::     e.g. ::2:3:4:5:6:7:8
  `::`,                                                         // all-zeros
].join('|')})`;

// CIDR suffixes
const CIDR4 = `${IPV4}(?:/(?:3[0-2]|[12]\\d|\\d))?`;
const CIDR6 = `(?:${IPV6})(?:/(?:12[0-8]|1[01]\\d|[1-9]\\d|\\d))?`;

// Hostname/domain (not bare single labels to avoid false positives)
// Must have at least one dot and valid TLD-ish ending
const LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9\\-]{0,61}[a-zA-Z0-9])?';
export const HOSTNAME = `${LABEL}(?:\\.${LABEL})+`;

// Combined pattern: CIDR4 first (more specific), then IPv6, then hostname
export const COMBINED_PATTERN = new RegExp(
  `(?<![\\w.])(?:(${CIDR4})|(${CIDR6})|(${HOSTNAME}))(?![\\w.])`,
  'g'
);

export type MatchKind = 'ipv4' | 'ipv6' | 'hostname';

export interface AddressMatch {
  value: string;
  kind: MatchKind;
  start: number;
  end: number;
}

export function findAddresses(text: string): AddressMatch[] {
  const results: AddressMatch[] = [];
  const re = new RegExp(COMBINED_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[0];
    const start = m.index;
    const end = start + value.length;
    let kind: MatchKind;
    if (m[1]) {
      kind = 'ipv4';
    } else if (m[2]) {
      kind = 'ipv6';
    } else {
      kind = 'hostname';
    }
    results.push({ value, kind, start, end });
  }
  return results;
}
