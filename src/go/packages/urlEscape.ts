// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { addMethod, fn, namedType } from '../native';
import { quote } from '../quote';
import { BASIC } from '../types';
import { GoStruct, Iface, type Value } from '../values';
import { spendFor } from './support';

/** The parts of a URL, each with its own rules of what to escape, as net/url's `encoding` modes. */
export type Encoding = 'path' | 'pathSegment' | 'host' | 'zone' | 'userPassword' | 'queryComponent' | 'fragment';

/** A Go error that net/url's helpers return, which the package functions catch and wrap or return. */
export class UrlFailure extends Error {
  constructor(readonly error: Value) {
    super('url failure');
  }
}

export const ESCAPE_ERROR = namedType('url', 'EscapeError', BASIC.string);
addMethod(
  ESCAPE_ERROR,
  'Error',
  fn([], [BASIC.string]),
  (receiver) => `invalid URL escape ${quote(receiver as string)}`
);

export const INVALID_HOST_ERROR = namedType('url', 'InvalidHostError', BASIC.string);
addMethod(
  INVALID_HOST_ERROR,
  'Error',
  fn([], [BASIC.string]),
  (receiver) => `invalid character ${quote(receiver as string)} in host name`
);

const UPPER_HEX = '0123456789ABCDEF';

export function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function unhex(c: number): number {
  return 9 * (c >> 6) + (c & 15);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes net/url's shouldEscape.
/** `shouldEscape` of net/url's gen_encoding_table.go, from which Go generates its lookup table. */
export function shouldEscape(c: number, mode: Encoding): boolean {
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)) return false;
  const char = String.fromCharCode(c);
  if ((mode === 'host' || mode === 'zone') && `!$&'()*+,;=:[]<>"`.includes(char)) return false;
  if ('-_.~'.includes(char)) return false;
  if ('$&+,/:;=?@'.includes(char)) {
    switch (mode) {
      case 'path': {
        return char === '?';
      }
      case 'pathSegment': {
        return char === '/' || char === ';' || char === ',' || char === '?';
      }
      case 'userPassword': {
        return char === '@' || char === '/' || char === '?' || char === ':';
      }
      case 'queryComponent': {
        return true;
      }
      case 'fragment': {
        return false;
      }
    }
  }
  if (mode === 'fragment' && '!()*'.includes(char)) return false;
  return true;
}

// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes net/url's unescape.
// code-gauge-allow functionNcss 40 -- Transcribes net/url's unescape.
/** `unescape`: decodes %XX (and + in a query component), throwing Go's EscapeError or InvalidHostError. */
export function unescape(s: string, mode: Encoding): string {
  spendFor(s.length);
  let n = 0;
  let hasPlus = false;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      n++;
      if (i + 2 >= s.length || !isHex(s.charCodeAt(i + 1)) || !isHex(s.charCodeAt(i + 2))) {
        throw new UrlFailure(new Iface(ESCAPE_ERROR, s.slice(i, i + 3)));
      }
      checkEscapedHostByte(s, i, mode);
      i += 3;
    } else if (c === 0x2b) {
      hasPlus = mode === 'queryComponent';
      i++;
    } else {
      if ((mode === 'host' || mode === 'zone') && c < 0x80 && shouldEscape(c, mode)) {
        throw new UrlFailure(new Iface(INVALID_HOST_ERROR, s.slice(i, i + 1)));
      }
      i++;
    }
  }
  if (n === 0 && !hasPlus) return s;
  const plus = mode === 'queryComponent' ? ' ' : '+';
  let t = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      t += String.fromCharCode((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
      i += 2;
    } else if (c === 0x2b) t += plus;
    else t += s[i];
  }
  return t;
}

/** The host may %-encode only non-ASCII bytes (and %25), and a zone only bytes it could hold unescaped. */
function checkEscapedHostByte(s: string, i: number, mode: Encoding): void {
  const escaped = s.slice(i, i + 3);
  if (mode === 'host' && unhex(s.charCodeAt(i + 1)) < 8 && escaped !== '%25') {
    throw new UrlFailure(new Iface(ESCAPE_ERROR, escaped));
  }
  if (mode === 'zone') {
    const v = (unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2));
    if (escaped !== '%25' && v !== 0x20 && shouldEscape(v, 'host')) {
      throw new UrlFailure(new Iface(ESCAPE_ERROR, escaped));
    }
  }
}

export function escape(s: string, mode: Encoding): string {
  spendFor(s.length);
  let t = '';
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x20 && mode === 'queryComponent') {
      t += '+';
      changed = true;
    } else if (shouldEscape(c, mode)) {
      t += `%${UPPER_HEX[c >> 4]}${UPPER_HEX[c & 15]}`;
      changed = true;
    } else t += s[i];
  }
  return changed ? t : s;
}

// net/netip's ParseAddr, which checks the IP literal of a host in brackets -----------------------------------------

const PARSE_ADDR_ERROR = namedType('netip', 'parseAddrError', {
  kind: 'struct',
  fields: [
    { name: 'in', type: BASIC.string, embedded: false },
    { name: 'msg', type: BASIC.string, embedded: false },
    { name: 'at', type: BASIC.string, embedded: false },
  ],
});
addMethod(PARSE_ADDR_ERROR, 'Error', fn([], [BASIC.string]), (receiver) => {
  const [input, message, at] = (receiver as { fields: string[] }).fields;
  const head = `ParseAddr(${quote(input)}): ${message}`;
  return at === '' ? head : `${head} (at ${quote(at)})`;
});

class AddrFailure extends Error {
  constructor(
    readonly input: string,
    readonly msg: string,
    readonly at = ''
  ) {
    super(msg);
  }
}

