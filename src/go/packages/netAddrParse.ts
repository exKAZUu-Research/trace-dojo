import { spendFor } from './support';

export const V4_IN_V6_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255];

/** A valid address that `netip.ParseAddr` accepts, as its bytes in 16-byte form. */
export interface ParsedAddr {
  bytes: number[];
  is4: boolean;
  zone: string;
}

/** `netip.parseIPv4Fields`: the four octets, or undefined when Go reports an error. */
function parseIPv4Fields(s: string): number[] | undefined {
  const fields: number[] = [];
  for (const field of s.split('.')) {
    if (!/^\d+$/.test(field) || (field.length > 1 && field.startsWith('0'))) return undefined;
    const value = Number(field.length > 3 ? 'NaN' : field);
    if (!(value <= 255)) return undefined;
    fields.push(value);
  }
  return fields.length === 4 ? fields : undefined;
}

/** One hexadecimal group at the start of `s`: its value and length, or undefined when Go rejects it. */
function readGroup(s: string): [number, number] | undefined {
  const digits = /^[\dA-Fa-f]*/.exec(s)?.[0] ?? '';
  if (digits.length === 0 || digits.length > 4) return undefined;
  return [Number.parseInt(digits, 16), digits.length];
}

/** Moves the groups after `ellipsis` to the end, as `::` stands for the zeros between. */
function expandEllipsis(ip: number[], filled: number, ellipsis: number): number[] | undefined {
  if (filled === 16) return ellipsis >= 0 ? undefined : ip;
  if (ellipsis < 0) return undefined;
  const n = 16 - filled;
  for (let j = filled - 1; j >= ellipsis; j--) ip[j + n] = ip[j];
  ip.fill(0, ellipsis, ellipsis + n);
  return ip;
}

interface Ipv6Scan {
  s: string;
  ip: number[];
  i: number;
  ellipsis: number;
}

/** The colons after a group: false when the address ends, undefined when Go rejects them. */
function readColons(scan: Ipv6Scan): boolean | undefined {
  if (scan.s === '') return false;
  if (scan.s[0] !== ':' || scan.s.length === 1) return undefined;
  scan.s = scan.s.slice(1);
  if (scan.s[0] !== ':') return true;
  if (scan.ellipsis >= 0) return undefined;
  scan.ellipsis = scan.i;
  scan.s = scan.s.slice(1);
  return scan.s !== '';
}

/** Reads one group, or the embedded IPv4 address that ends the address; false when the address ends. */
function readField(scan: Ipv6Scan): boolean | undefined {
  const group = readGroup(scan.s);
  if (!group) return undefined;
  const [value, length] = group;
  if (scan.s[length] === '.') {
    const fits = (scan.ellipsis >= 0 || scan.i === 12) && scan.i + 4 <= 16;
    const fields = fits ? parseIPv4Fields(scan.s) : undefined;
    if (!fields) return undefined;
    scan.ip.splice(scan.i, 4, ...fields);
    scan.s = '';
    scan.i += 4;
    return false;
  }
  scan.ip[scan.i] = value >> 8;
  scan.ip[scan.i + 1] = value & 255;
  scan.i += 2;
  scan.s = scan.s.slice(length);
  return readColons(scan);
}

/** `netip.parseIPv6` without its error messages, which net does not show. */
function parseIPv6(input: string): ParsedAddr | undefined {
  const percent = input.indexOf('%');
  const zone = percent === -1 ? '' : input.slice(percent + 1);
  if (percent !== -1 && zone === '') return undefined;
  const scan: Ipv6Scan = {
    s: percent === -1 ? input : input.slice(0, percent),
    ip: Array.from({ length: 16 }, () => 0),
    i: 0,
    ellipsis: -1,
  };
  if (scan.s.startsWith('::')) {
    scan.ellipsis = 0;
    scan.s = scan.s.slice(2);
    if (scan.s === '') return { bytes: scan.ip, is4: false, zone };
  }
  while (scan.i < 16) {
    const more = readField(scan);
    if (more === undefined) return undefined;
    if (!more) break;
  }
  if (scan.s !== '') return undefined;
  const bytes = expandEllipsis(scan.ip, scan.i, scan.ellipsis);
  return bytes && { bytes, is4: false, zone };
}

/** `netip.ParseAddr`, reduced to the bytes and zone of a valid address. */
export function parseAddr(s: string): ParsedAddr | undefined {
  spendFor(s.length);
  for (const char of s) {
    if (char === '.') {
      const fields = parseIPv4Fields(s);
      return fields && { bytes: [...V4_IN_V6_PREFIX, ...fields], is4: true, zone: '' };
    }
    if (char === ':') return parseIPv6(s);
    if (char === '%') return undefined;
  }
  return undefined;
}
