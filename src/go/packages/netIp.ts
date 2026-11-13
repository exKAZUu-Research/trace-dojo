import type { Entity } from '../entities';
import { addMethod, currentRuntime, fn, namedType, nativeFunction, typeEntity } from '../native';
import type { Runtime } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, ERROR_TYPE, type NamedType, pointerTo, sliceOf } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Slice, type Value } from '../values';
import { libraryVariable, makeBytes, subslice } from './io';
import { parseAddr, V4_IN_V6_PREFIX } from './netAddrParse';
import { appendBytes, BOOL, BYTES, INT, receiverStruct, STRING } from './support';

const IPV4_LEN = 4;
const IPV6_LEN = 16;
const HEX_DIGITS = '0123456789abcdef';

export const IP = namedType('net', 'IP', BYTES);
export const IP_MASK = namedType('net', 'IPMask', BYTES);
export const IP_NET = namedType('net', 'IPNet', {
  kind: 'struct',
  fields: [
    { name: 'IP', type: IP, embedded: false },
    { name: 'Mask', type: IP_MASK, embedded: false },
  ],
});
export const HARDWARE_ADDR = namedType('net', 'HardwareAddr', BYTES);

/** `*net.ParseError` and `*net.AddrError`, which the parsers here return. */
export const PARSE_ERROR = errorStruct('ParseError', ['Type', 'Text'], ([type, text]) => `invalid ${type}: ${text}`);
export const ADDR_ERROR = errorStruct('AddrError', ['Err', 'Addr'], ([err, addr]) =>
  addr === '' ? err : `address ${addr}: ${err}`
);

/** A struct of string fields with Error, and Timeout and Temporary that are false; a nil AddrError prints <nil>. */
function errorStruct(name: string, fields: string[], message: (values: string[]) => string): NamedType {
  const type = namedType('net', name, {
    kind: 'struct',
    fields: fields.map((field) => ({ name: field, type: STRING, embedded: false })),
  });
  addMethod(
    type,
    'Error',
    fn([], [STRING]),
    (receiver) => {
      if (receiver === undefined && name === 'AddrError') return '<nil>';
      return message(receiverStruct(receiver).fields as string[]);
    },
    true
  );
  for (const method of ['Timeout', 'Temporary']) addMethod(type, method, fn([], [BOOL]), () => false, true);
  return type;
}

export function errorValue(type: NamedType, fields: Value[]): Iface {
  return new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct(fields)), 'v'));
}

// Byte helpers ------------------------------------------------------------------------------------------------------

function bytesOfSlice(value: Value): number[] {
  const slice = value as Slice | undefined;
  const bytes: number[] = [];
  for (let index = 0; index < (slice?.length ?? 0); index++) bytes.push(Number((slice as Slice).get(index) as bigint));
  return bytes;
}

function newBytes(bytes: readonly number[]): Slice {
  const slice = makeBytes(bytes.length);
  for (const [index, byte] of bytes.entries()) slice.array[index] = BigInt(byte);
  return slice;
}

const sameBytes = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

function hexString(bytes: readonly number[]): string {
  return bytes.map((byte) => HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 15]).join('');
}

// IP ----------------------------------------------------------------------------------------------------------------

function to4(ip: readonly number[]): number[] | undefined {
  if (ip.length === IPV4_LEN) return [...ip];
  if (ip.length === IPV6_LEN && sameBytes(ip.slice(0, 12), V4_IN_V6_PREFIX)) return ip.slice(12);
  return undefined;
}

function equal(ip: readonly number[], x: readonly number[]): boolean {
  if (ip.length === x.length) return sameBytes(ip, x);
  if (ip.length === IPV4_LEN && x.length === IPV6_LEN)
    return sameBytes(x.slice(0, 12), V4_IN_V6_PREFIX) && sameBytes(ip, x.slice(12));
  if (ip.length === IPV6_LEN && x.length === IPV4_LEN)
    return sameBytes(ip.slice(0, 12), V4_IN_V6_PREFIX) && sameBytes(ip.slice(12), x);
  return false;
}

