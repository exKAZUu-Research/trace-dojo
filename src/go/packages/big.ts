// code-gauge-allow-file fileNcss 437 -- Keeps each arithmetic algorithm beside its execution checks and host-allocation guards.
import { ExecutionLimitError, LIMITS } from '../../interpreter/limits';
import { rationalToFloat } from '../constants';
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { formatFloat } from '../floatFormat';
import { type BoundCall, dynamicMethod } from '../methods';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { GoPanic } from '../runtime';
import { nilPointerPanic } from '../runtimeErrors';
import { BASIC, pointerTo, RUNE, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Value } from '../values';
import { parseRational } from './bigRatParser';
import { STATE } from './fmt';
import { BOOL, byteSlice, INT, STRING } from './support';

/** `big.Int` and `big.Rat`, whose values live in their native state as JavaScript bigints. */
const INT_TYPE = namedType('big', 'Int', { kind: 'struct', fields: [] });
const RAT_TYPE = namedType('big', 'Rat', { kind: 'struct', fields: [] });
const INT_POINTER = pointerTo(INT_TYPE);
const RAT_POINTER = pointerTo(RAT_TYPE);
const MAX_BIG_INT = 1n << BigInt(LIMITS.maxStringLength);
const INT64 = BASIC.int64;
const UINT64 = BASIC.uint64;

function structOf(pointer: Value): GoStruct {
  if (!(pointer instanceof Pointer)) nilPointerPanic();
  return (pointer as Pointer).load() as GoStruct;
}

const intOf = (pointer: Value): bigint => (structOf(pointer).native?.int as bigint | undefined) ?? 0n;

function setInt(pointer: Value, value: bigint): Value {
  checkBigInt(value);
  const struct = structOf(pointer);
  struct.native ??= {};
  struct.native.int = value;
  return pointer;
}

const newInt = (value: bigint): Pointer => {
  checkBigInt(value);
  return new Pointer(new Cell(new GoStruct([], { int: value })), 'v');
};

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function text(value: bigint, base: number): string {
  if (base <= 36) return value.toString(base);
  chargeBits(BigInt(bitLength(value)));
  let rest = value < 0n ? -value : value;
  let result = '';
  do {
    chargeBits(BigInt(bitLength(rest)));
    result = DIGITS[Number(rest % BigInt(base))] + result;
    rest /= BigInt(base);
  } while (rest > 0n);
  return (value < 0n ? '-' : '') + result;
}

/** Int.SetString: digits in the base, or with base 0 a prefix that chooses it, with `_` between digits. */
// code-gauge-allow functionCognitiveComplexity 22 -- Keeps each arithmetic algorithm beside its execution checks and host-allocation guards.
function parseInt(source: string, base: number): bigint | undefined {
  let rest = source;
  let negative = false;
  if (rest.startsWith('+') || rest.startsWith('-')) {
    negative = rest.startsWith('-');
    rest = rest.slice(1);
  }
  let radix = base;
  if (base === 0) {
    radix = 10;
    const prefix = /^0([bBoOxX])?/.exec(rest);
    if (prefix && rest.length > 1) {
      radix = prefix[1] ? { b: 2, o: 8, x: 16 }[prefix[1].toLowerCase() as 'b' | 'o' | 'x'] : 8;
      rest = rest.slice(prefix[0].length);
      if (rest.startsWith('_')) rest = rest.slice(1);
    }
    if (/^_|_$|__/.test(rest)) return undefined;
    rest = rest.replaceAll('_', '');
  }
  if (rest === '') return undefined;
  let value = 0n;
  for (const char of rest) {
    chargeBits(BigInt(bitLength(value)) + 6n);
    const digit = radix <= 36 ? DIGITS.indexOf(char.toLowerCase()) : DIGITS.indexOf(char);
    if (digit < 0 || digit >= radix) return undefined;
    value = value * BigInt(radix) + BigInt(digit);
  }
  return negative ? -value : value;
}

