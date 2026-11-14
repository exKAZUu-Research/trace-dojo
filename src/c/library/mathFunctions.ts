import type { Scalar } from '../arith';
import { CRuntimeError } from '../errors';
import { constantOperand, type SpecialCall } from '../expressionCompiler';
import type { NativeFunction, Runtime } from '../runtime';
import { INT } from '../types';
import { appleFloatPower } from './appleFloatPower';
import { exactParts, fma, roundBinary, roundSquareRoot } from './binaryFloat';
import { precisePower } from './precisePower';
import { asAddress, asNumber, writeBytes } from './support';

/** Rounds half away from zero, as C's `round` does. */
function roundHalfAway(x: number): number {
  if (!Number.isFinite(x)) return x;
  const truncated = Math.trunc(x);
  const rounded = Math.abs(x - truncated) >= 0.5 ? truncated + Math.sign(x) : truncated;
  return rounded === 0 ? (x < 0 || Object.is(x, -0) ? -0 : 0) : rounded;
}

/** Rounds half to even, as `rint` does in the default rounding mode. */
function roundHalfEven(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 2 ** 52) return x;
  const floor = Math.floor(x);
  const difference = x - floor;
  let rounded: number;
  if (difference > 0.5) rounded = floor + 1;
  else if (difference < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded === 0 ? (x < 0 || Object.is(x, -0) ? -0 : 0) : rounded;
}

function exp2(x: number): number {
  return pow(2, x);
}

const UNARY: Record<string, (x: number) => number> = {
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  cos: Math.cos,
  sin: Math.sin,
  tan: Math.tan,
  acosh: Math.acosh,
  asinh: Math.asinh,
  atanh: Math.atanh,
  cosh: Math.cosh,
  sinh: Math.sinh,
  tanh: Math.tanh,
  exp: Math.exp,
  exp2,
  expm1: Math.expm1,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  log1p: Math.log1p,
  logb: (x) => (x === 0 ? Number.NEGATIVE_INFINITY : Number.isFinite(x) ? frexp(x).exponent - 1 : Math.abs(x)),
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  fabs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: roundHalfAway,
  trunc: Math.trunc,
  rint: roundHalfEven,
  nearbyint: roundHalfEven,
};

// code-gauge-allow functionCognitiveComplexity 18 -- C special values, exact powers, and fractional modes require distinct rounding paths.
function pow(x: number, y: number): number {
  if (x === 1 || y === 0 || (x === -1 && !Number.isFinite(y) && !Number.isNaN(y))) return 1;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0) return x ** y;
  const n = Math.abs(y);
  if (!Number.isInteger(y * 2)) return x ** y;
  if (n > 1024) return precisePower(x, y);
  if (x < 0 && !Number.isInteger(y)) return Number.NaN;
  const { mantissa, exponent } = exactParts(Math.abs(x));
  const half = !Number.isInteger(y);
  const power = mantissa ** BigInt(half ? n * 2 : n);
  const binaryExponent = exponent * (half ? n * 2 : n);
  const rounded = half
    ? y > 0
      ? roundSquareRoot(power, 1n, binaryExponent)
      : roundSquareRoot(1n, power, -binaryExponent)
    : y > 0
      ? roundBinary(power, 1n, binaryExponent)
      : roundBinary(1n, power, -binaryExponent);
  return x < 0 && n % 2 === 1 ? -rounded : rounded;
}

function remainderParts(x: number, y: number): { value: number; quotient: number } {
  if (y === 0 || !Number.isFinite(x) || Number.isNaN(y)) return { value: Number.NaN, quotient: 0 };
  if (!Number.isFinite(y)) return { value: x, quotient: 0 };
  const a = exactParts(Math.abs(x));
  const b = exactParts(Math.abs(y));
  const exponent = Math.min(a.exponent, b.exponent);
  const numerator = a.mantissa << BigInt(a.exponent - exponent);
  const denominator = b.mantissa << BigInt(b.exponent - exponent);
  let quotient = numerator / denominator;
  let residual = numerator % denominator;
  const twice = residual * 2n;
  if (twice > denominator || (twice === denominator && (quotient & 1n) === 1n)) {
    quotient++;
    residual -= denominator;
  }
  const sign = x < 0 || Object.is(x, -0) ? -1 : 1;
  const magnitude = residual < 0n ? -residual : residual;
  const value = sign * (residual < 0n ? -1 : 1) * roundBinary(magnitude, 1n, exponent);
  return { value, quotient: sign * (y < 0 ? -1 : 1) * Number(quotient & 0x7fn) };
}

