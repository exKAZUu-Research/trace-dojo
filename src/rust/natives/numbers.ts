// code-gauge-allow-file fileNcss 491 -- One native per method of the standard library.
import { debugFloat, decimalToF32 } from '../floatFormat';
import { F64_CONSTS, FLOAT_LIMITS, floatConstant } from '../floatLimits';
import { normalize } from '../infer';
import { bitsOf, copyValue, intArith, needsCopy, overflow, wrap } from '../ops';
import { arrayTryFrom, intoConversion } from '../traitConversions';
import { INT_NAMES, intMax, intMin, type IntName, shallow, type Type } from '../types';
import { EnumValue, sliceItems, sliceLength, StructValue, textOf, type Value } from '../values';
import {
  define,
  deref,
  err,
  intImplLocation,
  libraryPanic,
  type NativeContext,
  none,
  ok,
  ordering,
  panic,
  some,
} from './support';

function intName(ctx: NativeContext): IntName {
  const t = normalize(shallow(ctx.typeArgs[0]));
  return (t as { name: IntName }).name;
}

function isF32(ctx: NativeContext): boolean {
  const t = normalize(shallow(ctx.typeArgs[0]));
  return t.kind === 'float' && t.name === 'f32';
}

function inRange(name: IntName, value: bigint): boolean {
  return value >= intMin(name) && value <= intMax(name);
}

function checked(ctx: NativeContext, value: bigint): Value {
  return inRange(intName(ctx), value) ? some(ctx, value) : none(ctx);
}

function saturate(name: IntName, value: bigint): bigint {
  const min = intMin(name);
  const max = intMax(name);
  return value < min ? min : value > max ? max : value;
}

function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = BigInt(Math.floor(Math.sqrt(Number(value))));
  while (x * x > value) x--;
  while ((x + 1n) * (x + 1n) <= value) x++;
  return x;
}

/**
 * `base ** exp` when it fits in the type, or undefined when it overflows, without computing huge powers: a base other
 * than 0, 1, and -1 overflows every type once the exponent passes 128.
 */
function power(name: IntName, base: bigint, exp: bigint): bigint | undefined {
  if (base === 0n) return exp === 0n ? 1n : 0n;
  if (base === 1n) return 1n;
  if (base === -1n) return exp % 2n === 0n ? 1n : -1n;
  if (exp > 128n) return undefined;
  const result = base ** exp;
  return inRange(name, result) ? result : undefined;
}

/** `base ** exp` wrapped to the type, by squaring modulo its bit width. */
function wrappingPower(name: IntName, base: bigint, exp: bigint): bigint {
  const modulus = 1n << BigInt(bitsOf(name));
  let result = 1n;
  let square = BigInt.asUintN(bitsOf(name), base);
  for (let rest = exp; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * square) % modulus;
    square = (square * square) % modulus;
  }
  return wrap(name, result);
}

/** Truncated division and remainder, as Rust's integer `/` and `%` are. */
function divEuclid(a: bigint, b: bigint): bigint {
  const q = a / b;
  if (a % b < 0n) return b > 0n ? q - 1n : q + 1n;
  return q;
}

function remEuclid(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r < 0n ? (b < 0n ? r - b : r + b) : r;
}

/** Parses an integer as `str::parse` and `from_str_radix` do, with their errors. */
// code-gauge-allow functionCognitiveComplexity 19 -- Follows std's integer parsing step by step.
export function parseInteger(ctx: NativeContext, text: string, name: IntName, radix: number): Value {
  const errorKind = (kind: string): Value =>
    err(ctx, new StructValue(ctx.interp.program.adtDef('ParseIntError'), [kind]));
  if (text.length === 0) return errorKind('Empty');
  let body = text;
  let negative = false;
  if (body[0] === '+' || body[0] === '-') {
    if (body.length === 1) return errorKind('InvalidDigit');
    negative = body[0] === '-';
    if (negative && name.startsWith('u')) return errorKind('InvalidDigit');
    body = body.slice(1);
  }
  // Like std, reads the digits from the left and reports an overflow as soon as one happens, before later digits.
  let value = 0n;
  const base = BigInt(radix);
  for (const char of body) {
    const digit = Number.parseInt(char, 36);
    if (Number.isNaN(digit) || digit >= radix || !/[\da-z]/i.test(char)) return errorKind('InvalidDigit');
    value = value * base + BigInt(digit);
    if (!negative && value > intMax(name)) return errorKind('PosOverflow');
    if (negative && -value < intMin(name)) return errorKind('NegOverflow');
  }
  return ok(ctx, negative ? -value : value);
}

