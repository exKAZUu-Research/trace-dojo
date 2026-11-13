/**
 * Go's constants have arbitrary precision: integers are exact, and floating-point constants are exact fractions here,
 * which Go's compiler approximates with at least 256 bits of mantissa.
 */
export type Constant =
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: Rational }
  | { kind: 'complex'; re: Rational; im: Rational };

export interface Rational {
  num: bigint;
  /** Always positive, with no factor common to `num`; 1 when `exp` is set. */
  den: bigint;
  /** Binary exponent for 512-bit floating-point constants once fraction components reach 4096 bits, as in `go/constant`. */
  exp?: number;
}

/** Go's compiler rejects untyped integer constants beyond 512 bits. */
const MAX_CONSTANT_BITS = 512n;
const MAX_RAT_BITS = 4096n;
const FLOAT_PREC = 512;
const MAX_FLOAT_EXP = 1_000_000_000;

export class ConstantOverflow extends Error {}
export class ConstantDivisionByZero extends Error {}

export function rational(num: bigint, den = 1n): Rational {
  if (den === 0n) throw new ConstantDivisionByZero();
  if (num === 0n) return ZERO;
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (bitLength(n) >= MAX_RAT_BITS || bitLength(d) >= MAX_RAT_BITS) {
    return approxFraction(n, d, 0);
  }
  const divisor = gcd(n < 0n ? -n : n, d);
  return divisor > 1n ? { num: n / divisor, den: d / divisor } : { num: n, den: d };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

const ZERO: Rational = { num: 0n, den: 1n };

/** Rounds `(num / den) * 2 ** expOffset` to a 512-bit binary mantissa, halves to even. */
function approxFraction(num: bigint, den: bigint, expOffset: number): Rational {
  if (den === 0n) throw new ConstantDivisionByZero();
  if (num === 0n) return ZERO;
  const negative = num < 0n !== den < 0n;
  const magN = num < 0n ? -num : num;
  const magD = den < 0n ? -den : den;
  const shift = magD.toString(2).length - magN.toString(2).length + FLOAT_PREC + 2;
  const numerator = shift > 0 ? magN << BigInt(shift) : magN;
  const denominator = shift < 0 ? magD << BigInt(-shift) : magD;
  const quotient = numerator / denominator;
  const sticky = numerator % denominator === 0n ? 0n : 1n;
  const drop = quotient.toString(2).length - FLOAT_PREC;
  const totalDrop = BigInt(drop + 1);
  const raw = (quotient << 1n) | sticky;
  const half = 1n << (totalDrop - 1n);
  const remainder = raw & ((1n << totalDrop) - 1n);
  let mantissa = raw >> totalDrop;
  if (remainder > half || (remainder === half && (mantissa & 1n) === 1n)) mantissa += 1n;
  let exp = expOffset - shift + drop;
  if (mantissa >= 1n << BigInt(FLOAT_PREC)) {
    mantissa >>= 1n;
    exp += 1;
  }
  if (Math.abs(exp) > MAX_FLOAT_EXP) throw new ConstantOverflow();
  return { num: negative ? -mantissa : mantissa, den: 1n, exp };
}

function toFloat512(value: Rational): Rational & { exp: number } {
  if (value.exp !== undefined) return value as Rational & { exp: number };
  if (value.num === 0n) return { num: 0n, den: 1n, exp: 0 };
  return approxFraction(value.num, value.den, 0) as Rational & { exp: number };
}

export function intConstant(value: bigint): Constant {
  if (bitLength(value) > MAX_CONSTANT_BITS) throw new ConstantOverflow();
  return { kind: 'int', value };
}

function bitLength(value: bigint): bigint {
  if (value === 0n) return 0n;
  return BigInt((value < 0n ? -value : value).toString(2).length);
}

/** Reads a decimal float literal such as `1.5e-3` or `.5` exactly, switching to 512-bit float for large exponents. */
export function parseFloatLiteral(text: string): Rational {
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new Error(`Invalid float literal ${text}`);
  const [, whole = '', fraction = '', exponentText = '0'] = match;
  const digitsText = `${whole}${fraction}`.replace(/^0+/, '');
  if (digitsText.length === 0) return ZERO;
  const exponent = Number(exponentText) - fraction.length;
  if (exponent < -310_000_000) return ZERO;
  if (exponent > 310_000_000) throw new ConstantOverflow();
  const digits = BigInt(digitsText);
  if (Math.abs(exponent) <= 1200 && digitsText.length <= 1200) {
    return exponent >= 0 ? rational(digits * 10n ** BigInt(exponent)) : rational(digits, 10n ** BigInt(-exponent));
  }
  const base = approxFraction(digits, 1n, 0);
  const scale = pow10Float(Math.abs(exponent));
  return exponent >= 0 ? mul(base, scale) : div(base, scale);
}

function pow10Float(power: number): Rational {
  let result: Rational = { num: 1n, den: 1n };
  let base: Rational = approxFraction(10n, 1n, 0);
  let remaining = power;
  while (remaining > 0) {
    if ((remaining & 1) === 1) result = mul(result, base);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) base = mul(base, base);
  }
  return result;
}