/** `netip.Addr.appendTo6`: hex groups with the longest run of two or more zero groups as `::`. */
function format6(ip: readonly number[]): string {
  const groups = Array.from({ length: 8 }, (_, index) => ip[index * 2] * 256 + ip[index * 2 + 1]);
  let zeroStart = 255;
  let zeroEnd = 255;
  for (let i = 0; i < 8; i++) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i >= 2 && j - i > zeroEnd - zeroStart) {
      zeroStart = i;
      zeroEnd = j;
    }
  }
  let text = '';
  for (let i = 0; i < 8; i++) {
    if (i === zeroStart) {
      text += '::';
      i = zeroEnd;
      if (i >= 8) break;
    } else if (i > 0) text += ':';
    text += groups[i].toString(16);
  }
  return text;
}

function formatIP(ip: readonly number[]): string {
  const v4 = to4(ip);
  if (v4) return v4.join('.');
  return format6(ip);
}

export function ipString(ip: readonly number[]): string {
  if (ip.length === 0) return '<nil>';
  if (ip.length !== IPV4_LEN && ip.length !== IPV6_LEN) return `?${hexString(ip)}`;
  return formatIP(ip);
}

/** The text of an IP in an address, where a nil IP is empty. */
export function ipEmptyString(value: Value): string {
  const ip = bytesOfSlice(value);
  return ip.length === 0 ? '' : ipString(ip);
}

function ipv4(a: number, b: number, c: number, d: number): number[] {
  return [...V4_IN_V6_PREFIX, a, b, c, d];
}

function isUnspecified(ip: readonly number[]): boolean {
  return (
    equal(ip, ipv4(0, 0, 0, 0)) ||
    equal(
      ip,
      Array.from({ length: 16 }, () => 0)
    )
  );
}

function isLoopback(ip: readonly number[]): boolean {
  const v4 = to4(ip);
  if (v4) return v4[0] === 127;
  return equal(ip, [...Array.from({ length: 15 }, () => 0), 1]);
}

function isMulticast(ip: readonly number[]): boolean {
  const v4 = to4(ip);
  if (v4) return (v4[0] & 0xf0) === 0xe0;
  return ip.length === IPV6_LEN && ip[0] === 255;
}

function isLinkLocalUnicast(ip: readonly number[]): boolean {
  const v4 = to4(ip);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  return ip.length === IPV6_LEN && ip[0] === 0xfe && (ip[1] & 0xc0) === 0x80;
}

const PREDICATES: Record<string, (ip: number[]) => boolean> = {
  IsUnspecified: isUnspecified,
  IsLoopback: isLoopback,
  IsMulticast: isMulticast,
  IsLinkLocalUnicast: isLinkLocalUnicast,
  IsPrivate: (ip) => {
    const v4 = to4(ip);
    if (v4) return v4[0] === 10 || (v4[0] === 172 && (v4[1] & 0xf0) === 16) || (v4[0] === 192 && v4[1] === 168);
    return ip.length === IPV6_LEN && (ip[0] & 0xfe) === 0xfc;
  },
  IsInterfaceLocalMulticast: (ip) => ip.length === IPV6_LEN && ip[0] === 255 && (ip[1] & 15) === 1,
  IsLinkLocalMulticast: (ip) => {
    const v4 = to4(ip);
    if (v4) return v4[0] === 224 && v4[1] === 0 && v4[2] === 0;
    return ip.length === IPV6_LEN && ip[0] === 255 && (ip[1] & 15) === 2;
  },
  IsGlobalUnicast: (ip) =>
    (ip.length === IPV4_LEN || ip.length === IPV6_LEN) &&
    !equal(ip, ipv4(255, 255, 255, 255)) &&
    !isUnspecified(ip) &&
    !isLoopback(ip) &&
    !isMulticast(ip) &&
    !isLinkLocalUnicast(ip),
};

