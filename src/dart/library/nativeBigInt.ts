import { formatDouble } from '../format';
import type { Runtime } from '../runtime';
import { DartObject, type Value } from '../values';
import { bitLength, modInverse, numberHash } from './nativeNumbers';
import { define, defineConstructor, intArg, named, numArg, stringArg } from './nativeSupport';

interface BigIntState {
  value: bigint;
  values(): Iterable<Value>;
}

function newBigInt(runtime: Runtime, value: bigint): DartObject {
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

// code-gauge-allow duplicateLines 22 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
function parseBigInt(text: string, radix: number | undefined): bigint | undefined {
  let rest = text.trim();
  let negative = false;
  if (rest.startsWith('-') || rest.startsWith('+')) {
    negative = rest.startsWith('-');
    rest = rest.slice(1);
  }
  let base = radix ?? 10;
  if (radix === undefined && /^0[xX]/.test(rest)) {
    base = 16;
    rest = rest.slice(2);
  }
  if (rest.length === 0) return undefined;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  let result = 0n;
  for (const char of rest.toLowerCase()) {
    const digit = digits.indexOf(char);
    if (digit === -1) return undefined;
    result = result * BigInt(base) + BigInt(digit);
  }
  return negative ? -result : result;
}

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
  const value = parseBigInt(text, radixOf(runtime, named(namedArgs, 'radix', undefined)));
  if (value === undefined) return runtime.throwError('FormatException', '', ['Could not parse BigInt', text]);
  return newBigInt(runtime, value);
});
define('BigInt.tryParse', (runtime, _receiver, [source], namedArgs) => {
  const value = parseBigInt(
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

function binary(name: string, run: (runtime: Runtime, a: bigint, b: bigint) => bigint): void {
  define(`BigInt.${name}`, (runtime, receiver, [other]) =>
    newBigInt(runtime, run(runtime, valueOf(runtime, receiver), valueOf(runtime, other)))
  );
}

function checkDivisor(runtime: Runtime, b: bigint): void {
  if (b === 0n) runtime.throwError('IntegerDivisionByZeroException', '', []);
}

binary('+', (_runtime, a, b) => a + b);
binary('-', (_runtime, a, b) => a - b);
binary('*', (_runtime, a, b) => a * b);
binary('~/', (runtime, a, b) => {
  checkDivisor(runtime, b);
  return a / b;
});
binary('%', (runtime, a, b) => {
  checkDivisor(runtime, b);
  const remainder = a % b;
  if (remainder >= 0n) return remainder;
  return b < 0n ? remainder - b : remainder + b;
});
binary('remainder', (runtime, a, b) => {
  checkDivisor(runtime, b);
  return a % b;
});
binary('&', (_runtime, a, b) => a & b);
binary('|', (_runtime, a, b) => a | b);
binary('^', (_runtime, a, b) => a ^ b);
binary('gcd', (_runtime, a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
});
binary('modInverse', (runtime, a, b) => modInverse(runtime, a, b));
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
define('BigInt.<<', (runtime, receiver, [shift]) =>
  newBigInt(runtime, valueOf(runtime, receiver) << intArg(runtime, shift, 'shiftAmount'))
);
define('BigInt.>>', (runtime, receiver, [shift]) =>
  newBigInt(runtime, valueOf(runtime, receiver) >> intArg(runtime, shift, 'shiftAmount'))
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
define('BigInt.hashCode', (runtime, receiver) => numberHash(BigInt.asIntN(64, valueOf(runtime, receiver))));
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
function digitsOf(value: bigint): bigint[] {
  const digits: bigint[] = [];
  for (let rest = value; rest > 0n; rest >>= 32n) digits.push(rest & 0xff_ff_ff_ffn);
  return digits;
}
define('BigInt.toUnsigned', (runtime, receiver, [width]) =>
  newBigInt(runtime, BigInt.asUintN(Number(intArg(runtime, width, 'width')), valueOf(runtime, receiver)))
);
define('BigInt.toSigned', (runtime, receiver, [width]) =>
  newBigInt(runtime, BigInt.asIntN(Number(intArg(runtime, width, 'width')), valueOf(runtime, receiver)))
);
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
  runtime.spend(Number(power) / 64 + 1);
  return newBigInt(runtime, base ** power);
});
define('BigInt.modPow', (runtime, receiver, [exponent, modulus]) => {
  let power = valueOf(runtime, exponent, 'exponent');
  const m = valueOf(runtime, modulus, 'modulus');
  if (power < 0n) runtime.throwError('ArgumentError', '', [`Exponent must not be negative: ${power}`]);
  if (m <= 0n) runtime.throwError('ArgumentError', '', [`Modulus must be strictly positive: ${m}`]);
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
define('BigInt.toString', (runtime, receiver) => valueOf(runtime, receiver).toString());
define('BigInt.toRadixString', (runtime, receiver, [radix]) =>
  valueOf(runtime, receiver).toString(radixOf(runtime, radix) ?? 10)
);