/** Parses a float as `str::parse::<f64>` does: decimal, `inf`, `infinity`, and `nan` in any case, with a sign. */
export function parseFloatText(ctx: NativeContext, text: string, f32: boolean): Value {
  const fail = (kind: string): Value => err(ctx, new StructValue(ctx.interp.program.adtDef('ParseFloatError'), [kind]));
  if (text.length === 0) return fail('Empty');
  const match = /^([+-]?)(?:(inf|infinity|nan)|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))$/i.exec(text);
  if (!match) return fail('Invalid');
  const sign = match[1] === '-' ? -1 : 1;
  if (match[2]) {
    const special = match[2].toLowerCase() === 'nan' ? Number.NaN : Number.POSITIVE_INFINITY;
    return ok(ctx, sign < 0 ? -special : special);
  }
  return ok(ctx, sign * (f32 ? decimalToF32(match[3]) : Number(match[3])));
}

function float(value: Value): number {
  return deref(value) as number;
}

function round(ctx: NativeContext, value: number): number {
  return isF32(ctx) ? Math.fround(value) : value;
}

const isMinByMinusOne = (ctx: NativeContext, a: bigint, b: bigint): boolean =>
  b === -1n && a === intMin(intName(ctx)) && a !== 0n;

function shifted(ctx: NativeContext, a: bigint, rhs: bigint, left: boolean): bigint {
  const name = intName(ctx);
  const shift = rhs % BigInt(bitsOf(name));
  return left ? wrap(name, a << shift) : a >> shift;
}

function ones(ctx: NativeContext, a: bigint, leading: boolean): bigint {
  const bits = bitsOf(intName(ctx));
  const text = BigInt.asUintN(bits, a).toString(2).padStart(bits, '0');
  const run = leading ? /^1*/.exec(text)! : /1*$/.exec(text)!;
  return BigInt(run[0].length);
}

function checkedLog(ctx: NativeContext, a: bigint, base: bigint): Value {
  if (a <= 0n || base < 2n) return none(ctx);
  let count = 0n;
  for (let value = a; value >= base; value /= base) count++;
  return some(ctx, count);
}

function nextMultiple(a: bigint, b: bigint): bigint {
  const remainder = a % b;
  return remainder === 0n ? a : a + (b - remainder);
}

/** Integer methods beyond the basic arithmetic: euclidean, shifting, logarithmic, and sign-crossing variants. */
const integerExtras: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  overflowing_div: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to divide by zero');
    if (isMinByMinusOne(ctx, a as bigint, b as bigint)) return [a, true];
    return [(a as bigint) / (b as bigint), false];
  },
  overflowing_rem: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to calculate the remainder with a divisor of zero');
    if (isMinByMinusOne(ctx, a as bigint, b as bigint)) return [0n, true];
    return [(a as bigint) % (b as bigint), false];
  },
  overflowing_neg: ([a], ctx) => [wrap(intName(ctx), -(a as bigint)), !inRange(intName(ctx), -(a as bigint))],
  overflowing_pow: ([a, e], ctx) => {
    const name = intName(ctx);
    return [wrappingPower(name, a as bigint, e as bigint), power(name, a as bigint, e as bigint) === undefined];
  },
  overflowing_shl: ([a, n], ctx) => [
    shifted(ctx, a as bigint, n as bigint, true),
    (n as bigint) >= bitsOf(intName(ctx)),
  ],
  overflowing_shr: ([a, n], ctx) => [
    shifted(ctx, a as bigint, n as bigint, false),
    (n as bigint) >= bitsOf(intName(ctx)),
  ],
  checked_shl: ([a, n], ctx) =>
    (n as bigint) >= bitsOf(intName(ctx)) ? none(ctx) : some(ctx, shifted(ctx, a as bigint, n as bigint, true)),
  checked_shr: ([a, n], ctx) =>
    (n as bigint) >= bitsOf(intName(ctx)) ? none(ctx) : some(ctx, shifted(ctx, a as bigint, n as bigint, false)),
  wrapping_shl: ([a, n], ctx) => shifted(ctx, a as bigint, n as bigint, true),
  wrapping_shr: ([a, n], ctx) => shifted(ctx, a as bigint, n as bigint, false),
  checked_div_euclid: ([a, b], ctx) => {
    if ((b as bigint) === 0n || isMinByMinusOne(ctx, a as bigint, b as bigint)) return none(ctx);
    return some(ctx, divEuclid(a as bigint, b as bigint));
  },
  checked_rem_euclid: ([a, b], ctx) => {
    if ((b as bigint) === 0n || isMinByMinusOne(ctx, a as bigint, b as bigint)) return none(ctx);
    return some(ctx, remEuclid(a as bigint, b as bigint));
  },
  wrapping_div_euclid: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to divide by zero');
    return wrap(intName(ctx), divEuclid(a as bigint, b as bigint));
  },
  wrapping_rem_euclid: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to calculate the remainder with a divisor of zero');
    return isMinByMinusOne(ctx, a as bigint, b as bigint) ? 0n : remEuclid(a as bigint, b as bigint);
  },
  saturating_div: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to divide by zero');
    return isMinByMinusOne(ctx, a as bigint, b as bigint) ? intMax(intName(ctx)) : (a as bigint) / (b as bigint);
  },
  checked_ilog2: ([a], ctx) => checkedLog(ctx, a as bigint, 2n),
  checked_ilog10: ([a], ctx) => checkedLog(ctx, a as bigint, 10n),
  checked_ilog: ([a, base], ctx) => checkedLog(ctx, a as bigint, base as bigint),
  leading_ones: ([a], ctx) => ones(ctx, a as bigint, true),
  trailing_ones: ([a], ctx) => ones(ctx, a as bigint, false),
  saturating_neg: ([a], ctx) => saturate(intName(ctx), -(a as bigint)),
  saturating_abs: ([a], ctx) => saturate(intName(ctx), (a as bigint) < 0n ? -(a as bigint) : (a as bigint)),
  overflowing_abs: ([a], ctx) => {
    const value = (a as bigint) < 0n ? -(a as bigint) : (a as bigint);
    return [wrap(intName(ctx), value), !inRange(intName(ctx), value)];
  },
  checked_isqrt: ([a], ctx) => ((a as bigint) < 0n ? none(ctx) : some(ctx, isqrt(a as bigint))),
  cast_unsigned: ([a], ctx) => BigInt.asUintN(bitsOf(intName(ctx)), a as bigint),
  cast_signed: ([a], ctx) => BigInt.asIntN(bitsOf(intName(ctx)), a as bigint),
  checked_next_power_of_two: ([a], ctx) => {
    let power = 1n;
    while (power < (a as bigint)) power <<= 1n;
    return checked(ctx, power);
  },
  div_ceil: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to divide by zero');
    const quotient = (a as bigint) / (b as bigint);
    return (a as bigint) % (b as bigint) === 0n ? quotient : quotient + 1n;
  },
  is_multiple_of: ([a, b]) => ((b as bigint) === 0n ? a === 0n : (a as bigint) % (b as bigint) === 0n),
  next_multiple_of: ([a, b], ctx) => {
    const location = intImplLocation(intName(ctx));
    if ((b as bigint) === 0n) {
      libraryPanic(ctx, 'attempt to calculate the remainder with a divisor of zero', location);
    }
    const result = nextMultiple(a as bigint, b as bigint);
    if (!inRange(intName(ctx), result)) libraryPanic(ctx, 'attempt to add with overflow', location);
    return result;
  },
  checked_next_multiple_of: ([a, b], ctx) =>
    (b as bigint) === 0n ? none(ctx) : checked(ctx, nextMultiple(a as bigint, b as bigint)),
  checked_add_signed: ([a, b], ctx) => checked(ctx, (a as bigint) + (b as bigint)),
  wrapping_add_signed: ([a, b], ctx) => wrap(intName(ctx), (a as bigint) + (b as bigint)),
  saturating_add_signed: ([a, b], ctx) => saturate(intName(ctx), (a as bigint) + (b as bigint)),
};