export function toRational(constant: Constant): Rational {
  if (constant.kind === 'int') return { num: constant.value, den: 1n };
  if (constant.kind === 'float') return constant.value;
  if (constant.kind === 'complex') return constant.re;
  throw new Error('Not a number');
}

/** Widens a numeric constant to the given numeric kind, for an operation between kinds. */
function widen(constant: Constant, kind: 'int' | 'float' | 'complex'): Constant {
  if (constant.kind === kind) return constant;
  if (kind === 'float') return { kind: 'float', value: toRational(constant) };
  if (kind === 'complex')
    return { kind: 'complex', re: toRational(constant), im: constant.kind === 'complex' ? constant.im : ZERO };
  return constant;
}

const RANK = { int: 0, float: 1, complex: 2 } as const;

function commonKind(a: Constant, b: Constant): 'int' | 'float' | 'complex' {
  const ka = a.kind as keyof typeof RANK;
  const kb = b.kind as keyof typeof RANK;
  return RANK[ka] >= RANK[kb] ? ka : kb;
}

function negateRational(value: Rational): Rational {
  if (value.num === 0n) return ZERO;
  return value.exp === undefined ? { num: -value.num, den: value.den } : { num: -value.num, den: 1n, exp: value.exp };
}

function add(a: Rational, b: Rational): Rational {
  if (a.num === 0n) return b;
  if (b.num === 0n) return a;
  if (a.exp === undefined && b.exp === undefined) {
    return rational(a.num * b.den + b.num * a.den, a.den * b.den);
  }
  let fa = toFloat512(a);
  let fb = toFloat512(b);
  if (fa.exp < fb.exp) [fa, fb] = [fb, fa];
  const diff = fa.exp - fb.exp;
  if (diff > FLOAT_PREC + 8) {
    const sticky = fb.num > 0n ? 1n : -1n;
    return approxFraction((fa.num << 2n) + sticky, 1n, fa.exp - 2);
  }
  return approxFraction((fa.num << BigInt(diff)) + fb.num, 1n, fb.exp);
}

function sub(a: Rational, b: Rational): Rational {
  return add(a, negateRational(b));
}

function mul(a: Rational, b: Rational): Rational {
  if (a.num === 0n || b.num === 0n) return ZERO;
  if (a.exp === undefined && b.exp === undefined) {
    return rational(a.num * b.num, a.den * b.den);
  }
  const fa = toFloat512(a);
  const fb = toFloat512(b);
  return approxFraction(fa.num * fb.num, 1n, fa.exp + fb.exp);
}

function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new ConstantDivisionByZero();
  if (a.num === 0n) return ZERO;
  if (a.exp === undefined && b.exp === undefined) {
    return rational(a.num * b.den, a.den * b.num);
  }
  const fa = toFloat512(a);
  const fb = toFloat512(b);
  return approxFraction(fa.num, fb.num, fa.exp - fb.exp);
}

