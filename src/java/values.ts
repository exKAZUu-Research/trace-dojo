import type { TurtleState } from '../interpreter/turtleWorld';
import type { ClassInfo, JavaType, NumericKind } from './types';

/** Java `null` is `undefined`; `long` values are bigints and the other numeric values are numbers. */
export type Value = number | bigint | boolean | JavaString | JavaObject | JavaArray | undefined;

/** Strings are objects so that `==` compares references as in Java. */
export class JavaString {
  constructor(readonly value: string) {}
}

let nextIdentity = 1;

export class JavaObject {
  readonly fields: Value[];
  readonly identity = nextIdentity++;
  /** Set by the builtin Turtle constructor. */
  turtle?: TurtleState;
  /** The elements of a builtin list or the items an iterator walks over. */
  elements?: Value[];
  /** The entries of a builtin hash map or set. */
  store?: HashStore;
  /** The text of a `StringBuilder`. */
  builder?: string;
  /** Counts the structural changes of a builtin collection, which make its iterators fail fast. */
  modCount?: number;
  /** The primitive value a wrapper object such as an `Integer` boxes. */
  boxed?: number | bigint | boolean;
  /** Set for the constants of an enum. */
  enumConstant?: { name: JavaString; ordinal: number };
  /** Set by the builtin Throwable constructors. */
  message?: JavaString;
  cause?: JavaObject;

  constructor(readonly cls: ClassInfo) {
    this.fields = Array.from({ length: cls.instanceFieldCount });
    for (const field of cls.instanceFields) this.fields[field.slot] = defaultValue(field.type);
  }
}

export interface HashEntry {
  key: Value;
  value: Value;
  hash: number;
}

/**
 * The entries of a `HashMap` or `HashSet`, which iterates as Java's does: by bucket of a table that doubles whenever
 * the entries exceed three quarters of it, and in insertion order within a bucket.
 */
export class HashStore {
  entries: HashEntry[] = [];
  capacity = 16;

  /** The entries in the order Java's iteration visits them. */
  ordered(): HashEntry[] {
    const mask = this.capacity - 1;
    const bucketOf = (entry: HashEntry): number => (entry.hash ^ (entry.hash >>> 16)) & mask;
    return this.entries.toSorted((a, b) => bucketOf(a) - bucketOf(b));
  }

  add(entry: HashEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.capacity * 0.75) this.capacity *= 2;
  }
}

export class JavaArray {
  readonly identity = nextIdentity++;

  constructor(
    readonly elementType: JavaType,
    readonly values: Value[]
  ) {}
}

export function defaultValue(type: JavaType): Value {
  switch (type.kind) {
    case 'byte':
    case 'short':
    case 'int':
    case 'char':
    case 'float':
    case 'double': {
      return 0;
    }
    case 'long': {
      return 0n;
    }
    case 'boolean': {
      return false;
    }
    default: {
      return undefined;
    }
  }
}

/** Formats a double as `Double.toString` does (JDK 19 and later print the shortest round-trip digits). */
export function formatDouble(value: number): string {
  return formatShortest(value, (magnitude) => magnitude.toExponential());
}

/** Formats a float as `Float.toString` does: the shortest digits that read back as the same float. */
export function formatFloat(value: number): string {
  return formatShortest(value, shortestFloatDigits);
}

/** The double whose shortest digits are those `Float.toString` prints for `value`. */
export function floatToShortestDouble(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  return Math.sign(value) * Number(twoDigitsAtLeast(Math.abs(value), shortestFloatDigits));
}

function shortestFloatDigits(magnitude: number): string {
  for (let precision = 1; precision < 9; precision++) {
    const candidate = magnitude.toExponential(precision - 1);
    if (Math.fround(Number(candidate)) === magnitude) return candidate;
  }
  return magnitude.toExponential(8);
}

/**
 * The shortest digits in exponential notation, but at least two of them as Java prints: among the two-digit
 * decimals, the closest one reads back as the same value whenever a one-digit one does.
 */
function twoDigitsAtLeast(magnitude: number, shortest: (magnitude: number) => string): string {
  const digits = shortest(magnitude);
  return digits.includes('.') ? digits : magnitude.toExponential(1);
}

function formatShortest(value: number, shortest: (magnitude: number) => string): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponentText] = twoDigitsAtLeast(Math.abs(value), shortest).split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '');
  const exponent = Number(exponentText);
  if (exponent < -3 || exponent >= 7) return `${sign}${digits[0]}.${digits.slice(1) || '0'}E${exponent}`;
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  const integer = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
  return `${sign}${integer}.${digits.slice(exponent + 1) || '0'}`;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

/** Converts a numeric value between kinds as Java's widening and narrowing primitive conversions do. */
export function convertNumber(value: Value, from: NumericKind, to: NumericKind): Value {
  if (from === to) return value;
  if (from === 'long') {
    const big = value as bigint;
    switch (to) {
      case 'float': {
        return Math.fround(Number(big));
      }
      case 'double': {
        return Number(big);
      }
      default: {
        return narrowInt(Number(BigInt.asIntN(32, big)), to);
      }
    }
  }
  const number = value as number;
  switch (to) {
    case 'long': {
      if (from !== 'float' && from !== 'double') return BigInt(number);
      if (Number.isNaN(number)) return 0n;
      if (number >= 2 ** 63) return LONG_MAX;
      if (number <= -(2 ** 63)) return LONG_MIN;
      return BigInt(Math.trunc(number));
    }
    case 'float': {
      return Math.fround(number);
    }
    case 'double': {
      return number;
    }
    default: {
      return narrowInt(from === 'float' || from === 'double' ? doubleToInt(number) : number, to);
    }
  }
}

/** Narrows an int to `byte`, `short`, `char`, or keeps it as `int`. */
function narrowInt(value: number, to: NumericKind): number {
  switch (to) {
    case 'byte': {
      return (value << 24) >> 24;
    }
    case 'short': {
      return (value << 16) >> 16;
    }
    case 'char': {
      return value & 0xff_ff;
    }
    default: {
      return value;
    }
  }
}

/** Wraps a bigint to 64 bits as Java's long arithmetic does. */
export function toInt64(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}

/** Wraps a number to 32 bits as Java's int arithmetic does. */
export function toInt32(value: number): number {
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps around at 32 bits, which Math.trunc does not.
  return value | 0;
}

/** Java chars are UTF-16 code units, so a char is read as a code unit, not a code point. */
export function charCodeOf(text: string, index: number): number {
  // oxlint-disable-next-line unicorn/prefer-code-point -- Java chars are UTF-16 code units.
  return text.charCodeAt(index);
}

/** Narrows a double to int as Java does: NaN becomes 0 and out-of-range values saturate. */
export function doubleToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= 2_147_483_647) return 2_147_483_647;
  if (value <= -2_147_483_648) return -2_147_483_648;
  return Math.trunc(value);
}

export function charToString(code: number): string {
  return String.fromCodePoint(code);
}