const integer: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  abs: ([a], ctx) => {
    const value = a as bigint;
    const name = intName(ctx);
    if (value === intMin(name)) libraryPanic(ctx, 'attempt to negate with overflow', intImplLocation(name));
    return value < 0n ? -value : value;
  },
  pow: ([a, e], ctx) => {
    const name = intName(ctx);
    const result = power(name, a as bigint, e as bigint);
    if (result === undefined) libraryPanic(ctx, 'attempt to exponentiate with overflow', intImplLocation(name));
    return result;
  },
  checked_add: ([a, b], ctx) => checked(ctx, (a as bigint) + (b as bigint)),
  checked_sub: ([a, b], ctx) => checked(ctx, (a as bigint) - (b as bigint)),
  checked_mul: ([a, b], ctx) => checked(ctx, (a as bigint) * (b as bigint)),
  checked_div: ([a, b], ctx) => ((b as bigint) === 0n ? none(ctx) : checked(ctx, (a as bigint) / (b as bigint))),
  checked_rem: ([a, b], ctx) => {
    if ((b as bigint) === 0n || (b === -1n && a === intMin(intName(ctx)) && a !== 0n)) return none(ctx);
    return some(ctx, (a as bigint) % (b as bigint));
  },
  checked_pow: ([a, e], ctx) => {
    const result = power(intName(ctx), a as bigint, e as bigint);
    return result === undefined ? none(ctx) : some(ctx, result);
  },
  checked_neg: ([a], ctx) => checked(ctx, -(a as bigint)),
  checked_abs: ([a], ctx) => checked(ctx, (a as bigint) < 0n ? -(a as bigint) : (a as bigint)),
  wrapping_add: ([a, b], ctx) => wrap(intName(ctx), (a as bigint) + (b as bigint)),
  wrapping_sub: ([a, b], ctx) => wrap(intName(ctx), (a as bigint) - (b as bigint)),
  wrapping_mul: ([a, b], ctx) => wrap(intName(ctx), (a as bigint) * (b as bigint)),
  wrapping_div: ([a, b], ctx) => {
    if ((b as bigint) === 0n) divisionByZero(ctx, 'attempt to divide by zero');
    return wrap(intName(ctx), (a as bigint) / (b as bigint));
  },
  wrapping_rem: ([a, b], ctx) => {
    if ((b as bigint) === 0n) divisionByZero(ctx, 'attempt to calculate the remainder with a divisor of zero');
    return wrap(intName(ctx), (a as bigint) % (b as bigint));
  },
  wrapping_neg: ([a], ctx) => wrap(intName(ctx), -(a as bigint)),
  wrapping_pow: ([a, e], ctx) => wrappingPower(intName(ctx), a as bigint, e as bigint),
  wrapping_abs: ([a], ctx) => wrap(intName(ctx), (a as bigint) < 0n ? -(a as bigint) : (a as bigint)),
  saturating_add: ([a, b], ctx) => saturate(intName(ctx), (a as bigint) + (b as bigint)),
  saturating_sub: ([a, b], ctx) => saturate(intName(ctx), (a as bigint) - (b as bigint)),
  saturating_mul: ([a, b], ctx) => saturate(intName(ctx), (a as bigint) * (b as bigint)),
  saturating_pow: ([a, e], ctx) => {
    const name = intName(ctx);
    const result = power(name, a as bigint, e as bigint);
    if (result !== undefined) return result;
    return (a as bigint) < 0n && (e as bigint) % 2n === 1n ? intMin(name) : intMax(name);
  },
  overflowing_add: ([a, b], ctx) => {
    const result = (a as bigint) + (b as bigint);
    return [wrap(intName(ctx), result), !inRange(intName(ctx), result)];
  },
  overflowing_sub: ([a, b], ctx) => {
    const result = (a as bigint) - (b as bigint);
    return [wrap(intName(ctx), result), !inRange(intName(ctx), result)];
  },
  overflowing_mul: ([a, b], ctx) => {
    const result = (a as bigint) * (b as bigint);
    return [wrap(intName(ctx), result), !inRange(intName(ctx), result)];
  },
  rem_euclid: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to calculate the remainder with a divisor of zero');
    if (b === -1n && a === intMin(intName(ctx)) && a !== 0n) overflow('%', ctx.span);
    return remEuclid(a as bigint, b as bigint);
  },
  div_euclid: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to divide by zero');
    const result = divEuclid(a as bigint, b as bigint);
    if (!inRange(intName(ctx), result)) overflow('/', ctx.span);
    return result;
  },
  signum: ([a]) => {
    const value = a as bigint;
    return value > 0n ? 1n : value < 0n ? -1n : 0n;
  },
  is_positive: ([a]) => (a as bigint) > 0n,
  is_negative: ([a]) => (a as bigint) < 0n,
  count_ones: ([a], ctx) =>
    BigInt([...BigInt.asUintN(bitsOf(intName(ctx)), a as bigint).toString(2)].filter((c) => c === '1').length),
  count_zeros: ([a], ctx) => {
    const bits = bitsOf(intName(ctx));
    const ones = [...BigInt.asUintN(bits, a as bigint).toString(2)].filter((c) => c === '1').length;
    return BigInt(bits - ones);
  },
  leading_zeros: ([a], ctx) => {
    const bits = bitsOf(intName(ctx));
    const value = BigInt.asUintN(bits, a as bigint);
    return BigInt(value === 0n ? bits : bits - value.toString(2).length);
  },
  trailing_zeros: ([a], ctx) => {
    const bits = bitsOf(intName(ctx));
    const value = BigInt.asUintN(bits, a as bigint);
    if (value === 0n) return BigInt(bits);
    const text = value.toString(2);
    return BigInt(text.length - 1 - text.lastIndexOf('1'));
  },
  abs_diff: ([a, b]) => {
    const difference = (a as bigint) - (b as bigint);
    return difference < 0n ? -difference : difference;
  },
  unsigned_abs: ([a]) => ((a as bigint) < 0n ? -(a as bigint) : (a as bigint)),
  isqrt: ([a], ctx) => {
    if ((a as bigint) < 0n) panic(ctx, 'argument of integer square root cannot be negative');
    return isqrt(a as bigint);
  },
  ilog2: ([a], ctx) => {
    if ((a as bigint) <= 0n) panic(ctx, 'argument of integer logarithm must be positive');
    return BigInt((a as bigint).toString(2).length - 1);
  },
  ilog10: ([a], ctx) => {
    if ((a as bigint) <= 0n) panic(ctx, 'argument of integer logarithm must be positive');
    return BigInt((a as bigint).toString().length - 1);
  },
  ilog: ([a, base], ctx) => {
    if ((a as bigint) <= 0n) panic(ctx, 'argument of integer logarithm must be positive');
    if ((base as bigint) < 2n) panic(ctx, 'base of integer logarithm must be at least 2');
    let count = 0n;
    let value = a as bigint;
    while (value >= (base as bigint)) {
      value /= base as bigint;
      count++;
    }
    return count;
  },
  is_power_of_two: ([a]) => (a as bigint) > 0n && ((a as bigint) & ((a as bigint) - 1n)) === 0n,
  next_power_of_two: ([a], ctx) => {
    let power = 1n;
    while (power < (a as bigint)) power <<= 1n;
    if (!inRange(intName(ctx), power)) {
      libraryPanic(ctx, 'attempt to add with overflow', intImplLocation(intName(ctx)));
    }
    return power;
  },
  from_str_radix: ([text, radix], ctx) => {
    const base = Number(radix as bigint);
    if (base < 2 || base > 36) {
      const row = intName(ctx).startsWith('i') ? 1866 : 1867;
      libraryPanic(
        ctx,
        `from_ascii_bytes_radix: radix must lie in the range \`[2, 36]\` - found ${base}`,
        `core/src/num/mod.rs:${row}:1`
      );
    }
    return parseInteger(ctx, textOf(text), intName(ctx), base);
  },
  max_value: (_args, ctx) => intMax(intName(ctx)),
  min_value: (_args, ctx) => intMin(intName(ctx)),
  swap_bytes: ([a], ctx) => {
    const bits = bitsOf(intName(ctx));
    let value = BigInt.asUintN(bits, a as bigint);
    let result = 0n;
    for (let i = 0; i < bits / 8; i++) {
      result = (result << 8n) | (value & 0xffn);
      value >>= 8n;
    }
    return wrap(intName(ctx), result);
  },
  reverse_bits: ([a], ctx) => {
    const bits = bitsOf(intName(ctx));
    const text = BigInt.asUintN(bits, a as bigint)
      .toString(2)
      .padStart(bits, '0');
    return wrap(intName(ctx), BigInt(`0b${[...text].toReversed().join('')}`));
  },
  rotate_left: ([a, n], ctx) => {
    const bits = BigInt(bitsOf(intName(ctx)));
    const value = BigInt.asUintN(Number(bits), a as bigint);
    const shift = (n as bigint) % bits;
    return wrap(intName(ctx), (value << shift) | (value >> (bits - shift)));
  },
  rotate_right: ([a, n], ctx) => {
    const bits = BigInt(bitsOf(intName(ctx)));
    const value = BigInt.asUintN(Number(bits), a as bigint);
    const shift = (n as bigint) % bits;
    return wrap(intName(ctx), (value >> shift) | (value << (bits - shift)));
  },
  ...integerExtras,
  midpoint: ([a, b], ctx) => {
    const sum = (a as bigint) + (b as bigint);
    // Signed integers round toward zero, and unsigned ones down.
    return intName(ctx).startsWith('i') ? sum / 2n : sum >> 1n;
  },
};

