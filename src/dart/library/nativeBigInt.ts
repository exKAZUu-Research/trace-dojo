import { LIMITS } from '../../interpreter/limits';
import { formatDouble } from '../format';
import { wrap } from '../operators';
import type { Runtime } from '../runtime';
import { DartObject, type Value } from '../values';
import { bitLength, magnitudeBitLength as bitsOf, modInverse, radixDigit, radixSource } from './nativeNumbers';
import { define, defineConstructor, intArg, named, numArg, stringArg } from './nativeSupport';

interface BigIntState {
  value: bigint;
  values(): Iterable<Value>;
}

function newBigInt(runtime: Runtime, value: bigint): DartObject {
  checkSize(runtime, bitsOf(value));
  const object = new DartObject(runtime.links.classNamed('_BigIntImpl'), [], []);
  object.native = { value, values: () => [] } satisfies BigIntState as unknown as DartObject['native'];
  return object;
}

function valueOf(runtime: Runtime, value: Value, name = 'other'): bigint {
  const state = value instanceof DartObject ? (value.native as unknown as BigIntState | undefined) : undefined;
  if (typeof state?.value !== 'bigint')
    runtime.throwTypeError(`type '${runtime.classOf(value).name}' is not a subtype of type 'BigInt' of '${name}'`);
  return (state as BigIntState).value;
}

const MAX_BITS = 4 * LIMITS.maxStringLength;

function checkSize(runtime: Runtime, bits: number): void {
  if (bits > MAX_BITS) runtime.throwError('OutOfMemoryError', '', []);
}

function reserve(runtime: Runtime, minimumBits: number, operations: number): void {
  checkSize(runtime, minimumBits);
  runtime.spend(1 + operations);
}

function parseBigInt(runtime: Runtime, text: string, radix: number | undefined): bigint | undefined {
  runtime.spend(1 + text.length / 64);
  const [rest, base, negative] = radixSource(text.trim(), radix);
  if (rest.length === 0) return undefined;
  let start = 0;
  while (rest[start] === '0') start++;
  if (start === rest.length) return 0n;
  const digits = rest.slice(start);
  for (const char of digits) if (radixDigit(char, base) < 0) return undefined;
  const bitsPerDigit = Math.log2(base);
  const minimumBits = Math.floor((digits.length - 1) * bitsPerDigit);
  const maximumBits = Math.ceil(digits.length * bitsPerDigit) + 1;
  reserve(runtime, minimumBits, maximumBits / 128);
  const prefix = HOST_PREFIXES.get(base);
  const result =
    prefix === undefined ? combineRadixDigits(runtime, digits, base, bitsPerDigit) : BigInt(`${prefix}${digits}`);
  return negative ? -result : result;
}

function combineRadixDigits(runtime: Runtime, digits: string, radix: number, bitsPerDigit: number): bigint {
  const base = BigInt(radix);
  const powers = new Map<number, bigint>();
  const convert = (from: number, to: number): bigint => {
    const length = to - from;
    // Eight digits fit exactly in a number even at radix 36.
    if (length <= 8) return BigInt(Number.parseInt(digits.slice(from, to), radix));
    const rightLength = Math.floor(length / 2);
    const split = to - rightLength;
    const left = convert(from, split);
    const right = convert(split, to);
    runtime.spend(1 + (length * bitsPerDigit) / 512);
    let power = powers.get(rightLength);
    if (power === undefined) {
      power = base ** BigInt(rightLength);
      powers.set(rightLength, power);
    }
    return left * power + right;
  };
  return convert(0, digits.length);
}

const HOST_PREFIXES = new Map([
  [2, '0b'],
  [8, '0o'],
  [10, ''],
  [16, '0x'],
]);

function radixOf(runtime: Runtime, radix: Value): number | undefined {
  if (radix === undefined) return undefined;
  const value = Number(intArg(runtime, radix, 'radix'));
  if (value < 2 || value > 36) runtime.throwError('RangeError', 'range', [radix, 2n, 36n, 'radix']);
  return value;
}

