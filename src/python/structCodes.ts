// The binary layouts of the struct module's format characters, which memoryview's formats share.
import { pyError } from './types';

export type CodeKind = 'signed' | 'unsigned' | 'float' | 'bool' | 'char' | 'pad' | 'string' | 'pascal';

export interface CodeInfo {
  kind: CodeKind;
  size: number;
}

const code = (kind: CodeKind, size: number): CodeInfo => ({ kind, size });

/** The format characters with their sizes on a 64-bit platform, where alignment equals size. */
export const NATIVE_CODES: Readonly<Record<string, CodeInfo>> = {
  x: code('pad', 1),
  c: code('char', 1),
  b: code('signed', 1),
  B: code('unsigned', 1),
  '?': code('bool', 1),
  h: code('signed', 2),
  H: code('unsigned', 2),
  i: code('signed', 4),
  I: code('unsigned', 4),
  l: code('signed', 8),
  L: code('unsigned', 8),
  q: code('signed', 8),
  Q: code('unsigned', 8),
  n: code('signed', 8),
  N: code('unsigned', 8),
  e: code('float', 2),
  f: code('float', 4),
  d: code('float', 8),
  s: code('string', 1),
  p: code('pascal', 1),
  P: code('unsigned', 8),
};

/** The format characters with their standard sizes, which the byte orders `<`, `>`, `!`, and `=` use. */
export const STANDARD_CODES: Readonly<Record<string, CodeInfo>> = Object.fromEntries(
  Object.entries(NATIVE_CODES)
    .filter(([char]) => !'nNP'.includes(char))
    .map(([char, info]) => [char, 'lL'.includes(char) ? code(info.kind, 4) : info])
);

const BYTE_HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

export function readInteger(bytes: Uint8Array, little: boolean, signed: boolean): bigint {
  if (bytes.length === 0) return 0n;
  let value = 0n;
  if (bytes.length <= 8) {
    for (let index = 0; index < bytes.length; index++) {
      value = (value << 8n) | BigInt(bytes[little ? bytes.length - 1 - index : index]);
    }
  } else {
    let hex = '0x';
    for (let index = 0; index < bytes.length; index++) {
      hex += BYTE_HEX[bytes[little ? bytes.length - 1 - index : index]];
    }
    value = BigInt(hex);
  }
  const signByte = bytes[little ? bytes.length - 1 : 0];
  if (signed && (signByte & 0x80) !== 0) value -= 1n << BigInt(bytes.length * 8);
  return value;
}

/** Writes the low `size` bytes of an integer in two's complement. */
export function writeInteger(value: bigint, size: number, little: boolean, out: Uint8Array, offset: number): void {
  let rest = BigInt.asUintN(size * 8, value);
  for (let index = 0; index < size; index++) {
    out[offset + (little ? index : size - 1 - index)] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

export function readFloat(bytes: Uint8Array, little: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (bytes.length === 8) return view.getFloat64(0, little);
  if (bytes.length === 4) return view.getFloat32(0, little);
  return halfToFloat(view.getUint16(0, little));
}

export function writeFloat(value: number, size: number, little: boolean, out: Uint8Array, offset: number): void {
  const view = new DataView(out.buffer, out.byteOffset + offset, size);
  if (size === 8) view.setFloat64(0, value, little);
  else if (size === 4) {
    if (Number.isFinite(value) && !Number.isFinite(Math.fround(value))) {
      throw pyError('OverflowError', 'float too large to pack with f format');
    }
    view.setFloat32(0, value, little);
  } else {
    view.setUint16(0, floatToHalf(value), little);
  }
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x80_00 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3_ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** The half-precision bits of a float, rounding half to even as CPython's PyFloat_Pack2 does. */
function floatToHalf(value: number): number {
  const sign = value < 0 || Object.is(value, -0) ? 0x80_00 : 0;
  const magnitude = Math.abs(value);
  if (Number.isNaN(value)) return 0x7e_00;
  if (magnitude === Number.POSITIVE_INFINITY) return sign | 0x7c_00;
  if (magnitude === 0) return sign;
  let exponent = Math.floor(Math.log2(magnitude));
  if (2 ** exponent > magnitude) exponent--;
  if (2 ** (exponent + 1) <= magnitude) exponent++;
  if (exponent < -14) {
    const units = roundHalfEven(magnitude / 2 ** -24);
    return sign | units;
  }
  let fraction = roundHalfEven((magnitude / 2 ** exponent - 1) * 1024);
  if (fraction === 1024) {
    fraction = 0;
    exponent++;
  }
  if (exponent > 15) throw pyError('OverflowError', 'float too large to pack with e format');
  return sign | ((exponent + 15) << 10) | fraction;
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference > 0.5 || (difference === 0.5 && floor % 2 === 1)) return floor + 1;
  return floor;
}
