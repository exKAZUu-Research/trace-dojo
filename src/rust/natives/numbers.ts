import { normalize } from '../infer';
import { bitsOf, intArith, overflow, wrap } from '../ops';
import { RustPanic } from '../runtime';
import { intMax, intMin, type IntName, shallow, type Type } from '../types';
import { StructValue, type Value } from '../values';
import { define, deref, err, type NativeContext, none, ok, ordering, panic, some } from './support';

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
  let value = 0n;
  const base = BigInt(radix);
  for (const char of body) {
    const digit = Number.parseInt(char, 36);
    if (Number.isNaN(digit) || digit >= radix || !/[\da-z]/i.test(char)) return errorKind('InvalidDigit');
    value = value * base + BigInt(digit);
  }
  const result = negative ? -value : value;
  if (result > intMax(name)) return errorKind('PosOverflow');
  if (result < intMin(name)) return errorKind('NegOverflow');
  return ok(ctx, result);
}

/** Parses a float as `str::parse::<f64>` does: decimal, `inf`, `infinity`, and `nan` in any case, with a sign. */
export function parseFloatText(ctx: NativeContext, text: string, f32: boolean): Value {
  const fail = (kind: string): Value => err(ctx, new StructValue(ctx.interp.program.adtDef('ParseFloatError'), [kind]));
  if (text.length === 0) return fail('Empty');
  const match = /^([+-]?)(?:(inf|infinity|nan)|(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))$/i.exec(text);
  if (!match) return fail('Invalid');
  const sign = match[1] === '-' ? -1 : 1;
  let value: number;
  if (match[2]) value = match[2].toLowerCase() === 'nan' ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  else value = sign * Number(match[3]);
  return ok(ctx, f32 ? Math.fround(value) : value);
}

function float(value: Value): number {
  return deref(value) as number;
}

function round(ctx: NativeContext, value: number): number {
  return isF32(ctx) ? Math.fround(value) : value;
}

const integer: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  abs: ([a], ctx) => {
    const value = a as bigint;
    if (value === intMin(intName(ctx)) && intName(ctx).startsWith('i')) overflow('neg', ctx.span);
    return value < 0n ? -value : value;
  },
  pow: ([a, e], ctx) => {
    const name = intName(ctx);
    let result = 1n;
    const base = a as bigint;
    for (let i = 0n; i < (e as bigint); i++) {
      result *= base;
      if (!inRange(name, result)) throw new RustPanic('attempt to multiply with overflow', ctx.span);
    }
    return result;
  },
  checked_add: ([a, b], ctx) => checked(ctx, (a as bigint) + (b as bigint)),
  checked_sub: ([a, b], ctx) => checked(ctx, (a as bigint) - (b as bigint)),
  checked_mul: ([a, b], ctx) => checked(ctx, (a as bigint) * (b as bigint)),
  checked_div: ([a, b], ctx) => ((b as bigint) === 0n ? none(ctx) : checked(ctx, (a as bigint) / (b as bigint))),
  checked_rem: ([a, b], ctx) => ((b as bigint) === 0n ? none(ctx) : checked(ctx, (a as bigint) % (b as bigint))),
  checked_pow: ([a, e], ctx) => {
    const result = (a as bigint) ** (e as bigint);
    return checked(ctx, result);
  },
  checked_neg: ([a], ctx) => checked(ctx, -(a as bigint)),
  checked_abs: ([a], ctx) => checked(ctx, (a as bigint) < 0n ? -(a as bigint) : (a as bigint)),
  wrapping_add: ([a, b], ctx) => wrap(intName(ctx), (a as bigint) + (b as bigint)),
  wrapping_sub: ([a, b], ctx) => wrap(intName(ctx), (a as bigint) - (b as bigint)),
  wrapping_mul: ([a, b], ctx) => wrap(intName(ctx), (a as bigint) * (b as bigint)),
  wrapping_div: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to divide by zero');
    return wrap(intName(ctx), (a as bigint) / (b as bigint));
  },
  wrapping_rem: ([a, b], ctx) => {
    if ((b as bigint) === 0n) panic(ctx, 'attempt to calculate the remainder with a divisor of zero');
    return wrap(intName(ctx), (a as bigint) % (b as bigint));
  },
  wrapping_neg: ([a], ctx) => wrap(intName(ctx), -(a as bigint)),
  wrapping_pow: ([a, e], ctx) => wrap(intName(ctx), (a as bigint) ** (e as bigint)),
  wrapping_abs: ([a], ctx) => wrap(intName(ctx), (a as bigint) < 0n ? -(a as bigint) : (a as bigint)),
  saturating_add: ([a, b], ctx) => saturate(intName(ctx), (a as bigint) + (b as bigint)),
  saturating_sub: ([a, b], ctx) => saturate(intName(ctx), (a as bigint) - (b as bigint)),
  saturating_mul: ([a, b], ctx) => saturate(intName(ctx), (a as bigint) * (b as bigint)),
  saturating_pow: ([a, e], ctx) => saturate(intName(ctx), (a as bigint) ** (e as bigint)),
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
    if ((a as bigint) <= 0n || (base as bigint) < 2n) panic(ctx, 'argument of integer logarithm must be positive');
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
    if (!inRange(intName(ctx), power)) overflow('+', ctx.span);
    return power;
  },
  from_str_radix: ([text, radix], ctx) => {
    const base = Number(radix as bigint);
    if (base < 2 || base > 36) panic(ctx, `from_str_radix_int: must lie in the range \`[2, 36]\` - found ${base}`);
    return parseInteger(ctx, deref(text) as string, intName(ctx), base);
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
  midpoint: ([a, b]) => {
    const sum = (a as bigint) + (b as bigint);
    return sum >= 0n ? sum / 2n : -((-sum + 1n) / 2n);
  },
};