function modf(isFloat: boolean): NativeFunction {
  return (runtime, [x, integer]) => {
    const value = x as number;
    const whole = Number.isFinite(value) ? Math.trunc(value) : value;
    storeDouble(runtime, asAddress(integer), whole, isFloat);
    if (Number.isNaN(value)) return value;
    const fraction = Number.isFinite(value) ? value - whole : 0;
    return fraction || (value < 0 || Object.is(value, -0) ? -0 : 0);
  };
}

function nextAfter(x: number, y: number, isFloat = false): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  if (x === y) return y;
  if (x === 0) return (y > 0 ? 1 : -1) * (isFloat ? 2 ** -149 : Number.MIN_VALUE);
  if (isFloat) {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, x);
    view.setUint32(0, view.getUint32(0) + (y > x === x > 0 ? 1 : -1));
    return view.getFloat32(0);
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  let bits = view.getBigInt64(0);
  bits += y > x === x > 0 ? 1n : -1n;
  view.setBigInt64(0, bits);
  return view.getFloat64(0);
}

const BINARY: Record<string, (x: number, y: number) => number> = {
  atan2: Math.atan2,
  pow,
  fmod: (x, y) => x % y,
  remainder: (x, y) => remainderParts(x, y).value,
  hypot: Math.hypot,
  fmin: (x, y) => (Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.min(x, y)),
  fmax: (x, y) => (Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.max(x, y)),
  fdim: (x, y) => (x > y ? x - y : Number.isNaN(x) || Number.isNaN(y) ? Number.NaN : 0),
  copysign: (x, y) => (Math.sign(y) < 0 || Object.is(y, -0) ? -Math.abs(x) : Math.abs(x)),
  nextafter: nextAfter,
};

function storeInt(runtime: Runtime, address: number, value: number): void {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  writeBytes(runtime, address, bytes);
}

function storeDouble(runtime: Runtime, address: number, value: number, isFloat: boolean): void {
  const bytes = new Uint8Array(isFloat ? 4 : 8);
  const view = new DataView(bytes.buffer);
  if (isFloat) view.setFloat32(0, value, true);
  else view.setFloat64(0, value, true);
  writeBytes(runtime, address, bytes);
}

function frexp(x: number): { mantissa: number; exponent: number } {
  if (x === 0 || !Number.isFinite(x)) return { mantissa: x, exponent: 0 };
  const parts = exactParts(Math.abs(x));
  const bits = parts.mantissa.toString(2).length;
  return {
    mantissa: Math.sign(x) * Number(parts.mantissa) * 2 ** -bits,
    exponent: parts.exponent + bits,
  };
}

function ldexp(x: number, exponent: number, isFloat = false): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const parts = exactParts(Math.abs(x));
  return Math.sign(x) * roundBinary(parts.mantissa, 1n, parts.exponent + exponent, isFloat);
}

function toLong(value: number): bigint {
  if (!Number.isFinite(value) || Math.abs(value) >= 2 ** 63) throw new CRuntimeError('floatToInt');
  return BigInt(value);
}

function fpClassify(x: number, isFloat = false): number {
  if (Number.isNaN(x)) return 1;
  if (!Number.isFinite(x)) return 2;
  if (x === 0) return 3;
  return Math.abs(x) < (isFloat ? 2 ** -126 : 2 ** -1022) ? 5 : 4;
}

export const classificationCall: SpecialCall = (compiler, call, fn) => {
  if (call.args.length !== 1) compiler.error(call.row, '浮動小数点数の分類には引数を1つ書いてください。');
  const operand = compiler.rvalue(call.args[0]);
  const isFloat = operand.type.kind === 'float' && operand.type.name === 'float';
  return {
    type: INT,
    isCall: true,
    value: (frame) => {
      frame.runtime.spend();
      const classification = fpClassify(Number(operand.value(frame)), isFloat);
      return fn.name === '__builtin_isnormal' ? (classification === 4 ? 1 : 0) : classification;
    },
  };
};

