// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { encodeRune, runesOf } from './literals';
import { integerWrapper } from './operators';
import { boundsPanic } from './runtimeErrors';
import {
  type BasicKind,
  isBasic,
  isComplex,
  isFloat,
  isInteger,
  isInterface,
  isString,
  type Type,
  underlying,
} from './types';
import { Complex, copyValue, GoArray, Iface, Slice, type Value } from './values';

type Convert = (value: Value, runtime: Allocator) => Value;

/** What a conversion that creates a slice charges for its elements. */
interface Allocator {
  allocate(count: number): void;
}

/**
 * The runtime conversion `T(x)` of a non-constant value, which the compiler has already allowed. A slice converts to a
 * pointer to an array only in later stages, so the compiler rejects that conversion before it gets here.
 */
export function conversion(from: Type, to: Type): Convert {
  if (isInterface(to)) {
    const box = toInterface(from);
    return (value) => box(value);
  }
  if (isString(to)) return toStringConversion(from);
  const target = underlying(to);
  if (target.kind === 'slice' && isString(from))
    return isBasic(target.element, 'uint8') ? stringToBytes : stringToRunes;
  if (target.kind === 'array' && underlying(from).kind === 'slice') return sliceToArray(target.length);
  return numericConversion(from, to) ?? ((value) => value);
}

function numericConversion(from: Type, to: Type): Convert | undefined {
  if (isInteger(to)) {
    if (isInteger(from)) return integerWrapper(to) as Convert;
    if (isFloat(from)) return floatToInteger(basicKindOf(to));
  }
  if (isFloat(to)) {
    const round = isBasic(to, 'float32') ? Math.fround : (value: number): number => value;
    if (isInteger(from)) return (value) => round(Number(value as bigint));
    if (isFloat(from)) return (value) => round(value as number);
  }
  if (isComplex(to) && isComplex(from)) {
    if (!isBasic(to, 'complex64')) return (value) => value;
    return (value) => new Complex(Math.fround((value as Complex).re), Math.fround((value as Complex).im));
  }
  return undefined;
}

function toStringConversion(from: Type): Convert {
  if (isInteger(from)) return (value) => encodeRune(runeOfInteger(value as bigint));
  const under = underlying(from);
  if (under.kind !== 'slice') return (value) => value;
  const encode = isBasic(under.element, 'uint8')
    ? (item: Value): string => String.fromCharCode(Number(item))
    : (item: Value): string => encodeRune(Number(item));
  return (value) => (value === undefined ? '' : (value as Slice).values().map(encode).join(''));
}

const stringToBytes: Convert = (value, runtime) => {
  const text = value as string;
  runtime.allocate(text.length);
  return new Slice(
    Array.from(text, (char) => BigInt(char.charCodeAt(0))),
    0,
    text.length,
    byteCapacity(text.length)
  );
};

const stringToRunes: Convert = (value, runtime) => {
  const runes = runesOf(value as string).map(BigInt);
  runtime.allocate(runes.length);
  return new Slice(runes, 0, runes.length, runeCapacity(runes.length));
};

function sliceToArray(arrayLength: number): Convert {
  return (value) => {
    const slice = value as Slice | undefined;
    const length = slice?.length ?? 0;
    if (length < arrayLength) {
      boundsPanic(`cannot convert slice with length ${length} to array or pointer to array with length ${arrayLength}`);
    }
    return new GoArray((slice as Slice).values().slice(0, arrayLength).map(copyValue));
  };
}

/** Wraps a value in an interface, which an interface value already is. */
export function toInterface(from: Type): (value: Value) => Value {
  if (isInterface(from)) return (value) => value;
  return (value) => new Iface(from, copyValue(value));
}

function basicKindOf(type: Type): BasicKind {
  const under = underlying(type);
  return under.kind === 'basic' ? under.basic : 'int';
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function saturate(value: number, min: bigint, max: bigint): bigint {
  if (Number.isNaN(value)) return 0n;
  if (value <= Number(min)) return min;
  if (value >= Number(max)) return max;
  return BigInt(Math.trunc(value));
}

/**
 * Converts a float to an integer as Go does on arm64, whose conversions saturate: a value beyond the range becomes the
 * nearest limit and NaN becomes 0. Types narrower than 32 bits convert through int32 and keep its low bits.
 */
function floatToInteger(kind: BasicKind): Convert {
  switch (kind) {
    case 'int':
    case 'int64': {
      return (value) => saturate(value as number, INT64_MIN, INT64_MAX);
    }
    case 'uint':
    case 'uint64':
    case 'uintptr': {
      return (value) => saturate(value as number, 0n, 2n ** 64n - 1n);
    }
    case 'uint32': {
      return (value) => saturate(value as number, 0n, 2n ** 32n - 1n);
    }
    case 'int32': {
      return (value) => saturate(value as number, -(2n ** 31n), 2n ** 31n - 1n);
    }
    default: {
      const wrap = integerWrapper({ kind: 'basic', basic: kind, name: kind });
      return (value) => wrap(saturate(value as number, -(2n ** 31n), 2n ** 31n - 1n));
    }
  }
}

/** `string(i)` of an integer, which is U+FFFD for values that are no Unicode code point. */
function runeOfInteger(value: bigint): number {
  return value < 0n || value > 0x10_ff_ffn ? 0xff_fd : Number(value);
}

/** The capacity Go gives the slice from `[]byte(s)`, rounded to its allocator's size classes. */
function byteCapacity(length: number): number {
  return roundUpToSizeClass(length);
}

function runeCapacity(length: number): number {
  return Math.ceil(roundUpToSizeClass(length * 4) / 4);
}

/** Go's small allocation size classes, which decide the capacity of new slices. */
const SIZE_CLASSES = [
  0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352, 384, 416, 448, 480,
  512, 576, 640, 704, 768, 896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200, 3456, 4096, 4864,
  5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10_240, 10_880, 12_288, 13_568, 14_336, 16_384, 18_432, 19_072,
  20_480, 21_760, 24_576, 27_264, 28_672, 32_768,
];

export function roundUpToSizeClass(bytes: number): number {
  if (bytes > 32_768) return Math.ceil(bytes / 8192) * 8192;
  return SIZE_CLASSES.find((size) => size >= bytes) as number;
}