/** Division by zero in `wrapping_div` and `wrapping_rem`, which signed integers report inside the library. */
function divisionByZero(ctx: NativeContext, message: string): never {
  const name = intName(ctx);
  if (name.startsWith('i')) libraryPanic(ctx, message, intImplLocation(name));
  panic(ctx, message);
}

const floating: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  sqrt: ([a], ctx) => round(ctx, Math.sqrt(float(a))),
  cbrt: ([a], ctx) => round(ctx, Math.cbrt(float(a))),
  powi: ([a, n], ctx) => powi(float(a), Number(n as bigint), (value) => round(ctx, value)),
  powf: ([a, n], ctx) => {
    // C's pow, which Rust calls, gives 1 for 1 to any power and for ±1 to an infinite one, where JavaScript gives NaN.
    const base = float(a);
    const unit = base === 1 || (Math.abs(base) === 1 && Math.abs(float(n)) === Number.POSITIVE_INFINITY);
    return unit ? 1 : round(ctx, Math.pow(base, float(n)));
  },
  abs: ([a], ctx) => round(ctx, Math.abs(float(a))),
  floor: ([a], ctx) => round(ctx, Math.floor(float(a))),
  ceil: ([a], ctx) => round(ctx, Math.ceil(float(a))),
  round: ([a], ctx) => {
    const value = float(a);
    if (Number.isNaN(value)) return value;
    return round(ctx, Math.sign(value) * Math.round(Math.abs(value)) || (Object.is(value, -0) || value < 0 ? -0 : 0));
  },
  round_ties_even: ([a], ctx) => {
    const value = float(a);
    const floor = Math.floor(value);
    const rounded = value - floor === 0.5 && floor % 2 === 0 ? floor : Math.round(value);
    return round(ctx, rounded);
  },
  trunc: ([a], ctx) => round(ctx, Math.trunc(float(a))),
  fract: ([a], ctx) => round(ctx, float(a) - Math.trunc(float(a))),
  sin: ([a], ctx) => round(ctx, Math.sin(float(a))),
  cos: ([a], ctx) => round(ctx, Math.cos(float(a))),
  sin_cos: ([a], ctx) => [round(ctx, Math.sin(float(a))), round(ctx, Math.cos(float(a)))],
  to_bits: ([a], ctx) => {
    if (!isF32(ctx)) return floatBits(float(a));
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, float(a));
    return BigInt(view.getUint32(0));
  },
  from_bits: ([bits], ctx) => {
    if (isF32(ctx)) {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, Number(bits as bigint));
      return view.getFloat32(0);
    }
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, bits as bigint);
    return view.getFloat64(0);
  },
  tan: ([a], ctx) => round(ctx, Math.tan(float(a))),
  asin: ([a], ctx) => round(ctx, Math.asin(float(a))),
  acos: ([a], ctx) => round(ctx, Math.acos(float(a))),
  atan: ([a], ctx) => round(ctx, Math.atan(float(a))),
  atan2: ([a, b], ctx) => round(ctx, Math.atan2(float(a), float(b))),
  sinh: ([a], ctx) => round(ctx, Math.sinh(float(a))),
  cosh: ([a], ctx) => round(ctx, Math.cosh(float(a))),
  tanh: ([a], ctx) => round(ctx, Math.tanh(float(a))),
  asinh: ([a], ctx) => round(ctx, Math.asinh(float(a))),
  acosh: ([a], ctx) => round(ctx, Math.acosh(float(a))),
  // std computes `atanh` from `ln_1p` as below, rounding each step to the type.
  atanh: ([a], ctx) => {
    const x = float(a);
    return round(ctx, 0.5 * round(ctx, Math.log1p(round(ctx, round(ctx, 2 * x) / round(ctx, 1 - x)))));
  },
  exp_m1: ([a], ctx) => round(ctx, Math.expm1(float(a))),
  ln_1p: ([a], ctx) => round(ctx, Math.log1p(float(a))),
  exp: ([a], ctx) => round(ctx, Math.exp(float(a))),
  exp2: ([a], ctx) => round(ctx, 2 ** float(a)),
  ln: ([a], ctx) => round(ctx, Math.log(float(a))),
  log10: ([a], ctx) => round(ctx, Math.log10(float(a))),
  log2: ([a], ctx) => round(ctx, Math.log2(float(a))),
  log: ([a, base], ctx) => round(ctx, round(ctx, Math.log(float(a))) / round(ctx, Math.log(float(base)))),
  hypot: ([a, b], ctx) => round(ctx, Math.hypot(float(a), float(b))),
  min: ([a, b], ctx) =>
    round(ctx, Number.isNaN(float(a)) ? float(b) : Number.isNaN(float(b)) ? float(a) : Math.min(float(a), float(b))),
  max: ([a, b], ctx) =>
    round(ctx, Number.isNaN(float(a)) ? float(b) : Number.isNaN(float(b)) ? float(a) : Math.max(float(a), float(b))),
  clamp: ([a, min, max], ctx) => {
    if (!(float(min) <= float(max))) {
      const f32 = isF32(ctx);
      libraryPanic(
        ctx,
        `min > max, or either was NaN. min = ${debugFloat(float(min), f32)}, max = ${debugFloat(float(max), f32)}`,
        f32 ? 'core/src/num/f32.rs:1605:9' : 'core/src/num/f64.rs:1585:9'
      );
    }
    // Comparing keeps -0 and NaN as they are, where `Math.max(-0, 0)` gives 0.
    const value = float(a);
    return value < float(min) ? float(min) : value > float(max) ? float(max) : value;
  },
  is_nan: ([a]) => Number.isNaN(float(a)),
  is_infinite: ([a]) => !Number.isFinite(float(a)) && !Number.isNaN(float(a)),
  is_finite: ([a]) => Number.isFinite(float(a)),
  signum: ([a]) => {
    const value = float(a);
    if (Number.isNaN(value)) return Number.NaN;
    return value > 0 || Object.is(value, 0) ? 1 : -1;
  },
  is_sign_positive: ([a]) => !signBit(float(a)),
  is_sign_negative: ([a]) => signBit(float(a)),
  // Rust multiplies by a constant of the type: `180 / PI` and `PI / 180` rounded to it.
  to_degrees: ([a], ctx) => round(ctx, float(a) * round(ctx, 180 / Math.PI)),
  to_radians: ([a], ctx) => round(ctx, float(a) * round(ctx, round(ctx, Math.PI) / 180)),
  mul_add: ([a, b, c], ctx) => fma(float(a), float(b), float(c), isF32(ctx)),
  recip: ([a], ctx) => round(ctx, 1 / float(a)),
  total_cmp: ([a, b], ctx) => {
    const x = float(a);
    const y = float(b);
    const kx = totalOrderKey(x);
    const ky = totalOrderKey(y);
    return ordering(ctx, kx < ky ? -1 : kx > ky ? 1 : 0);
  },
  rem_euclid: ([a, b], ctx) => {
    const r = float(a) % float(b);
    return round(ctx, r < 0 ? r + Math.abs(float(b)) : r);
  },
  div_euclid: ([a, b], ctx) => {
    const q = Math.trunc(round(ctx, float(a) / float(b)));
    if (float(a) % float(b) < 0) return round(ctx, float(b) > 0 ? q - 1 : q + 1);
    return round(ctx, q);
  },
  copysign: ([a, sign], ctx) => {
    const magnitude = Math.abs(float(a));
    const negative = signBit(float(sign));
    return round(ctx, negative ? -magnitude : magnitude);
  },
};