/** Truncated division, as Go's Quo and Rem. */
function quoRem(x: bigint, y: bigint): [bigint, bigint] {
  if (y === 0n) throw new GoPanic(newError('division by zero'));
  return [x / y, x % y];
}

/** Euclidean division, as Go's Div and Mod, whose remainder is never negative. */
function divMod(x: bigint, y: bigint): [bigint, bigint] {
  const [q, r] = quoRem(x, y);
  if (r < 0n) return y > 0n ? [q - 1n, r + y] : [q + 1n, r - y];
  return [q, r];
}

// code-gauge-allow functionCognitiveComplexity 19 -- Keeps each arithmetic algorithm beside its execution checks and host-allocation guards.
function power(base: bigint, exponent: bigint, modulus: bigint | undefined): bigint {
  if (exponent <= 0n) return modulus !== undefined && modulus !== 0n && (modulus === 1n || modulus === -1n) ? 0n : 1n;
  if ((modulus === undefined || modulus === 0n) && (base > 1n || base < -1n))
    chargeBits(BigInt(bitLength(base)) * exponent);
  let result = 1n;
  let b = base;
  let e = exponent;
  const reduce = (value: bigint): bigint => {
    if (modulus === undefined || modulus === 0n) return value;
    const m = modulus < 0n ? -modulus : modulus;
    return ((value % m) + m) % m;
  };
  b = reduce(b);
  while (e > 0n) {
    currentRuntime().spend();
    chargeBits(BigInt(Math.max(bitLength(result), bitLength(b))));
    if (e & 1n) result = reduce(result * b);
    e >>= 1n;
    if (e > 0n) b = reduce(b * b);
  }
  return reduce(result);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    chargeBits(BigInt(Math.max(bitLength(x), bitLength(y))));
    [x, y] = [y, x % y];
  }
  return x;
}

/** The extended Euclidean algorithm: g, and x and y with a*x + b*y = g, as Go's GCD returns them. */
function extendedGcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (a === 0n && b === 0n) return [0n, 0n, 0n];
  let [oldR, r] = [a < 0n ? -a : a, b < 0n ? -b : b];
  let [oldS, s] = [1n, 0n];
  let [oldT, t] = [0n, 1n];
  while (r !== 0n) {
    currentRuntime().spend();
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  return [oldR, a < 0n ? -oldS : oldS, b < 0n ? -oldT : oldT];
}