const floating: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  sqrt: ([a], ctx) => round(ctx, Math.sqrt(float(a))),
  cbrt: ([a], ctx) => round(ctx, Math.cbrt(float(a))),
  powi: ([a, n], ctx) => round(ctx, powi(float(a), Number(n as bigint))),
  powf: ([a, n], ctx) => round(ctx, Math.pow(float(a), float(n))),
  abs: ([a], ctx) => round(ctx, Math.abs(float(a))),
  floor: ([a], ctx) => round(ctx, Math.floor(float(a))),
  ceil: ([a], ctx) => round(ctx, Math.ceil(float(a))),
  round: ([a], ctx) => {
    const value = float(a);
    return round(ctx, Math.sign(value) * Math.round(Math.abs(value)) || (Object.is(value, -0) || value < 0 ? -0 : 0));
  },
  round_ties_even: ([a], ctx) => {
    const value = float(a);
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff !== 0.5) return round(ctx, Math.round(value) === 0 && value < 0 ? -0 : Math.round(value));
    return round(ctx, floor % 2 === 0 ? floor : floor + 1);
  },
  trunc: ([a], ctx) => round(ctx, Math.trunc(float(a))),
  fract: ([a], ctx) => round(ctx, float(a) - Math.trunc(float(a))),
  sin: ([a], ctx) => round(ctx, Math.sin(float(a))),
  cos: ([a], ctx) => round(ctx, Math.cos(float(a))),
  tan: ([a], ctx) => round(ctx, Math.tan(float(a))),
  asin: ([a], ctx) => round(ctx, Math.asin(float(a))),
  acos: ([a], ctx) => round(ctx, Math.acos(float(a))),
  atan: ([a], ctx) => round(ctx, Math.atan(float(a))),
  atan2: ([a, b], ctx) => round(ctx, Math.atan2(float(a), float(b))),
  sinh: ([a], ctx) => round(ctx, Math.sinh(float(a))),
  cosh: ([a], ctx) => round(ctx, Math.cosh(float(a))),
  tanh: ([a], ctx) => round(ctx, Math.tanh(float(a))),
  exp: ([a], ctx) => round(ctx, Math.exp(float(a))),
  exp2: ([a], ctx) => round(ctx, 2 ** float(a)),
  ln: ([a], ctx) => round(ctx, Math.log(float(a))),
  log10: ([a], ctx) => round(ctx, Math.log10(float(a))),
  log2: ([a], ctx) => round(ctx, Math.log2(float(a))),
  log: ([a, base], ctx) => round(ctx, Math.log(float(a)) / Math.log(float(base))),
  hypot: ([a, b], ctx) => round(ctx, Math.hypot(float(a), float(b))),
  min: ([a, b], ctx) =>
    round(ctx, Number.isNaN(float(a)) ? float(b) : Number.isNaN(float(b)) ? float(a) : Math.min(float(a), float(b))),
  max: ([a, b], ctx) =>
    round(ctx, Number.isNaN(float(a)) ? float(b) : Number.isNaN(float(b)) ? float(a) : Math.max(float(a), float(b))),
  clamp: ([a, min, max], ctx) => {
    if (!(float(min) <= float(max)))
      panic(ctx, `min > max, or either was NaN. min = ${float(min)}, max = ${float(max)}`);
    return round(ctx, Math.min(Math.max(float(a), float(min)), float(max)));
  },
  is_nan: ([a]) => Number.isNaN(float(a)),
  is_infinite: ([a]) => !Number.isFinite(float(a)) && !Number.isNaN(float(a)),
  is_finite: ([a]) => Number.isFinite(float(a)),
  signum: ([a]) => {
    const value = float(a);
    if (Number.isNaN(value)) return Number.NaN;
    return value > 0 || Object.is(value, 0) ? 1 : -1;
  },
  is_sign_positive: ([a]) => float(a) > 0 || Object.is(float(a), 0),
  is_sign_negative: ([a]) => float(a) < 0 || Object.is(float(a), -0),
  to_degrees: ([a], ctx) => round(ctx, float(a) * (180 / Math.PI)),
  to_radians: ([a], ctx) => round(ctx, float(a) * (Math.PI / 180)),
  mul_add: ([a, b, c], ctx) => round(ctx, fma(float(a), float(b), float(c))),
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
    const q = Math.trunc(float(a) / float(b));
    if (float(a) % float(b) < 0) return round(ctx, float(b) > 0 ? q - 1 : q + 1);
    return round(ctx, q);
  },
  copysign: ([a, sign], ctx) => {
    const magnitude = Math.abs(float(a));
    const negative = float(sign) < 0 || Object.is(float(sign), -0);
    return round(ctx, negative ? -magnitude : magnitude);
  },
};