// The constants are single objects, so `identical(BigInt.one, BigInt.one)` holds.
const constants = new WeakMap<Runtime, Map<bigint, DartObject>>();
function constant(runtime: Runtime, value: bigint): DartObject {
  let table = constants.get(runtime);
  if (!table) {
    table = new Map();
    constants.set(runtime, table);
  }
  let object = table.get(value);
  if (!object) {
    object = newBigInt(runtime, value);
    table.set(value, object);
  }
  return object;
}
define('BigInt.zero', (runtime) => constant(runtime, 0n));
define('BigInt.one', (runtime) => constant(runtime, 1n));
define('BigInt.two', (runtime) => constant(runtime, 2n));
define('BigInt.parse', (runtime, _receiver, [source], namedArgs) => {
  const text = stringArg(runtime, source, 'source');
  const value = parseBigInt(runtime, text, radixOf(runtime, named(namedArgs, 'radix', undefined)));
  if (value === undefined) return runtime.throwError('FormatException', '', ['Could not parse BigInt', text]);
  return newBigInt(runtime, value);
});
define('BigInt.tryParse', (runtime, _receiver, [source], namedArgs) => {
  const value = parseBigInt(
    runtime,
    stringArg(runtime, source, 'source'),
    radixOf(runtime, named(namedArgs, 'radix', undefined))
  );
  return value === undefined ? undefined : newBigInt(runtime, value);
});
defineConstructor('BigInt.from', (runtime, _instance, args) => {
  const value = numArg(runtime, args.positional[0], 'value');
  if (typeof value === 'bigint') return newBigInt(runtime, value);
  if (!Number.isFinite(value))
    return runtime.throwError('ArgumentError', '', [`Value must be finite: ${formatDouble(value)}`]);
  return newBigInt(runtime, BigInt(Math.trunc(value)));
});

interface BinaryCost {
  minimumBits?: number;
  work: number;
}

function binary(
  name: string,
  cost: (a: number, b: number) => BinaryCost,
  run: (runtime: Runtime, a: bigint, b: bigint) => bigint
): void {
  define(`BigInt.${name}`, (runtime, receiver, [other]) => {
    const a = valueOf(runtime, receiver);
    const b = valueOf(runtime, other);
    const { minimumBits = 0, work } = cost(bitsOf(a), bitsOf(b));
    reserve(runtime, minimumBits, work);
    return newBigInt(runtime, run(runtime, a, b));
  });
}

const linear = (a: number, b: number): BinaryCost => ({ work: (a + b) / 2048 });
const product = (a: number, b: number): BinaryCost => ({
  minimumBits: a === 0 || b === 0 ? 0 : a + b - 1,
  work: (a + b) / 512,
});
const quotient = (a: number, b: number): BinaryCost => ({ work: (a + b) / 512 });
/** Euclid's algorithm takes up to a step per bit, each a division through the digits. */
const euclid = (a: number, b: number): BinaryCost => ({ work: Math.max(a, b) ** 2 / 131_072 });

function checkDivisor(runtime: Runtime, b: bigint): void {
  if (b === 0n) runtime.throwError('IntegerDivisionByZeroException', '', []);
}

