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
  /** Always positive, with no factor common to `num`. */
  den: bigint;
}

/** Go's compiler rejects untyped integer constants beyond 512 bits. */
const MAX_CONSTANT_BITS = 512n;

export class ConstantOverflow extends Error {}
export class ConstantDivisionByZero extends Error {}

export function rational(num: bigint, den = 1n): Rational {
  if (den === 0n) throw new ConstantDivisionByZero();
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
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

export function intConstant(value: bigint): Constant {
  if (bitLength(value) > MAX_CONSTANT_BITS) throw new ConstantOverflow();
  return { kind: 'int', value };
}

function bitLength(value: bigint): bigint {
  return BigInt((value < 0n ? -value : value).toString(2).length);
}

/** Reads a decimal float literal such as `1.5e-3` or `.5` exactly. */
export function parseFloatLiteral(text: string): Rational {
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new Error(`Invalid float literal ${text}`);
  const [, whole = '', fraction = '', exponentText = '0'] = match;
  const digits = BigInt(`${whole}${fraction}` || '0');
  const exponent = Number(exponentText) - fraction.length;
  if (Math.abs(exponent) > 100_000) throw new ConstantOverflow();
  return exponent >= 0 ? rational(digits * 10n ** BigInt(exponent)) : rational(digits, 10n ** BigInt(-exponent));
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

function add(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

function sub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

function mul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new ConstantDivisionByZero();
  return rational(a.num * b.den, a.den * b.num);
}

export function compareRational(a: Rational, b: Rational): number {
  const difference = a.num * b.den - b.num * a.den;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
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
  if (bitLength(value.num) > 100_000n || bitLength(value.den) > 100_000n) throw new ConstantOverflow();
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
      if (constant.kind === 'float')
        return { kind: 'float', value: { num: -constant.value.num, den: constant.value.den } };
      if (constant.kind === 'complex') {
        return {
          kind: 'complex',
          re: { num: -constant.re.num, den: constant.re.den },
          im: { num: -constant.im.num, den: constant.im.den },
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
  if (constant.kind === 'float') return constant.value.den === 1n ? constant.value.num : undefined;
  if (constant.kind === 'complex')
    return constant.im.num === 0n && constant.re.den === 1n ? constant.re.num : undefined;
  return undefined;
}

/** Rounds an exact fraction to the nearest double, halves to even. */
export function rationalToFloat({ num, den }: Rational): number {
  if (num === 0n) return 0;
  const negative = num < 0n;
  const magnitude = negative ? -num : num;
  // Scales the quotient to at least 66 significant bits, then rounds once with a sticky bit.
  const shift = den.toString(2).length - magnitude.toString(2).length + 66;
  const numerator = shift > 0 ? magnitude << BigInt(shift) : magnitude;
  const denominator = shift < 0 ? den << BigInt(-shift) : den;
  let quotient = numerator / denominator;
  if (numerator % denominator !== 0n) quotient |= 1n;
  const result = scaleToFloat(quotient, -shift);
  return negative ? -result : result;
}

/** Computes `mantissa * 2 ** exponent` rounded once to the nearest double, halves to even, handling subnormals. */
export function scaleToFloat(mantissa: bigint, exponent: number): number {
  const bits = mantissa.toString(2).length;
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