/** The integer that orders floats as `total_cmp` does: by their bits, with negative numbers' magnitude bits flipped. */
function totalOrderKey(value: number): bigint {
  const bits = BigInt.asIntN(64, floatBits(value));
  return bits ^ ((bits >> 63n) & 0x7f_ff_ff_ff_ff_ff_ff_ffn);
}

function signBit(value: number): boolean {
  return floatBits(value) >> 63n !== 0n;
}

function floatBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

/** `powi` as compiler-rt's `__powidf2` and `__powisf2` compute it, rounding each step to the type (`round`). */
function powi(base: number, exponent: number, round: (value: number) => number): number {
  if (exponent === 0) return 1;
  let result = 1;
  let factor = base;
  let n = Math.abs(exponent);
  while (n > 0) {
    if (n & 1) result = round(result * factor);
    n >>>= 1;
    if (n > 0) factor = round(factor * factor);
  }
  return exponent < 0 ? round(1 / result) : result;
}

function fma(a: number, b: number, c: number, f32: boolean): number {
  if (Number.isFinite(a) && Number.isFinite(b) && !Number.isFinite(c)) return c;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0 || b === 0) {
    const result = a * b + c;
    return f32 ? Math.fround(result) : result;
  }
  const [ma, ea] = decompose(a);
  const [mb, eb] = decompose(b);
  let mantissa = ma * mb;
  let exponent = ea + eb;
  if (c !== 0) {
    const [mc, ec] = decompose(c);
    if (ec >= exponent) {
      mantissa += mc << BigInt(ec - exponent);
    } else {
      mantissa = (mantissa << BigInt(exponent - ec)) + mc;
      exponent = ec;
    }
  }
  if (mantissa === 0n) return 0;
  return roundBinary(mantissa, exponent, f32);
}