function sqrt(value: bigint): bigint {
  if (value < 0n) throw new GoPanic(new Iface(BASIC.string, 'square root of negative number'));
  if (value < 2n) return value;
  let estimate = 1n << BigInt(Math.ceil(bitLength(value) / 2));
  for (;;) {
    currentRuntime().spend();
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

/** A deterministic Miller–Rabin test with the first prime bases, which is exact for the sizes programs use. */
// code-gauge-allow functionCognitiveComplexity 18 -- Keeps each arithmetic algorithm beside its execution checks and host-allocation guards.
function probablyPrime(value: bigint): boolean {
  if (value < 2n) return false;
  const small = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n, 53n];
  for (const prime of small) {
    if (value === prime) return true;
    if (value % prime === 0n) return false;
  }
  let d = value - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  for (const base of small) {
    let x = power(base, d, value);
    if (x === 1n || x === value - 1n) continue;
    let composite = true;
    for (let round = 1; round < s; round++) {
      x = (x * x) % value;
      if (x === value - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

const bitLength = (value: bigint): number => (value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length);

// Int methods -----------------------------------------------------------------------------------------------------------

const binary = (name: string, op: (x: bigint, y: bigint) => bigint): void => {
  addMethod(
    INT_TYPE,
    name,
    fn([INT_POINTER, INT_POINTER], [INT_POINTER]),
    (z, [x, y]) => setInt(z, op(intOf(x), intOf(y))),
    true
  );
};
binary('Add', (x, y) => x + y);
binary('Sub', (x, y) => x - y);
binary('Mul', (x, y) => x * y);
binary('Quo', (x, y) => quoRem(x, y)[0]);
binary('Rem', (x, y) => quoRem(x, y)[1]);
binary('Div', (x, y) => divMod(x, y)[0]);
binary('Mod', (x, y) => divMod(x, y)[1]);
binary('And', (x, y) => x & y);
binary('Or', (x, y) => x | y);
binary('Xor', (x, y) => x ^ y);
binary('AndNot', (x, y) => x & ~y);

const unary = (name: string, op: (x: bigint) => bigint): void => {
  addMethod(INT_TYPE, name, fn([INT_POINTER], [INT_POINTER]), (z, [x]) => setInt(z, op(intOf(x))), true);
};
unary('Set', (x) => x);
unary('Neg', (x) => -x);
unary('Abs', (x) => (x < 0n ? -x : x));
unary('Not', (x) => ~x);
unary('Sqrt', sqrt);

const methods: [string, Type[], Type[], (z: Value, args: Value[]) => Value | Value[]][] = [
  ['SetInt64', [INT64], [INT_POINTER], (z, [x]) => setInt(z, x as bigint)],
  ['SetUint64', [UINT64], [INT_POINTER], (z, [x]) => setInt(z, x as bigint)],
  [
    'SetString',
    [STRING, INT],
    [INT_POINTER, BOOL],
    (z, [s, base]) => {
      const value = parseInt(s as string, Number(base as bigint));
      if (value === undefined) return [undefined, false];
      return [setInt(z, value), true];
    },
  ],
  [
    'QuoRem',
    [INT_POINTER, INT_POINTER, INT_POINTER],
    [INT_POINTER, INT_POINTER],
    (z, [x, y, r]) => {
      const [q, remainder] = quoRem(intOf(x), intOf(y));
      return [setInt(z, q), setInt(r, remainder)];
    },
  ],
  [
    'DivMod',
    [INT_POINTER, INT_POINTER, INT_POINTER],
    [INT_POINTER, INT_POINTER],
    (z, [x, y, m]) => {
      const [q, remainder] = divMod(intOf(x), intOf(y));
      return [setInt(z, q), setInt(m, remainder)];
    },
  ],
  [
    'Exp',
    [INT_POINTER, INT_POINTER, INT_POINTER],
    [INT_POINTER],
    (z, [x, y, m]) => {
      let base = intOf(x);
      let exponent = intOf(y);
      const modulus = m === undefined ? undefined : intOf(m);
      if (exponent < 0n && modulus !== undefined && modulus !== 0n) {
        const positive = modulus < 0n ? -modulus : modulus;
        const [divisor, inverse] = extendedGcd(base, positive);
        if (divisor !== 1n) return;
        base = inverse;
        exponent = -exponent;
      }
      return setInt(z, power(base, exponent, modulus));
    },
  ],
  [
    'MulRange',
    [INT64, INT64],
    [INT_POINTER],
    (z, [a, b]) => {
      const low = a as bigint;
      const high = b as bigint;
      if (low > high) return setInt(z, 1n);
      if (low <= 0n && high >= 0n) return setInt(z, 0n);
      let product = 1n;
      for (let factor = low; factor <= high; factor++) {
        chargeBits(BigInt(bitLength(product) + bitLength(factor)));
        product *= factor;
      }
      return setInt(z, product);
    },
  ],
  [
    'Binomial',
    [INT64, INT64],
    [INT_POINTER],
    (z, [n, k]) => {
      let top = n as bigint;
      let count = k as bigint;
      if (count < 0n || count > top) return setInt(z, 0n);
      if (count > top - count) count = top - count;
      let result = 1n;
      for (let index = 1n; index <= count; index++) {
        chargeBits(BigInt(bitLength(result) + bitLength(top)));
        result = (result * top) / index;
        top--;
      }
      return setInt(z, result);
    },
  ],
  [
    'GCD',
    [INT_POINTER, INT_POINTER, INT_POINTER, INT_POINTER],
    [INT_POINTER],
    (z, [x, y, a, b]) => {
      const left = intOf(a);
      const right = intOf(b);
      const [g, s, t] = extendedGcd(left, right);
      if (x !== undefined) setInt(x, s);
      if (y !== undefined) setInt(y, t);
      return setInt(z, g);
    },
  ],
  [
    'ModInverse',
    [INT_POINTER, INT_POINTER],
    [INT_POINTER],
    (z, [g, n]) => {
      const modulus = intOf(n) < 0n ? -intOf(n) : intOf(n);
      const input = intOf(g);
      const value = input < 0n ? divMod(input, modulus)[1] : input;
      const [d, s] = extendedGcd(value, modulus);
      if (d !== 1n) return;
      return setInt(z, s < 0n ? s + modulus : s);
    },
  ],
  [
    'Lsh',
    [INT_POINTER, BASIC.uint],
    [INT_POINTER],
    (z, [x, n]) => {
      const value = intOf(x);
      if (value !== 0n) chargeBits(BigInt(bitLength(value)) + (n as bigint));
      return setInt(z, value << (n as bigint));
    },
  ],
  ['Rsh', [INT_POINTER, BASIC.uint], [INT_POINTER], (z, [x, n]) => setInt(z, intOf(x) >> (n as bigint))],
  ['Cmp', [INT_POINTER], [INT], (x, [y]) => BigInt(compare(intOf(x), intOf(y)))],
  [
    'CmpAbs',
    [INT_POINTER],
    [INT],
    (x, [y]) => {
      const a = intOf(x);
      const b = intOf(y);
      return BigInt(compare(a < 0n ? -a : a, b < 0n ? -b : b));
    },
  ],
  ['Sign', [], [INT], (x) => BigInt(compare(intOf(x), 0n))],
  ['Int64', [], [INT64], (x) => BigInt.asIntN(64, intOf(x))],
  ['Uint64', [], [UINT64], (x) => BigInt.asUintN(64, intOf(x) < 0n ? -intOf(x) : intOf(x))],
  ['IsInt64', [], [BOOL], (x) => BigInt.asIntN(64, intOf(x)) === intOf(x)],
  ['IsUint64', [], [BOOL], (x) => intOf(x) >= 0n && BigInt.asUintN(64, intOf(x)) === intOf(x)],
  ['BitLen', [], [INT], (x) => BigInt(bitLength(intOf(x)))],
  [
    'Bit',
    [INT],
    [BASIC.uint],
    (x, [i]) => {
      if ((i as bigint) < 0n) throw new GoPanic(new Iface(BASIC.string, 'negative bit index'));
      return (intOf(x) >> (i as bigint)) & 1n;
    },
  ],
  [
    'TrailingZeroBits',
    [],
    [BASIC.uint],
    (x) => {
      let value = intOf(x);
      if (value === 0n) return 0n;
      let count = 0n;
      while ((value & 1n) === 0n) {
        value >>= 1n;
        count++;
      }
      return count;
    },
  ],
  [
    'ProbablyPrime',
    [INT],
    [BOOL],
    (x, [n]) => {
      if ((n as bigint) < 0n) throw new GoPanic(new Iface(BASIC.string, 'negative n for ProbablyPrime'));
      return probablyPrime(intOf(x));
    },
  ],
  ['Text', [INT], [STRING], (x, [base]) => (x === undefined ? '<nil>' : text(intOf(x), Number(base as bigint)))],
  ['String', [], [STRING], (x) => (x === undefined ? '<nil>' : text(intOf(x), 10))],
];
for (const [name, params, results, impl] of methods)
  addMethod(
    INT_TYPE,
    name,
    fn(params, results),
    (receiver, args) => {
      currentRuntime().spend();
      return impl(receiver, args);
    },
    true
  );

function compare(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Calls a method of the fmt.State that Format receives. */
function stateCall(state: Value, name: string, args: Value[]): Value | Value[] {
  const iface = state as Iface;
  return (dynamicMethod(iface.type, name) as BoundCall)(iface.value, args);
}

const stateFlag = (state: Value, flag: string): boolean =>
  stateCall(state, 'Flag', [BigInt(flag.codePointAt(0) as number)]) === true;

/** Int.Format, as Go's intFormat: `[left pad][sign][prefix][zero pad][digits][right pad]`. */
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes math/big's Int.Format.
// code-gauge-allow functionNcss 44 -- Keeps each arithmetic algorithm beside its execution checks and host-allocation guards.
function formatInt(x: Value, state: Value, verb: number): void {
  const write = (text: string): void => void stateCall(state, 'Write', [byteSlice(text)]);
  const char = String.fromCodePoint(verb);
  const bases: Record<string, number> = { b: 2, o: 8, O: 8, d: 10, s: 10, v: 10, x: 16, X: 16 };
  const base = bases[char];
  if (base === undefined) {
    write(`%!${char}(big.Int=${x === undefined ? '<nil>' : text(intOf(x), 10)})`);
    return;
  }
  if (x === undefined) {
    write('<nil>');
    return;
  }
  const value = intOf(x);
  const sign = value < 0n ? '-' : stateFlag(state, '+') ? '+' : stateFlag(state, ' ') ? ' ' : '';
  let prefix = '';
  if (stateFlag(state, '#')) prefix = { b: '0b', o: '0', x: '0x', X: '0X' }[char] ?? '';
  if (char === 'O') prefix = '0o';
  let digits = (value < 0n ? -value : value).toString(base);
  if (char === 'X') digits = digits.toUpperCase();
  let left = 0;
  let zeros = 0;
  let right = 0;
  const [precision, precisionSet] = stateCall(state, 'Precision', []) as [bigint, boolean];
  if (precisionSet) {
    if (digits.length < Number(precision)) zeros = Number(precision) - digits.length;
    else if (digits === '0' && precision === 0n) return;
  }
  const length = sign.length + prefix.length + zeros + digits.length;
  const [width, widthSet] = stateCall(state, 'Width', []) as [bigint, boolean];
  if (widthSet && length < Number(width)) {
    const pad = Number(width) - length;
    if (stateFlag(state, '-')) right = pad;
    else if (stateFlag(state, '0') && !precisionSet) zeros = pad;
    else left = pad;
  }
  currentRuntime().checkStringLength(left + zeros + right + sign.length + prefix.length + digits.length);
  write(' '.repeat(left) + sign + prefix + '0'.repeat(zeros) + digits + ' '.repeat(right));
}

addMethod(
  INT_TYPE,
  'Format',
  fn([STATE, RUNE], []),
  (x, [state, verb]) => {
    formatInt(x, state, Number(verb as bigint));
    return;
  },
  true
);

// Rat -------------------------------------------------------------------------------------------------------------------

interface Fraction {
  num: bigint;
  den: bigint;
}

const ratOf = (pointer: Value): Fraction =>
  (structOf(pointer).native?.rat as Fraction | undefined) ?? { num: 0n, den: 1n };

function normalize(num: bigint, den: bigint): Fraction {
  if (den === 0n) throw new GoPanic(new Iface(BASIC.string, 'division by zero'));
  const sign = den < 0n ? -1n : 1n;
  const divisor = gcd(num, den) || 1n;
  return { num: (sign * num) / divisor, den: (sign * den) / divisor };
}

function setRat(pointer: Value, value: Fraction): Value {
  const struct = structOf(pointer);
  checkBigInt(value.num);
  checkBigInt(value.den);
  struct.native = { ...struct.native, rat: { num: value.num, den: value.den } };
  return pointer;
}

const newRat = (value: Fraction): Pointer => new Pointer(new Cell(new GoStruct([], { rat: value })), 'v');

const ratString = (value: Fraction): string => `${value.num}/${value.den}`;

/** Rat.FloatString: the decimal with the digits after the point, rounded half away from zero. */
function floatString(value: Fraction, digits: number): string {
  chargeBits(BigInt(Math.max(0, digits)) * 4n);
  const negative = value.num < 0n;
  const absolute = negative ? -value.num : value.num;
  const scale = 10n ** BigInt(Math.max(digits, 0));
  let [whole, rest] = [absolute / value.den, absolute % value.den];
  let fraction = (rest * scale) / value.den;
  rest = (rest * scale) % value.den;
  if (rest * 2n >= value.den) {
    fraction++;
    if (fraction >= scale) {
      fraction -= scale;
      whole++;
    }
  }
  let result = String(whole);
  if (digits > 0) result += `.${String(fraction).padStart(digits, '0')}`;
  return (negative ? '-' : '') + result;
}

function ratFloat64(value: Fraction): [number, boolean] {
  const result = rationalToFloat(value);
  return [result, normalizeExact(result, value)];
}

function normalizeExact(result: number, value: Fraction): boolean {
  if (!Number.isFinite(result)) return false;
  const back = fractionOf(result);
  return back.num === value.num && back.den === value.den;
}

/** The exact fraction of a float64. */
function fractionOf(x: number): Fraction {
  if (x === 0) return { num: 0n, den: 1n };
  const text = formatFloat(x, 'b', -1, 64);
  const [mantissa, exponent] = text.split('p');
  const e = Number(exponent);
  return e >= 0 ? normalize(BigInt(mantissa) << BigInt(e), 1n) : normalize(BigInt(mantissa), 1n << BigInt(-e));
}

const ratBinary = (name: string, op: (x: Fraction, y: Fraction) => Fraction): void => {
  addMethod(
    RAT_TYPE,
    name,
    fn([RAT_POINTER, RAT_POINTER], [RAT_POINTER]),
    (z, [x, y]) => setRat(z, op(ratOf(x), ratOf(y))),
    true
  );
};
ratBinary('Add', (x, y) => normalize(x.num * y.den + y.num * x.den, x.den * y.den));
ratBinary('Sub', (x, y) => normalize(x.num * y.den - y.num * x.den, x.den * y.den));
ratBinary('Mul', (x, y) => normalize(x.num * y.num, x.den * y.den));
ratBinary('Quo', (x, y) => normalize(x.num * y.den, x.den * y.num));

const ratMethods: [string, Type[], Type[], (z: Value, args: Value[]) => Value | Value[]][] = [
  ['Set', [RAT_POINTER], [RAT_POINTER], (z, [x]) => setRat(z, ratOf(x))],
  ['SetInt', [INT_POINTER], [RAT_POINTER], (z, [x]) => setRat(z, { num: intOf(x), den: 1n })],
  ['SetInt64', [INT64], [RAT_POINTER], (z, [x]) => setRat(z, { num: x as bigint, den: 1n })],
  ['SetFrac', [INT_POINTER, INT_POINTER], [RAT_POINTER], (z, [a, b]) => setRat(z, normalize(intOf(a), intOf(b)))],
  ['SetFrac64', [INT64, INT64], [RAT_POINTER], (z, [a, b]) => setRat(z, normalize(a as bigint, b as bigint))],
  [
    'SetFloat64',
    [BASIC.float64],
    [RAT_POINTER],
    (z, [x]) => (Number.isFinite(x) ? setRat(z, fractionOf(x as number)) : undefined),
  ],
  [
    'SetString',
    [STRING],
    [RAT_POINTER, BOOL],
    (z, [s]) => {
      const value = parseRational(s as string, parseInt, chargeBits);
      return value ? [setRat(z, normalize(value.num, value.den)), true] : [undefined, false];
    },
  ],
  ['Neg', [RAT_POINTER], [RAT_POINTER], (z, [x]) => setRat(z, { num: -ratOf(x).num, den: ratOf(x).den })],
  [
    'Abs',
    [RAT_POINTER],
    [RAT_POINTER],
    (z, [x]) => setRat(z, { num: ratOf(x).num < 0n ? -ratOf(x).num : ratOf(x).num, den: ratOf(x).den }),
  ],
  [
    'Inv',
    [RAT_POINTER],
    [RAT_POINTER],
    (z, [x]) => {
      if (ratOf(x).num === 0n) throw new GoPanic(new Iface(BASIC.string, 'division by zero'));
      return setRat(z, normalize(ratOf(x).den, ratOf(x).num));
    },
  ],
  ['Cmp', [RAT_POINTER], [INT], (x, [y]) => BigInt(compare(ratOf(x).num * ratOf(y).den, ratOf(y).num * ratOf(x).den))],
  ['Sign', [], [INT], (x) => BigInt(compare(ratOf(x).num, 0n))],
  ['IsInt', [], [BOOL], (x) => ratOf(x).den === 1n],
  ['Num', [], [INT_POINTER], (x) => component(x, 'num')],
  ['Denom', [], [INT_POINTER], (x) => component(x, 'den')],
  ['String', [], [STRING], (x) => (x === undefined ? '<nil>' : ratString(ratOf(x)))],
  ['RatString', [], [STRING], (x) => (ratOf(x).den === 1n ? String(ratOf(x).num) : ratString(ratOf(x)))],
  ['FloatString', [INT], [STRING], (x, [n]) => floatString(ratOf(x), Number(n as bigint))],
  ['Float64', [], [BASIC.float64, BOOL], (x) => ratFloat64(ratOf(x))],
];
for (const [name, params, results, impl] of ratMethods)
  addMethod(
    RAT_TYPE,
    name,
    fn(params, results),
    (receiver, args) => {
      currentRuntime().spend();
      return impl(receiver, args);
    },
    true
  );

const members: Record<string, Entity> = {
  Int: typeEntity(INT_TYPE),
  Rat: typeEntity(RAT_TYPE),
  NewInt: nativeFunction('NewInt', fn([INT64], [INT_POINTER]), ([x]) => newInt(x as bigint)),
  NewRat: nativeFunction('NewRat', fn([INT64, INT64], [RAT_POINTER]), ([a, b]) =>
    newRat(normalize(a as bigint, b as bigint))
  ),
  MaxBase: {
    kind: 'const',
    name: 'MaxBase',
    type: BASIC.untypedRune,
    value: { kind: 'int', value: 62n },
    span: { row: 0, column: 0 },
    used: true,
  },
};

export const BIG_PACKAGE = definePackage('math/big', members, [
  'Float',
  'NewFloat',
  'ParseFloat',
  'Word',
  'Accuracy',
  'RoundingMode',
  'ErrNaN',
  'Jacobi',
  'ToNearestEven',
  'ToNearestAway',
  'ToZero',
  'AwayFromZero',
  'ToNegativeInf',
  'ToPositiveInf',
  'Below',
  'Exact',
  'Above',
  'MaxExp',
  'MinExp',
  'MaxPrec',
]);

function component(receiver: Value, part: 'num' | 'den'): Pointer {
  const struct = structOf(receiver);
  struct.native ??= {};
  const key = `${part}Pointer`;
  let pointer = struct.native[key] as Pointer | undefined;
  if (!pointer) {
    const state = {
      get int(): bigint {
        return ratOf(receiver)[part];
      },
      set int(value: bigint) {
        struct.native ??= {};
        const fraction = (struct.native.rat ??= { num: 0n, den: 1n }) as Fraction;
        fraction[part] = value;
      },
    };
    pointer = new Pointer(new Cell(new GoStruct([], state)), 'v');
    struct.native[key] = pointer;
  }
  return pointer;
}

function checkBigInt(value: bigint): void {
  if (value >= MAX_BIG_INT || value <= -MAX_BIG_INT) throw new ExecutionLimitError('storage');
  currentRuntime().spend();
}

function chargeBits(bits: bigint): void {
  if (bits > BigInt(LIMITS.maxStringLength)) throw new ExecutionLimitError('storage');
  currentRuntime().spend();
}