export function compareRational(a: Rational, b: Rational): number {
  if (a.exp === undefined && b.exp === undefined) {
    const difference = a.num * b.den - b.num * a.den;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  const difference = sub(a, b);
  return difference.num < 0n ? -1 : difference.num > 0n ? 1 : 0;
}

/**
 * Applies a binary operator to two constants of compatible kinds.
 *
 * @param integerDivision Whether `/` truncates, as it does when the operands are integers.
 */
// code-gauge-allow functionCognitiveComplexity 40 -- One case per operator and kind of constant.
export function binaryConstant(operator: string, a: Constant, b: Constant, integerDivision: boolean): Constant {
  if (a.kind === 'bool' && b.kind === 'bool') {
    switch (operator) {
      case '&&': {
        return { kind: 'bool', value: a.value && b.value };
      }
      case '||': {
        return { kind: 'bool', value: a.value || b.value };
      }
      case '==': {
        return { kind: 'bool', value: a.value === b.value };
      }
      case '!=': {
        return { kind: 'bool', value: a.value !== b.value };
      }
    }
    throw new Error(`Invalid boolean operator ${operator}`);
  }
  if (a.kind === 'string' && b.kind === 'string') {
    if (operator === '+') return { kind: 'string', value: a.value + b.value };
    return { kind: 'bool', value: compareOperator(operator, a.value < b.value ? -1 : a.value > b.value ? 1 : 0) };
  }
  const kind = commonKind(a, b);
  const left = widen(a, kind);
  const right = widen(b, kind);
  if (left.kind === 'int' && right.kind === 'int') {
    const x = left.value;
    const y = right.value;
    switch (operator) {
      case '+': {
        return intConstant(x + y);
      }
      case '-': {
        return intConstant(x - y);
      }
      case '*': {
        return intConstant(x * y);
      }
      case '/': {
        if (y === 0n) throw new ConstantDivisionByZero();
        return integerDivision ? intConstant(x / y) : floatConstant(rational(x, y));
      }
      case '%': {
        if (y === 0n) throw new ConstantDivisionByZero();
        return intConstant(x % y);
      }
      case '&': {
        return intConstant(x & y);
      }
      case '|': {
        return intConstant(x | y);
      }
      case '^': {
        return intConstant(x ^ y);
      }
      case '&^': {
        return intConstant(x & ~y);
      }
      default: {
        return { kind: 'bool', value: compareOperator(operator, x < y ? -1 : x > y ? 1 : 0) };
      }
    }
  }
  if (left.kind === 'float' && right.kind === 'float') {
    const x = left.value;
    const y = right.value;
    switch (operator) {
      case '+': {
        return floatConstant(add(x, y));
      }
      case '-': {
        return floatConstant(sub(x, y));
      }
      case '*': {
        return floatConstant(mul(x, y));
      }
      case '/': {
        return floatConstant(div(x, y));
      }
      default: {
        return { kind: 'bool', value: compareOperator(operator, compareRational(x, y)) };
      }
    }
  }
  if (left.kind === 'complex' && right.kind === 'complex') {
    const { re: ar, im: ai } = left;
    const { re: br, im: bi } = right;
    switch (operator) {
      case '+': {
        return { kind: 'complex', re: add(ar, br), im: add(ai, bi) };
      }
      case '-': {
        return { kind: 'complex', re: sub(ar, br), im: sub(ai, bi) };
      }
      case '*': {
        return { kind: 'complex', re: sub(mul(ar, br), mul(ai, bi)), im: add(mul(ar, bi), mul(ai, br)) };
      }
      case '/': {
        const denominator = add(mul(br, br), mul(bi, bi));
        return {
          kind: 'complex',
          re: div(add(mul(ar, br), mul(ai, bi)), denominator),
          im: div(sub(mul(ai, br), mul(ar, bi)), denominator),
        };
      }
      case '==': {
        return { kind: 'bool', value: compareRational(ar, br) === 0 && compareRational(ai, bi) === 0 };
      }
      case '!=': {
        return { kind: 'bool', value: compareRational(ar, br) !== 0 || compareRational(ai, bi) !== 0 };
      }
    }
  }
  throw new Error(`Invalid constant operation ${operator}`);
}

function floatConstant(value: Rational): Constant {
  return { kind: 'float', value };
}

function compareOperator(operator: string, comparison: number): boolean {
  switch (operator) {
    case '==': {
      return comparison === 0;
    }
    case '!=': {
      return comparison !== 0;
    }
    case '<': {
      return comparison < 0;
    }
    case '<=': {
      return comparison <= 0;
    }
    case '>': {
      return comparison > 0;
    }
    case '>=': {
      return comparison >= 0;
    }
  }
  throw new Error(`Invalid comparison ${operator}`);
}

export function shiftConstant(operator: '<<' | '>>', value: bigint, count: bigint): Constant {
  if (operator === '>>') return intConstant(value >> count);
  if (count > MAX_CONSTANT_BITS) throw new ConstantOverflow();
  return intConstant(value << count);
}

export function unaryConstant(operator: string, constant: Constant, unsignedBits?: number): Constant {
  switch (operator) {
    case '+': {
      return constant;
    }
    case '-': {
      if (constant.kind === 'int') return intConstant(-constant.value);
      if (constant.kind === 'float') return { kind: 'float', value: negateRational(constant.value) };
      if (constant.kind === 'complex') {
        return {
          kind: 'complex',
          re: negateRational(constant.re),
          im: negateRational(constant.im),
        };
      }
      break;
    }
    case '!': {
      if (constant.kind === 'bool') return { kind: 'bool', value: !constant.value };
      break;
    }
    case '^': {
      if (constant.kind === 'int') {
        // For unsigned types, ^x flips only the type's bits.
        if (unsignedBits !== undefined) return intConstant(constant.value ^ ((1n << BigInt(unsignedBits)) - 1n));
        return intConstant(~constant.value);
      }
      break;
    }
  }
  throw new Error(`Invalid unary operator ${operator}`);
}

/** The integer a constant holds exactly, or undefined when it has a fraction or an imaginary part. */
export function exactInteger(constant: Constant): bigint | undefined {
  if (constant.kind === 'int') return constant.value;
  if (constant.kind === 'float') return rationalInteger(constant.value);
  if (constant.kind === 'complex') return constant.im.num === 0n ? rationalInteger(constant.re) : undefined;
  return undefined;
}

function rationalInteger(value: Rational): bigint | undefined {
  if (value.exp === undefined) return value.den === 1n ? value.num : undefined;
  if (value.num === 0n) return 0n;
  if (value.exp >= 0) {
    if (BigInt(value.exp) + bitLength(value.num) > MAX_CONSTANT_BITS) return undefined;
    return value.num << BigInt(value.exp);
  }
  const shift = BigInt(-value.exp);
  if (shift >= bitLength(value.num)) return undefined;
  const mask = (1n << shift) - 1n;
  return (value.num & mask) === 0n ? value.num >> shift : undefined;
}

/** Rounds an exact fraction to the nearest double, or float32 when `single`, halves to even. */
export function rationalToFloat({ num, den, exp }: Rational, single = false): number {
  if (num === 0n) return 0;
  if (exp !== undefined) return num < 0n ? -scaleToFloat(-num, exp, single) : scaleToFloat(num, exp, single);
  const negative = num < 0n;
  const magnitude = negative ? -num : num;
  // Scales the quotient to at least 66 significant bits, then rounds once with a sticky bit.
  const shift = den.toString(2).length - magnitude.toString(2).length + 66;
  const numerator = shift > 0 ? magnitude << BigInt(shift) : magnitude;
  const denominator = shift < 0 ? den << BigInt(-shift) : den;
  let quotient = numerator / denominator;
  if (numerator % denominator !== 0n) quotient |= 1n;
  const result = scaleToFloat(quotient, -shift, single);
  return negative ? -result : result;
}

const MAX_FLOAT32 = 3.4028234663852886e38;

/**
 * Computes `mantissa * 2 ** exponent` rounded once to the nearest double, or float32 when `single`, halves to even,
 * handling subnormals.
 */
export function scaleToFloat(mantissa: bigint, exponent: number, single = false): number {
  if (mantissa === 0n) return 0;
  const bits = mantissa.toString(2).length;
  if (bits + exponent > 1025) return Infinity;
  if (bits + exponent < -1075) return 0;
  if (single) {
    const result = scaleToFloat(roundToBits(mantissa, exponent, 24, -149), Math.max(bits + exponent - 24, -149));
    return result > MAX_FLOAT32 ? Infinity : result;
  }
  const lowestBit = Math.max(bits + exponent - 53, -1074);
  const drop = lowestBit - exponent;
  let value = mantissa;
  if (drop > 0) {
    const bigDrop = BigInt(drop);
    const half = 1n << (bigDrop - 1n);
    const remainder = value & ((1n << bigDrop) - 1n);
    value >>= bigDrop;
    if (remainder > half || (remainder === half && (value & 1n) === 1n)) value += 1n;
    if (lowestBit > 971) return value === 0n ? 0 : Infinity;
    return Number(value) * 2 ** lowestBit;
  }
  return Number(value) * 2 ** exponent;
}

/** The integer `mantissa * 2 ** exponent` scaled to keep `precision` bits above `minimumBit`, rounded half to even. */
function roundToBits(mantissa: bigint, exponent: number, precision: number, minimumBit: number): bigint {
  const lowestBit = Math.max(mantissa.toString(2).length + exponent - precision, minimumBit);
  const drop = lowestBit - exponent;
  if (drop <= 0) return mantissa << BigInt(-drop);
  const bigDrop = BigInt(drop);
  const half = 1n << (bigDrop - 1n);
  const remainder = mantissa & ((1n << bigDrop) - 1n);
  const value = mantissa >> bigDrop;
  return remainder > half || (remainder === half && (value & 1n) === 1n) ? value + 1n : value;
}

/** The exact fraction a finite double holds. */
export function floatToRational(value: number): Rational {
  if (value === 0) return ZERO;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (biased !== 0) mantissa |= 1n << 52n;
  const exponent = biased === 0 ? -1074 : biased - 1075;
  const signed = value < 0 ? -mantissa : mantissa;
  return exponent >= 0 ? rational(signed << BigInt(exponent)) : rational(signed, 1n << BigInt(-exponent));
}