/** A finite double as an integer mantissa and a power of two. */
function decompose(value: number): [bigint, number] {
  const bits = floatBits(value);
  const sign = bits >> 63n ? -1n : 1n;
  const exponentBits = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (exponentBits === 0) return [sign * mantissa, -1074];
  mantissa |= 1n << 52n;
  return [sign * mantissa, exponentBits - 1075];
}

function roundBinary(mantissa: bigint, exponent: number, f32: boolean): number {
  const negative = mantissa < 0n;
  let m = negative ? -mantissa : mantissa;
  let e = exponent;
  const length = m.toString(2).length;
  const shift = Math.max(length - (f32 ? 24 : 53), (f32 ? -149 : -1074) - e);
  if (shift > 0) {
    const half = 1n << BigInt(shift - 1);
    const remainder = m & ((1n << BigInt(shift)) - 1n);
    m >>= BigInt(shift);
    if (remainder > half || (remainder === half && (m & 1n) === 1n)) m++;
    e += shift;
  }
  const magnitude = Number(m) * 2 ** e;
  const result = f32 ? Math.fround(magnitude) : magnitude;
  return negative ? -result : result;
}

// code-gauge-allow functionCognitiveComplexity 16 -- Each checked target has its own representation and error type.
// code-gauge-allow functionNcss 31 -- Dispatches the supported TryFrom conversions.
function tryConvert(ctx: NativeContext, value: Value, from: Type, to: Type): Value {
  const { interp, span, frame } = ctx;
  if (intoConversion(interp.checker.solver, from, to) === 'yes') {
    const into = interp.program.traitDef('Into').methods.get('into')!;
    return ok(ctx, interp.callFn(into, [from, to], [value], undefined, span, frame));
  }
  const array = arrayTryFrom(from, to);
  if (array) return tryArray(ctx, value, array);
  const t = normalize(shallow(to));
  const v = deref(value);
  if (t.kind === 'char') {
    // A `char` from a `u32`: a code point outside the surrogates.
    const code = Number(v as bigint);
    const valid = code <= 0x10_ff_ff && (code < 0xd8_00 || code > 0xdf_ff);
    if (valid) return ok(ctx, String.fromCodePoint(code));
    return err(ctx, new StructValue(ctx.interp.program.adtDef('CharTryFromError'), []));
  }
  if (typeof v === 'string') {
    const code = BigInt(v.codePointAt(0)!);
    if (inRange((t as { name: IntName }).name, code)) return ok(ctx, code);
    return err(ctx, new StructValue(ctx.interp.program.adtDef('TryFromCharError'), []));
  }
  const target = t as { name: IntName };
  const number = v as bigint;
  if (t.kind === 'bool') {
    if (number === 0n || number === 1n) return ok(ctx, number === 1n);
  } else if (inRange(target.name, number)) return ok(ctx, number);
  const kind = number < 0n ? 'NegOverflow' : 'PosOverflow';
  return err(ctx, new StructValue(ctx.interp.program.adtDef('TryFromIntError'), [kind]));
}