const BUILTIN_CONSTANTS: Record<string, number> = {
  __builtin_huge_val: Number.POSITIVE_INFINITY,
  __builtin_huge_valf: Number.POSITIVE_INFINITY,
  __builtin_inff: Number.POSITIVE_INFINITY,
  __builtin_nanf: Number.NaN,
};
export const constantCall: SpecialCall = (compiler, call, fn) => {
  compiler.arguments(fn.type, call.args, call.row, fn.name);
  if (
    call.args.some((argument) => {
      const operand = compiler.rvalue(argument);
      return operand.constant === undefined && !operand.isAddressConstant;
    })
  )
    return;
  return { ...constantOperand(fn.type.ret, BUILTIN_CONSTANTS[fn.name]), isCall: true };
};

export const MATH_FUNCTIONS: Record<string, NativeFunction> = {
  fma: (_runtime, [x, y, z]) => fma(x as number, y as number, z as number),
  fmaf: (_runtime, [x, y, z]) => fma(x as number, y as number, z as number, true),
  lround: (_runtime, [x]) => toLong(roundHalfAway(x as number)),
  lroundf: (_runtime, [x]) => toLong(roundHalfAway(x as number)),
  llround: (_runtime, [x]) => toLong(roundHalfAway(x as number)),
  llroundf: (_runtime, [x]) => toLong(roundHalfAway(x as number)),
  lrint: (_runtime, [x]) => toLong(roundHalfEven(x as number)),
  llrint: (_runtime, [x]) => toLong(roundHalfEven(x as number)),
  modf: modf(false),
  modff: modf(true),
  frexp: (runtime, [x, exponent]) => {
    const result = frexp(x as number);
    storeInt(runtime, asAddress(exponent), result.exponent);
    return result.mantissa;
  },
  frexpf: (runtime, [x, exponent]) => {
    const result = frexp(x as number);
    storeInt(runtime, asAddress(exponent), result.exponent);
    return Math.fround(result.mantissa);
  },
  ldexp: (_runtime, [x, exponent]) => ldexp(x as number, asNumber(exponent)),
  ldexpf: (_runtime, [x, exponent]) => ldexp(x as number, asNumber(exponent), true),
  scalbn: (_runtime, [x, exponent]) => ldexp(x as number, asNumber(exponent)),
  ilogb: (_runtime, [x]) => {
    const value = x as number;
    if (value === 0) return -2_147_483_648;
    if (Number.isNaN(value)) return -2_147_483_648;
    if (!Number.isFinite(value)) return 2_147_483_647;
    return frexp(value).exponent - 1;
  },
  nan: () => Number.NaN,
  nanf: () => Number.NaN,
  remquo: (runtime, [x, y, quotient]) => {
    const result = remainderParts(x as number, y as number);
    storeInt(runtime, asAddress(quotient), result.quotient);
    return result.value;
  },
  __builtin_huge_val: () => Number.POSITIVE_INFINITY,
  __builtin_huge_valf: () => Number.POSITIVE_INFINITY,
  __builtin_inff: () => Number.POSITIVE_INFINITY,
  __builtin_nanf: () => Number.NaN,
  __builtin_isnan: (_runtime, [x]) => (Number.isNaN(Number(x as Scalar)) ? 1 : 0),
  __builtin_isinf: (_runtime, [x]) => {
    const value = Number(x as Scalar);
    return Number.isFinite(value) || Number.isNaN(value) ? 0 : 1;
  },
  __builtin_isfinite: (_runtime, [x]) => (Number.isFinite(Number(x as Scalar)) ? 1 : 0),
  __builtin_isnormal: (_runtime, [x]) => (fpClassify(Number(x as Scalar)) === 4 ? 1 : 0),
  __builtin_signbit: (_runtime, [x]) => {
    const value = Number(x as Scalar);
    return value < 0 || Object.is(value, -0) ? 1 : 0;
  },
  __builtin_fpclassify: (_runtime, [x]) => fpClassify(Number(x as Scalar)),
  __builtin_isgreater: (_runtime, [x, y]) => (Number(x as Scalar) > Number(y as Scalar) ? 1 : 0),
  __builtin_isgreaterequal: (_runtime, [x, y]) => (Number(x as Scalar) >= Number(y as Scalar) ? 1 : 0),
  __builtin_isless: (_runtime, [x, y]) => (Number(x as Scalar) < Number(y as Scalar) ? 1 : 0),
  __builtin_islessequal: (_runtime, [x, y]) => (Number(x as Scalar) <= Number(y as Scalar) ? 1 : 0),
  __builtin_islessgreater: (_runtime, [x, y]) => {
    const a = Number(x as Scalar);
    const b = Number(y as Scalar);
    // oxlint-disable-next-line oxc/double-comparisons -- a != b would be true for NaNs, which compare unordered.
    return a < b || a > b ? 1 : 0;
  },
  __builtin_isunordered: (_runtime, [x, y]) =>
    Number.isNaN(Number(x as Scalar)) || Number.isNaN(Number(y as Scalar)) ? 1 : 0,
};