/** `netip.ParseAddr`, reporting whether the address is IPv4, or returning its error. */
export function parseAddr(s: string): { is4: boolean } | { error: Value } {
  try {
    for (const char of s) {
      if (char === '.') {
        parseIPv4Fields(s, 0, s.length);
        return { is4: true };
      }
      if (char === ':') {
        parseIPv6(s);
        return { is4: false };
      }
      if (char === '%') throw new AddrFailure(s, 'missing IPv6 address');
    }
    throw new AddrFailure(s, 'unable to parse IP');
  } catch (error) {
    if (!(error instanceof AddrFailure)) throw error;
    return { error: addrError(error) };
  }
}

function addrError(failure: AddrFailure): Value {
  return new Iface(PARSE_ADDR_ERROR, new GoStruct([failure.input, failure.msg, failure.at]));
}

// code-gauge-allow functionCognitiveComplexity 25 -- Transcribes netip.parseIPv4Fields.
function parseIPv4Fields(input: string, off: number, end: number): void {
  let val = 0;
  let pos = 0;
  let digLen = 0;
  const s = input.slice(off, end);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) {
      if (digLen === 1 && val === 0) throw new AddrFailure(input, 'IPv4 field has octet with leading zero');
      val = val * 10 + c - 0x30;
      digLen++;
      if (val > 255) throw new AddrFailure(input, 'IPv4 field has value >255');
    } else if (c === 0x2e) {
      if (i === 0 || i === s.length - 1 || s[i - 1] === '.') {
        throw new AddrFailure(input, 'IPv4 field must have at least one digit', s.slice(i));
      }
      if (pos === 3) throw new AddrFailure(input, 'IPv4 address too long');
      pos++;
      val = 0;
      digLen = 0;
    } else {
      throw new AddrFailure(input, 'unexpected character', s.slice(i));
    }
  }
  if (pos < 3) throw new AddrFailure(input, 'IPv4 address too short');
}

// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes netip.parseIPv6 step by step.
// code-gauge-allow functionNcss 45 -- Transcribes netip.parseIPv6 step by step.
/** `netip.parseIPv6`, which only validates here since net/url needs no more than its error. */
function parseIPv6(input: string): void {
  const zoneAt = input.indexOf('%');
  const zone = zoneAt === -1 ? '' : input.slice(zoneAt + 1);
  if (zoneAt !== -1 && zone === '') throw new AddrFailure(input, 'zone must be a non-empty string');
  let s = zoneAt === -1 ? input : input.slice(0, zoneAt);
  let ellipsis = -1;
  if (s.startsWith('::')) {
    ellipsis = 0;
    s = s.slice(2);
    if (s.length === 0) return;
  }
  let i = 0;
  while (i < 16) {
    const off = hexGroupLength(input, s);
    if (off < s.length && s[off] === '.') {
      parseEmbeddedIPv4(input, s, zone, i, ellipsis);
      s = '';
      i += 4;
      break;
    }
    i += 2;
    s = s.slice(off);
    if (s.length === 0) break;
    if (s[0] !== ':') throw new AddrFailure(input, 'unexpected character, want colon', s);
    if (s.length === 1) throw new AddrFailure(input, 'colon must be followed by more characters', s);
    s = s.slice(1);
    if (s[0] === ':') {
      if (ellipsis >= 0) throw new AddrFailure(input, 'multiple :: in address', s);
      ellipsis = i;
      s = s.slice(1);
      if (s.length === 0) break;
    }
  }
  if (s.length > 0) throw new AddrFailure(input, 'trailing garbage after address', s);
  if (i < 16 && ellipsis < 0) throw new AddrFailure(input, 'address string too short');
  if (i >= 16 && ellipsis >= 0) throw new AddrFailure(input, 'the :: must expand to at least one field of zeros');
}

/** The number of hex digits that start `s`: one to four, worth less than 2^16. */
function hexGroupLength(input: string, s: string): number {
  let off = 0;
  let acc = 0;
  for (; off < s.length; off++) {
    const digit = Number.parseInt(s[off], 16);
    if (Number.isNaN(digit)) break;
    acc = acc * 16 + digit;
    if (off > 3) throw new AddrFailure(input, 'each group must have 4 or less digits', s);
    if (acc > 0xff_ff) throw new AddrFailure(input, 'IPv6 field has value >=2^16', s);
  }
  if (off === 0) throw new AddrFailure(input, 'each colon-separated field must have at least one digit', s);
  return off;
}

function parseEmbeddedIPv4(input: string, s: string, zone: string, i: number, ellipsis: number): void {
  if (ellipsis < 0 && i !== 12) {
    throw new AddrFailure(input, 'embedded IPv4 address must replace the final 2 fields of the address', s);
  }
  if (i + 4 > 16) {
    throw new AddrFailure(input, 'too many hex fields to fit an embedded IPv4 at the end of the address', s);
  }
  const end = input.length - (zone.length > 0 ? zone.length + 1 : 0);
  parseIPv4Fields(input, end - s.length, end);
}

/** Runs a parse, turning a thrown Go error into Go's (value, err) results. */
export function attempt<T>(run: () => T): { value: T } | { error: Value } {
  try {
    return { value: run() };
  } catch (error) {
    if (error instanceof UrlFailure) return { error: error.error };
    throw error;
  }
}

/** `strings.Cut`. */
export function cut(s: string, sep: string): [string, string, boolean] {
  const at = s.indexOf(sep);
  return at === -1 ? [s, '', false] : [s.slice(0, at), s.slice(at + sep.length), true];
}