binary('+', linear, (_runtime, a, b) => a + b);
binary('-', linear, (_runtime, a, b) => a - b);
binary('*', product, (_runtime, a, b) => a * b);
binary('~/', quotient, (runtime, a, b) => {
  checkDivisor(runtime, b);
  return a / b;
});
binary('%', quotient, (runtime, a, b) => {
  checkDivisor(runtime, b);
  const remainder = a % b;
  if (remainder >= 0n) return remainder;
  return b < 0n ? remainder - b : remainder + b;
});
binary('remainder', quotient, (runtime, a, b) => {
  checkDivisor(runtime, b);
  return a % b;
});
binary('&', linear, (_runtime, a, b) => a & b);
binary('|', linear, (_runtime, a, b) => a | b);
binary('^', linear, (_runtime, a, b) => a ^ b);
binary('gcd', euclid, (_runtime, a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
});
binary('modInverse', euclid, (runtime, a, b) => modInverse(runtime, a, b));
define(
  'BigInt./',
  (runtime, receiver, [other]) => Number(valueOf(runtime, receiver)) / Number(valueOf(runtime, other))
);
define('BigInt.unary-', (runtime, receiver) => newBigInt(runtime, -valueOf(runtime, receiver)));
define('BigInt.~', (runtime, receiver) => newBigInt(runtime, ~valueOf(runtime, receiver)));
define('BigInt.abs', (runtime, receiver) => {
  const value = valueOf(runtime, receiver);
  return newBigInt(runtime, value < 0n ? -value : value);
});
define('BigInt.<<', (runtime, receiver, [shift]) => {
  const value = valueOf(runtime, receiver);
  const amount = checkShiftAmount(runtime, intArg(runtime, shift, 'shiftAmount'));
  const bits = bitsOf(value) + Number(amount);
  if (value !== 0n && amount > 0n) reserve(runtime, bits, bits / 2048);
  return newBigInt(runtime, value << amount);
});
define('BigInt.>>', (runtime, receiver, [shift]) =>
  newBigInt(runtime, valueOf(runtime, receiver) >> checkShiftAmount(runtime, intArg(runtime, shift, 'shiftAmount')))
);
for (const [name, compare] of [
  ['<', (a: bigint, b: bigint) => a < b],
  ['<=', (a: bigint, b: bigint) => a <= b],
  ['>', (a: bigint, b: bigint) => a > b],
  ['>=', (a: bigint, b: bigint) => a >= b],
] as const) {
  define(`BigInt.${name}`, (runtime, receiver, [other]) =>
    compare(valueOf(runtime, receiver), valueOf(runtime, other))
  );
}
define('BigInt.==', (runtime, receiver, [other]) => {
  const state = other instanceof DartObject ? (other.native as unknown as BigIntState | undefined) : undefined;
  return typeof state?.value === 'bigint' && state.value === valueOf(runtime, receiver);
});
function jenkinsCombine(hash: number, digit: number): number {
  let next = 0x1f_ff_ff_ff & (hash + digit);
  next = 0x1f_ff_ff_ff & (next + ((0x00_07_ff_ff & next) << 10));
  return next ^ (next >> 6);
}

// The Jenkins hash over the 32-bit digits of the magnitude, as the VM's _BigIntImpl.hashCode.
define('BigInt.hashCode', (runtime, receiver) => {
  const value = valueOf(runtime, receiver);
  if (value === 0n) return 6707n;
  let hash = value < 0n ? 83_585 : 429_689;
  for (const digit of digitsOf(value < 0n ? -value : value)) hash = jenkinsCombine(hash, Number(digit));
  hash = 0x1f_ff_ff_ff & (hash + ((0x03_ff_ff_ff & hash) << 3));
  hash ^= hash >> 11;
  return BigInt(0x1f_ff_ff_ff & (hash + ((0x00_00_3f_ff & hash) << 15)));
});
define('BigInt.compareTo', (runtime, receiver, [other]) => {
  const a = valueOf(runtime, receiver);
  const b = valueOf(runtime, other);
  if (a < 0n !== b < 0n) return a < 0n ? -1n : 1n;
  const result = compareDigits(a < 0n ? -a : a, b < 0n ? -b : b);
  return a < 0n ? -result : result;
});