for (const [name, test] of Object.entries(PREDICATES)) {
  addMethod(IP, name, fn([], [BOOL]), (receiver) => test(bytesOfSlice(receiver)));
}
addMethod(IP, 'String', fn([], [STRING]), (receiver) => ipString(bytesOfSlice(receiver)));
addMethod(IP, 'Equal', fn([IP], [BOOL]), (receiver, [x]) => equal(bytesOfSlice(receiver), bytesOfSlice(x)));
addMethod(IP, 'To4', fn([], [IP]), (receiver) => {
  const ip = bytesOfSlice(receiver);
  if (ip.length === IPV4_LEN) return receiver;
  return to4(ip) ? subslice(receiver, 12, 16) : undefined;
});
addMethod(IP, 'To16', fn([], [IP]), (receiver) => {
  const ip = bytesOfSlice(receiver);
  if (ip.length === IPV4_LEN) return newBytes(ipv4(ip[0], ip[1], ip[2], ip[3]));
  return ip.length === IPV6_LEN ? receiver : undefined;
});
addMethod(IP, 'DefaultMask', fn([], [IP_MASK]), (receiver) => {
  const v4 = to4(bytesOfSlice(receiver));
  if (!v4) return;
  const masks = packageValues();
  return v4[0] < 0x80 ? masks.classA : v4[0] < 0xc0 ? masks.classB : masks.classC;
});
addMethod(IP, 'Mask', fn([IP_MASK], [IP]), (receiver, [maskValue]) => {
  let ip = bytesOfSlice(receiver);
  let mask = bytesOfSlice(maskValue);
  if (mask.length === IPV6_LEN && ip.length === IPV4_LEN && mask.slice(0, 12).every((byte) => byte === 255))
    mask = mask.slice(12);
  if (mask.length === IPV4_LEN && ip.length === IPV6_LEN && sameBytes(ip.slice(0, 12), V4_IN_V6_PREFIX))
    ip = ip.slice(12);
  if (ip.length !== mask.length) return;
  return newBytes(ip.map((byte, index) => byte & mask[index]));
});

function appendText(receiver: Value, b: Value): Value[] {
  const ip = bytesOfSlice(receiver);
  if (ip.length === 0) return [b, undefined];
  if (ip.length !== IPV4_LEN && ip.length !== IPV6_LEN) {
    return [b, errorValue(ADDR_ERROR, ['invalid IP address', hexString(ip)])];
  }
  return [appendBytes(b, formatIP(ip)), undefined];
}

addMethod(IP, 'AppendText', fn([BYTES], [BYTES, ERROR_TYPE]), (receiver, [b]) => appendText(receiver, b));
addMethod(IP, 'MarshalText', fn([], [BYTES, ERROR_TYPE]), (receiver) => {
  const [b, error] = appendText(receiver, makeBytes(0, 24));
  return error === undefined ? [b, undefined] : [undefined, error];
});
addMethod(
  IP,
  'UnmarshalText',
  fn([BYTES], [ERROR_TYPE]),
  (receiver, [text]) => {
    if (!(receiver instanceof Pointer)) nilPointerPanic();
    const bytes = bytesOfSlice(text);
    if (bytes.length === 0) {
      receiver.store(undefined);
      return;
    }
    const s = String.fromCodePoint(...bytes);
    const ip = parseIP(s);
    if (ip === undefined) return errorValue(PARSE_ERROR, ['IP address', s]);
    receiver.store(ip);
    return;
  },
  true
);

function parseIP(s: string): Slice | undefined {
  const addr = parseAddr(s);
  return addr && addr.zone === '' ? newBytes(addr.bytes) : undefined;
}

// IPMask and IPNet --------------------------------------------------------------------------------------------------

function simpleMaskLength(mask: readonly number[]): number {
  let n = 0;
  for (let index = 0; index < mask.length; index++) {
    let value = mask[index];
    if (value === 255) {
      n += 8;
      continue;
    }
    while (value & 0x80) {
      n++;
      value = (value << 1) & 255;
    }
    if (value !== 0) return -1;
    if (mask.slice(index + 1).some((byte) => byte !== 0)) return -1;
    break;
  }
  return n;
}

const maskString = (mask: readonly number[]): string => (mask.length === 0 ? '<nil>' : hexString(mask));

addMethod(IP_MASK, 'Size', fn([], [INT, INT]), (receiver) => {
  const mask = bytesOfSlice(receiver);
  const ones = simpleMaskLength(mask);
  return ones === -1 ? [0n, 0n] : [BigInt(ones), BigInt(mask.length * 8)];
});
addMethod(IP_MASK, 'String', fn([], [STRING]), (receiver) => maskString(bytesOfSlice(receiver)));

function networkNumberAndMask(network: GoStruct): [number[], number[]] | undefined {
  const raw = bytesOfSlice(network.fields[0]);
  let ip = to4(raw);
  if (!ip) {
    ip = raw;
    if (ip.length !== IPV6_LEN) return undefined;
  }
  let mask = bytesOfSlice(network.fields[1]);
  if (mask.length === IPV4_LEN) {
    if (ip.length !== IPV4_LEN) return undefined;
  } else if (mask.length === IPV6_LEN) {
    if (ip.length === IPV4_LEN) mask = mask.slice(12);
  } else return undefined;
  return [ip, mask];
}