function tryArray(
  ctx: NativeContext,
  value: Value,
  { array, mode }: NonNullable<ReturnType<typeof arrayTryFrom>>
): Value {
  const items = deref(value);
  if (sliceLength(items) !== array.len) {
    return err(ctx, mode === 'move' ? items : new StructValue(ctx.interp.program.adtDef('TryFromSliceError'), []));
  }
  if (mode === 'move') return ok(ctx, items);
  if (mode === 'borrow') return ok(ctx, value);
  ctx.runtime.allocate(array.len);
  const copy = sliceItems(items);
  return ok(ctx, needsCopy(array.elem) ? copy.map(copyValue) : [...copy]);
}

/** An integer's bytes, most significant first, in two's complement. */
function bigEndianBytes(name: IntName, value: bigint): bigint[] {
  const bits = bitsOf(name);
  let rest = BigInt.asUintN(bits, value);
  const bytes: bigint[] = [];
  for (let index = 0; index < bits / 8; index++) {
    bytes.unshift(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

function fromBigEndian(name: IntName, bytes: Value[]): bigint {
  const unsigned = bytes.reduce<bigint>((value, byte) => (value << 8n) | (byte as bigint), 0n);
  return wrap(name, unsigned);
}

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  'ParseIntError::kind': ([self], ctx) => {
    const def = ctx.interp.program.adtDef('IntErrorKind');
    const kind = (deref(self) as StructValue).fields[0] as string;
    return new EnumValue(
      def,
      def.variants.findIndex((variant) => variant.name === kind),
      []
    );
  },
  'TryFrom::try_from': ([value], ctx) => tryConvert(ctx, value, ctx.typeArgs[1], ctx.typeArgs[0]),
  'TryInto::try_into': ([value], { interp, typeArgs: [from, to], span, frame }) => {
    const tryFrom = interp.program.traitDef('TryFrom').methods.get('try_from')!;
    return interp.callFn(tryFrom, [to, from], [value], undefined, span, frame);
  },
};
for (const [name, native] of Object.entries(integer)) {
  for (const group of ['Integer', 'SignedInteger', 'UnsignedInteger']) natives[`${group}::${name}`] = native;
}
for (const [name, native] of Object.entries(floating)) natives[`Float::${name}`] = native;
// This target is little-endian, as the machines rustc builds for here are.
for (const name of INT_NAMES) {
  natives[`${name}::to_be_bytes`] = ([a]) => bigEndianBytes(name, a as bigint);
  natives[`${name}::to_le_bytes`] = ([a]) => bigEndianBytes(name, a as bigint).toReversed();
  natives[`${name}::to_ne_bytes`] = natives[`${name}::to_le_bytes`];
  natives[`${name}::from_be_bytes`] = ([bytes]) => fromBigEndian(name, deref(bytes) as Value[]);
  natives[`${name}::from_le_bytes`] = ([bytes]) => fromBigEndian(name, (deref(bytes) as Value[]).toReversed());
  natives[`${name}::from_ne_bytes`] = natives[`${name}::from_le_bytes`];
}
define(natives);

const consts: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const name of Object.keys(F64_CONSTS)) {
  consts[`const:${name}`] = (_args, ctx) => floatConstant(name, isF32Type(ctx.typeArgs[0]) ? 'f32' : 'f64');
}
for (const [name, value] of Object.entries(FLOAT_LIMITS)) {
  // The modules `std::i32` and its kin, which predate the associated constants, keep `MAX` and `MIN` too.
  consts[`const:${name}`] = (_args, ctx) => {
    const type = normalize(shallow(ctx.typeArgs[0]));
    if (type.kind === 'int') return name === 'MAX' ? intMax(type.name) : intMin(type.name);
    return isF32Type(type) ? value.f32 : value.f64;
  };
  consts[`const:f64::${name}`] = () => value.f64;
  consts[`const:f32::${name}`] = () => value.f32;
}
for (const name of [
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
] as IntName[]) {
  consts[`const:${name}::MAX`] = () => intMax(name);
  consts[`const:${name}::MIN`] = () => intMin(name);
  consts[`const:${name}::BITS`] = () => BigInt(bitsOf(name));
}
consts['const:char::MAX'] = () => String.fromCodePoint(0x10_ff_ff);
define(consts);

function isF32Type(type: Type | undefined): boolean {
  if (!type) return false;
  const t = normalize(shallow(type));
  return t.kind === 'float' && t.name === 'f32';
}

export { intArith };