/** The VM's comparison of magnitudes: the difference of their counts of 32-bit digits, else of the first unequal digit. */
function compareDigits(a: bigint, b: bigint): bigint {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (x.length !== y.length) return BigInt(x.length - y.length);
  for (let position = x.length - 1; position >= 0; position--) {
    if (x[position] !== y[position]) return x[position] - y[position];
  }
  return 0n;
}
/** The 32-bit digits of a magnitude from the least significant, read from its hexadecimal text in linear time. */
function digitsOf(value: bigint): bigint[] {
  if (value === 0n) return [];
  const hex = value.toString(16);
  const digits: bigint[] = [];
  for (let end = hex.length; end > 0; end -= 8) digits.push(BigInt(`0x${hex.slice(Math.max(0, end - 8), end)}`));
  return digits;
}
define('BigInt.toUnsigned', (runtime, receiver, [width]) => {
  const bits = Number(checkShiftAmount(runtime, intArg(runtime, width, 'width')));
  const value = valueOf(runtime, receiver);
  // A negative value fills every bit of the width.
  if (value < 0n) reserve(runtime, bits, bits / 2048);
  return newBigInt(runtime, bits > MAX_BITS ? value : BigInt.asUintN(bits, value));
});
define('BigInt.toSigned', (runtime, receiver, [width]) => {
  const signBit = checkShiftAmount(runtime, wrap(intArg(runtime, width, 'width') - 1n));
  const value = valueOf(runtime, receiver);
  return newBigInt(runtime, signBit >= BigInt(MAX_BITS) ? value : BigInt.asIntN(Number(signBit) + 1, value));
});
define('BigInt.bitLength', (runtime, receiver) => BigInt(bitLength(valueOf(runtime, receiver))));
define('BigInt.sign', (runtime, receiver) => {
  const value = valueOf(runtime, receiver);
  return value > 0n ? 1n : value < 0n ? -1n : 0n;
});
define('BigInt.isEven', (runtime, receiver) => (valueOf(runtime, receiver) & 1n) === 0n);
define('BigInt.isOdd', (runtime, receiver) => (valueOf(runtime, receiver) & 1n) === 1n);
define('BigInt.isNegative', (runtime, receiver) => valueOf(runtime, receiver) < 0n);
define('BigInt.pow', (runtime, receiver, [exponent]) => {
  const power = intArg(runtime, exponent, 'exponent');
  if (power < 0n) runtime.throwError('ArgumentError', '', [`Exponent must not be negative: ${power}`]);
  const base = valueOf(runtime, receiver);
  if (base !== 0n && base !== 1n && base !== -1n) {
    const bits = bitsOf(base);
    const exponent = Number(power);
    reserve(runtime, (bits - 1) * exponent + 1, (bits * exponent) / 512);
  }
  return newBigInt(runtime, base ** power);
});
define('BigInt.modPow', (runtime, receiver, [exponent, modulus]) => {
  let power = valueOf(runtime, exponent, 'exponent');
  const m = valueOf(runtime, modulus, 'modulus');
  if (power < 0n) runtime.throwError('ArgumentError', '', [`Exponent must not be negative: ${power}`]);
  if (m <= 0n) runtime.throwError('ArgumentError', '', [`Modulus must be strictly positive: ${m}`]);
  // A squaring and a reduction modulo `m` per bit of the exponent.
  reserve(runtime, bitsOf(m), (bitsOf(power) * bitsOf(m)) / 512);
  let result = 1n % m;
  let base = ((valueOf(runtime, receiver) % m) + m) % m;
  while (power > 0n) {
    if (power & 1n) result = (result * base) % m;
    base = (base * base) % m;
    power >>= 1n;
  }
  return newBigInt(runtime, result);
});
define(
  'BigInt.isValidInt',
  (runtime, receiver) => BigInt.asIntN(64, valueOf(runtime, receiver)) === valueOf(runtime, receiver)
);
define('BigInt.toInt', (runtime, receiver) => {
  // The VM clamps values beyond the 64-bit range.
  const value = valueOf(runtime, receiver);
  if (value > 9_223_372_036_854_775_807n) return 9_223_372_036_854_775_807n;
  if (value < -9_223_372_036_854_775_808n) return -9_223_372_036_854_775_808n;
  return value;
});
define('BigInt.toDouble', (runtime, receiver) => Number(valueOf(runtime, receiver)));
define('BigInt.toString', (runtime, receiver) => digitsText(runtime, valueOf(runtime, receiver), 10));
define('BigInt.toRadixString', (runtime, receiver, [radix]) =>
  digitsText(runtime, valueOf(runtime, receiver), radixOf(runtime, radix) ?? 10)
);

function digitsText(runtime: Runtime, value: bigint, radix: number): string {
  const bits = bitsOf(value);
  reserve(runtime, 0, bits / 128);
  const signLength = value < 0n ? 1 : 0;
  if (bits - 4 >= (LIMITS.maxStringLength - signLength) * Math.log2(radix)) {
    runtime.throwError('OutOfMemoryError', '', []);
  }
  const text = value.toString(radix);
  if (text.length > LIMITS.maxStringLength) runtime.throwError('OutOfMemoryError', '', []);
  return text;
}

function checkShiftAmount(runtime: Runtime, amount: bigint): bigint {
  if (amount < 0n) runtime.throwError('ArgumentError', '', [`shift-amount must be positive ${amount}`]);
  return amount;
}