addMethod(
  IP_NET,
  'Contains',
  fn([IP], [BOOL]),
  (receiver, [ipValue]) => {
    const pair = networkNumberAndMask(receiverStruct(receiver));
    const raw = bytesOfSlice(ipValue);
    const ip = to4(raw) ?? raw;
    const [network, mask] = pair ?? [[], []];
    if (ip.length !== network.length) return false;
    return ip.every((byte, index) => (network[index] & mask[index]) === (byte & mask[index]));
  },
  true
);
addMethod(IP_NET, 'Network', fn([], [STRING]), () => 'ip+net', true);
addMethod(
  IP_NET,
  'String',
  fn([], [STRING]),
  (receiver) => {
    if (receiver === undefined) return '<nil>';
    const pair = networkNumberAndMask(receiverStruct(receiver));
    if (!pair) return '<nil>';
    const [ip, mask] = pair;
    const length = simpleMaskLength(mask);
    return `${ipString(ip)}/${length === -1 ? maskString(mask) : length}`;
  },
  true
);

function cidrMask(ones: number, bits: number): number[] | undefined {
  if (bits !== 32 && bits !== 128) return undefined;
  if (ones < 0 || ones > bits) return undefined;
  const mask: number[] = [];
  let n = ones;
  for (let index = 0; index < bits / 8; index++) {
    if (n >= 8) {
      mask.push(255);
      n -= 8;
    } else {
      mask.push(~(255 >> n) & 255);
      n = 0;
    }
  }
  return mask;
}

function parseCIDR(s: string): Value[] {
  const failure = (): Value[] => [undefined, undefined, errorValue(PARSE_ERROR, ['CIDR address', s])];
  const slash = s.indexOf('/');
  if (slash === -1) return failure();
  const addr = parseAddr(s.slice(0, slash));
  const maskText = s.slice(slash + 1);
  if (!addr || addr.zone !== '' || !/^\d+$/.test(maskText)) return failure();
  const bits = addr.is4 ? 32 : 128;
  const ones = maskText.length > 9 ? Infinity : Number(maskText);
  if (ones > bits) return failure();
  const mask = cidrMask(ones, bits) as number[];
  const ip = addr.bytes;
  const v4 = ip.length === IPV6_LEN && mask.length === IPV4_LEN ? ip.slice(12) : ip;
  const network = new GoStruct([newBytes(v4.map((byte, index) => byte & mask[index])), newBytes(mask)]);
  currentRuntime().allocate(1);
  return [newBytes(ip), new Pointer(new Cell(network), 'v'), undefined];
}

// HardwareAddr ------------------------------------------------------------------------------------------------------

addMethod(HARDWARE_ADDR, 'String', fn([], [STRING]), (receiver) =>
  bytesOfSlice(receiver)
    .map((byte) => HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 15])
    .join(':')
);

/** `xtoi2`: the byte of two hex digits followed by `separator` (or the end). */
function xtoi2(s: string, separator: string): number | undefined {
  if (s.length > 2 && s[2] !== separator) return undefined;
  const digits = s.slice(0, 2);
  return /^[\dA-Fa-f]{2}$/.test(digits) ? Number.parseInt(digits, 16) : undefined;
}

const validMACLength = (n: number): boolean => n === 6 || n === 8 || n === 20;

// code-gauge-allow functionCognitiveComplexity 19 -- follows Go's ParseMAC, which reads three layouts.
/** `ParseMAC`'s three layouts: `xx:xx`/`xx-xx` one byte per group, `xxxx.xxxx` two, and plain hex digits. */
function parseMACBytes(s: string): number[] | undefined {
  if (s.length < 12) return undefined;
  const [step, perGroup, separator] =
    s[2] === ':' || s[2] === '-' ? [3, 1, s[2]] : s[4] === '.' ? [5, 2, '.'] : [2, 1, ''];
  const count = separator === '' ? s.length / 2 : (perGroup * (s.length + 1)) / step;
  if (!Number.isInteger(count) || !validMACLength(count)) return undefined;
  const bytes: number[] = [];
  for (let x = 0; x < s.length; x += step) {
    for (let k = 0; k < perGroup; k++) {
      const at = x + 2 * k;
      const last = k === perGroup - 1 && separator !== '';
      bytes.push(xtoi2(last ? s.slice(at) : s.slice(at, at + 2), last ? separator : '') ?? -1);
    }
  }
  return bytes.includes(-1) ? undefined : bytes;
}