for (const [name, fn] of Object.entries(UNARY)) {
  MATH_FUNCTIONS[name] = (_runtime, [x]) => fn(x as number);
  MATH_FUNCTIONS[`${name}l`] = MATH_FUNCTIONS[name];
  MATH_FUNCTIONS[`${name}f`] = (_runtime, [x]) => Math.fround(fn(x as number));
}
for (const [name, fn] of Object.entries(BINARY)) {
  MATH_FUNCTIONS[name] = (_runtime, [x, y]) => fn(x as number, y as number);
  MATH_FUNCTIONS[`${name}l`] = MATH_FUNCTIONS[name];
  MATH_FUNCTIONS[`${name}f`] = (_runtime, [x, y]) => Math.fround(fn(x as number, y as number));
}

for (const name of [
  'fma',
  'modf',
  'frexp',
  'ldexp',
  'scalbn',
  'ilogb',
  'nan',
  'remquo',
  'lround',
  'llround',
  'lrint',
  'llrint',
]) {
  MATH_FUNCTIONS[`${name}l`] = MATH_FUNCTIONS[name];
}
for (const name of ['ilogb', 'lrint', 'llrint']) MATH_FUNCTIONS[`${name}f`] = MATH_FUNCTIONS[name];
MATH_FUNCTIONS.scalbnf = MATH_FUNCTIONS.ldexpf;
MATH_FUNCTIONS.scalbln = MATH_FUNCTIONS.ldexp;
MATH_FUNCTIONS.scalblnf = MATH_FUNCTIONS.ldexpf;
MATH_FUNCTIONS.scalblnl = MATH_FUNCTIONS.ldexp;
MATH_FUNCTIONS.remquof = (runtime, args, types, row) =>
  Math.fround(MATH_FUNCTIONS.remquo(runtime, args, types, row) as number);

MATH_FUNCTIONS.nextafterf = (_runtime, [x, y]) => nextAfter(x as number, y as number, true);
MATH_FUNCTIONS.nexttoward = MATH_FUNCTIONS.nextafter;
MATH_FUNCTIONS.nexttowardf = MATH_FUNCTIONS.nextafterf;
MATH_FUNCTIONS.nexttowardl = MATH_FUNCTIONS.nextafterl;

export const CTYPE_FUNCTIONS: Record<string, NativeFunction> = {};
const CLASSES: Record<string, (c: number) => boolean> = {
  isalnum: (c) => /[\dA-Za-z]/.test(String.fromCodePoint(c)),
  isalpha: (c) => /[A-Za-z]/.test(String.fromCodePoint(c)),
  isblank: (c) => c === 0x20 || c === 0x09,
  iscntrl: (c) => c < 0x20 || c === 0x7f,
  isdigit: (c) => c >= 0x30 && c <= 0x39,
  isgraph: (c) => c > 0x20 && c < 0x7f,
  islower: (c) => c >= 0x61 && c <= 0x7a,
  isprint: (c) => c >= 0x20 && c < 0x7f,
  ispunct: (c) => c > 0x20 && c < 0x7f && !/[\dA-Za-z]/.test(String.fromCodePoint(c)),
  isspace: (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d),
  isupper: (c) => c >= 0x41 && c <= 0x5a,
  isxdigit: (c) => /[\dA-Fa-f]/.test(String.fromCodePoint(c)),
};
for (const [name, test] of Object.entries(CLASSES)) {
  // macOS's tables classify only ASCII in the C locale; other values, such as negative chars, are no class.
  CTYPE_FUNCTIONS[name] = (_runtime, [c]) => {
    const value = asNumber(c);
    return value >= 0 && value < 0x80 && test(value) ? 1 : 0;
  };
}
CTYPE_FUNCTIONS.tolower = (_runtime, [c]) => {
  const value = asNumber(c);
  return value >= 0x41 && value <= 0x5a ? value + 32 : value;
};
CTYPE_FUNCTIONS.toupper = (_runtime, [c]) => {
  const value = asNumber(c);
  return value >= 0x61 && value <= 0x7a ? value - 32 : value;
};

MATH_FUNCTIONS.powf = (_runtime, [x, y]) => appleFloatPower(x as number, y as number);