/** The integer that orders floats as `total_cmp` does: by their bits, with negative numbers' magnitude bits flipped. */
function totalOrderKey(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let bits = view.getBigInt64(0);
  bits ^= (bits >> 63n) & 0x7f_ff_ff_ff_ff_ff_ff_ffn;
  return bits;
}

/** `powi`, which multiplies repeatedly as LLVM's `powi` does, so that results match in the last bits. */
function powi(base: number, exponent: number): number {
  if (exponent === 0) return 1;
  let result = 1;
  let factor = base;
  let n = Math.abs(exponent);
  while (n > 0) {
    if (n & 1) result *= factor;
    factor *= factor;
    n >>= 1;
  }
  return exponent < 0 ? 1 / result : result;
}

/** A fused multiply-add, computed exactly with bigints and rounded once, as `f64::mul_add` does. */
function fma(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0 || b === 0) return a * b + c;
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
  if (mantissa === 0n) return a * b + c;
  return roundToDouble(mantissa, exponent);
}

/** A finite double as an integer mantissa and a power of two. */
function decompose(value: number): [bigint, number] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exponentBits = Number((bits >> 52n) & 0x7_ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (exponentBits === 0) return [sign * mantissa, -1074];
  mantissa |= 1n << 52n;
  return [sign * mantissa, exponentBits - 1075];
}