// Members -----------------------------------------------------------------------------------------------------------

interface PackageValues {
  [name: string]: Slice;
  classA: Slice;
  classB: Slice;
  classC: Slice;
}

const valuesOfRuns = new WeakMap<Runtime, PackageValues>();

/** The package variables of a run, which a program may modify through their slices. */
function packageValues(): PackageValues {
  const runtime = currentRuntime();
  let values = valuesOfRuns.get(runtime);
  if (!values) {
    const v6 = (last: number, first = 0, second = 0): Slice =>
      newBytes([first, second, ...Array.from({ length: 13 }, () => 0), last]);
    values = {
      classA: newBytes([255, 0, 0, 0]),
      classB: newBytes([255, 255, 0, 0]),
      classC: newBytes([255, 255, 255, 0]),
      IPv4bcast: newBytes(ipv4(255, 255, 255, 255)),
      IPv4allsys: newBytes(ipv4(224, 0, 0, 1)),
      IPv4allrouter: newBytes(ipv4(224, 0, 0, 2)),
      IPv4zero: newBytes(ipv4(0, 0, 0, 0)),
      IPv6zero: v6(0),
      IPv6unspecified: v6(0),
      IPv6loopback: v6(1),
      IPv6interfacelocalallnodes: v6(1, 255, 1),
      IPv6linklocalallnodes: v6(1, 255, 2),
      IPv6linklocalallrouters: v6(2, 255, 2),
    };
    valuesOfRuns.set(runtime, values);
  }
  return values;
}

const UINT8 = BASIC.uint8;
const byteArgs = (args: Value[]): number[] => args.map((arg) => Number(arg as bigint));

export const NET_IP_MEMBERS: Record<string, Entity> = {
  IP: typeEntity(IP),
  IPMask: typeEntity(IP_MASK),
  IPNet: typeEntity(IP_NET),
  HardwareAddr: typeEntity(HARDWARE_ADDR),
  ParseError: typeEntity(PARSE_ERROR),
  AddrError: typeEntity(ADDR_ERROR),
  IPv4len: {
    kind: 'const',
    name: 'IPv4len',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 4n },
    span: { row: 0, column: 0 },
    used: true,
  },
  IPv6len: {
    kind: 'const',
    name: 'IPv6len',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 16n },
    span: { row: 0, column: 0 },
    used: true,
  },
  ...Object.fromEntries(
    [
      'IPv4bcast',
      'IPv4allsys',
      'IPv4allrouter',
      'IPv4zero',
      'IPv6zero',
      'IPv6unspecified',
      'IPv6loopback',
      'IPv6interfacelocalallnodes',
      'IPv6linklocalallnodes',
      'IPv6linklocalallrouters',
    ].map((name) => [name, libraryVariable(name, IP, () => packageValues()[name])])
  ),
  IPv4: nativeFunction('IPv4', fn([UINT8, UINT8, UINT8, UINT8], [IP]), (args) => {
    const [a, b, c, d] = byteArgs(args);
    return newBytes(ipv4(a, b, c, d));
  }),
  IPv4Mask: nativeFunction('IPv4Mask', fn([UINT8, UINT8, UINT8, UINT8], [IP_MASK]), (args) => newBytes(byteArgs(args))),
  CIDRMask: nativeFunction('CIDRMask', fn([INT, INT], [IP_MASK]), ([ones, bits]) => {
    const mask = cidrMask(Number(ones as bigint), Number(bits as bigint));
    return mask && newBytes(mask);
  }),
  ParseIP: nativeFunction('ParseIP', fn([STRING], [IP]), ([s]) => parseIP(s as string)),
  ParseCIDR: nativeFunction('ParseCIDR', fn([STRING], [IP, pointerTo(IP_NET), ERROR_TYPE]), ([s]) =>
    parseCIDR(s as string)
  ),
  ParseMAC: nativeFunction('ParseMAC', fn([STRING], [HARDWARE_ADDR, ERROR_TYPE]), ([s]) => {
    const bytes = parseMACBytes(s as string);
    return bytes ? [newBytes(bytes), undefined] : [undefined, errorValue(ADDR_ERROR, ['invalid MAC address', s])];
  }),
};

export const IP_SLICE = sliceOf(IP);