/** The double nearest to `mantissa × 2^exponent`, ties to even. */
function roundToDouble(mantissa: bigint, exponent: number): number {
  const negative = mantissa < 0n;
  let m = negative ? -mantissa : mantissa;
  let e = exponent;
  const length = m.toString(2).length;
  // Keep 53 significant bits, or fewer for subnormal results.
  let shift = length - 53;
  if (e + shift < -1074) shift = -1074 - e;
  if (shift > 0) {
    const half = 1n << BigInt(shift - 1);
    const remainder = m & ((1n << BigInt(shift)) - 1n);
    m >>= BigInt(shift);
    if (remainder > half || (remainder === half && (m & 1n) === 1n)) m++;
    e += shift;
  }
  const result = Number(m) * 2 ** e;
  return negative ? -result : result;
}

/** `T::try_from(value)` between integer types: the value when it fits, or `TryFromIntError`. */
function tryConvert(ctx: NativeContext, value: Value, to: Type): Value {
  const target = normalize(shallow(to)) as { name: IntName };
  const number = deref(value) as bigint;
  if (inRange(target.name, number)) return ok(ctx, number);
  return err(ctx, new StructValue(ctx.interp.program.adtDef('TryFromIntError'), []));
}

const natives: Record<string, (args: Value[], ctx: NativeContext) => Value> = {
  'TryFrom::try_from': ([value], ctx) => tryConvert(ctx, value, ctx.typeArgs[0]),
  'TryInto::try_into': ([value], ctx) => tryConvert(ctx, value, ctx.typeArgs[1]),
};
for (const [name, native] of Object.entries(integer)) natives[`Integer::${name}`] = native;
for (const [name, native] of Object.entries(floating)) natives[`Float::${name}`] = native;
define(natives);

/** Constants of the primitive types and `std::f64::consts`. */
const F64_CONSTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  TAU: 2 * Math.PI,
  SQRT_2: Math.SQRT2,
  LN_2: Math.LN2,
  LN_10: Math.LN10,
  FRAC_PI_2: Math.PI / 2,
  FRAC_PI_3: Math.PI / 3,
  FRAC_PI_4: Math.PI / 4,
  FRAC_PI_6: Math.PI / 6,
  FRAC_1_SQRT_2: Math.SQRT1_2,
  LOG2_E: Math.LOG2E,
  LOG10_E: Math.LOG10E,
};

const FLOAT_LIMITS: Record<string, { f64: number; f32: number }> = {
  MAX: { f64: Number.MAX_VALUE, f32: 3.4028234663852886e38 },
  MIN: { f64: -Number.MAX_VALUE, f32: -3.4028234663852886e38 },
  INFINITY: { f64: Number.POSITIVE_INFINITY, f32: Number.POSITIVE_INFINITY },
  NEG_INFINITY: { f64: Number.NEGATIVE_INFINITY, f32: Number.NEGATIVE_INFINITY },
  NAN: { f64: Number.NaN, f32: Number.NaN },
  EPSILON: { f64: Number.EPSILON, f32: 1.1920928955078125e-7 },
  MIN_POSITIVE: { f64: 2.2250738585072014e-308, f32: 1.1754943508222875e-38 },
};

const consts: Record<string, (args: Value[], ctx: NativeContext) => Value> = {};
for (const [name, value] of Object.entries(F64_CONSTS)) {
  consts[`const:${name}`] = (_args, ctx) => (isF32Type(ctx.typeArgs[0]) ? Math.fround(value) : value);
}
for (const [name, value] of Object.entries(FLOAT_LIMITS)) {
  consts[`const:${name}`] = (_args, ctx) => (isF32Type(ctx.typeArgs[0]) ? value.f32 : value.f64);
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
