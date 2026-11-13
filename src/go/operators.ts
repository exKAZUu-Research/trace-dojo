import { fma } from './fma';
import { divideByZeroPanic, runtimeErrorPanic } from './runtimeErrors';
import {
  type BasicKind,
  integerBits,
  isBasic,
  isComplex,
  isFloat,
  isInteger,
  isString,
  type Type,
  underlying,
} from './types';
import { Complex, type Value } from './values';

type Binary = (a: Value, b: Value) => Value;

/** Wraps an integer to its type's width, as Go's integers overflow. */
export function integerWrapper(type: Type): (value: bigint) => bigint {
  const under = underlying(type);
  const kind = under.kind === 'basic' ? under.basic : 'int';
  if (kind === 'untypedInt' || kind === 'untypedRune') return (value) => value;
  const { bits, signed } = integerBits(kind);
  return signed ? (value) => BigInt.asIntN(bits, value) : (value) => BigInt.asUintN(bits, value);
}

/** The runtime operation of an arithmetic or bitwise operator on two values of the same type. */
// code-gauge-allow functionCognitiveComplexity 30 -- One case per operator and kind of operand.
export function arithmetic(operator: string, type: Type): Binary {
  if (isString(type)) return (a, b) => (a as string) + (b as string);
  if (isComplex(type)) return complexArithmetic(operator, isBasic(type, 'complex64'));
  if (isFloat(type)) {
    const round = isBasic(type, 'float32') ? Math.fround : (value: number): number => value;
    switch (operator) {
      case '+': {
        return (a, b) => round((a as number) + (b as number));
      }
      case '-': {
        return (a, b) => round((a as number) - (b as number));
      }
      case '*': {
        return (a, b) => round((a as number) * (b as number));
      }
      case '/': {
        return (a, b) => round((a as number) / (b as number));
      }
    }
    throw new Error(`Invalid float operator ${operator}`);
  }
  if (!isInteger(type)) throw new Error(`Invalid arithmetic on ${operator}`);
  const wrap = integerWrapper(type);
  switch (operator) {
    case '+': {
      return (a, b) => wrap((a as bigint) + (b as bigint));
    }
    case '-': {
      return (a, b) => wrap((a as bigint) - (b as bigint));
    }
    case '*': {
      return (a, b) => wrap((a as bigint) * (b as bigint));
    }
    case '/': {
      return (a, b) => {
        if (b === 0n) divideByZeroPanic();
        return wrap((a as bigint) / (b as bigint));
      };
    }
    case '%': {
      return (a, b) => {
        if (b === 0n) divideByZeroPanic();
        return wrap((a as bigint) % (b as bigint));
      };
    }
    case '&': {
      return (a, b) => (a as bigint) & (b as bigint);
    }
    case '|': {
      return (a, b) => (a as bigint) | (b as bigint);
    }
    case '^': {
      return (a, b) => wrap((a as bigint) ^ (b as bigint));
    }
    case '&^': {
      return (a, b) => (a as bigint) & ~(b as bigint);
    }
  }
  throw new Error(`Invalid integer operator ${operator}`);
}

function complexArithmetic(operator: string, single: boolean): Binary {
  const round = single ? Math.fround : (value: number): number => value;
  const make = (re: number, im: number): Complex => new Complex(round(re), round(im));
  switch (operator) {
    case '+': {
      return (a, b) => make((a as Complex).re + (b as Complex).re, (a as Complex).im + (b as Complex).im);
    }
    case '-': {
      return (a, b) => make((a as Complex).re - (b as Complex).re, (a as Complex).im - (b as Complex).im);
    }
    case '*': {
      return (a, b) => {
        const x = a as Complex;
        const y = b as Complex;
        // Go's arm64 code fuses one product of each part, complex64 included (it multiplies in float64).
        return make(fma(-x.im, y.im, x.re * y.re), fma(x.im, y.re, x.re * y.im));
      };
    }
    case '/': {
      return (a, b) => complexDivide(a as Complex, b as Complex, make);
    }
  }
  throw new Error(`Invalid complex operator ${operator}`);
}

/** Divides as Go's runtime does (complex128div), including its handling of infinities and NaNs. */
function complexDivide(n: Complex, m: Complex, make: (re: number, im: number) => Complex): Complex {
  let e: number;
  let f: number;
  // Go's runtime is compiled for arm64 with these multiply-adds fused.
  if (Math.abs(m.re) >= Math.abs(m.im)) {
    const ratio = m.im / m.re;
    const denom = fma(ratio, m.im, m.re);
    e = fma(n.im, ratio, n.re) / denom;
    f = fma(-n.re, ratio, n.im) / denom;
  } else {
    const ratio = m.re / m.im;
    const denom = fma(ratio, m.re, m.im);
    e = fma(n.re, ratio, n.im) / denom;
    f = fma(n.im, ratio, -n.re) / denom;
  }
  if (Number.isNaN(e) && Number.isNaN(f)) {
    // Correct final result to infinities and zeros if applicable. Matches C99: ISO/IEC 9899:1999 - G.5.1.
    const a = n.re;
    const b = n.im;
    const c = m.re;
    const d = m.im;
    if (c === 0 && d === 0 && (!Number.isNaN(a) || !Number.isNaN(b))) {
      e = copySign(Infinity, c) * a;
      f = copySign(Infinity, c) * b;
    } else if (isInfinite(a, b) && Number.isFinite(c) && Number.isFinite(d)) {
      const [x, y] = [infToOne(a), infToOne(b)];
      e = Infinity * (x * c + y * d);
      f = Infinity * (y * c - x * d);
    } else if (isInfinite(c, d) && Number.isFinite(a) && Number.isFinite(b)) {
      const [x, y] = [infToOne(c), infToOne(d)];
      // oxlint-disable-next-line erasing-op -- Multiplying by 0 keeps the sign of the product as Go's runtime does.
      e = 0 * (a * x + b * y);
      // oxlint-disable-next-line erasing-op -- As above.
      f = 0 * (b * x - a * y);
    }
  }
  return make(e, f);
}

function isInfinite(x: number, y: number): boolean {
  return Math.abs(x) === Infinity || Math.abs(y) === Infinity;
}

/** Go's inf2one: ±1 for an infinity and ±0 otherwise, keeping the sign. */
function infToOne(value: number): number {
  return copySign(Math.abs(value) === Infinity ? 1 : 0, value);
}

function copySign(magnitude: number, sign: number): number {
  return (sign < 0 || Object.is(sign, -0)) === magnitude < 0 ? magnitude : -magnitude;
}

/** Shifts an integer, where a count at or beyond the width yields 0 (or -1 for a negative value shifted right). */
export function shift(operator: '<<' | '>>', type: Type): (value: bigint, count: bigint) => bigint {
  const wrap = integerWrapper(type);
  const under = underlying(type);
  const bits = under.kind === 'basic' ? integerBits(under.basic as BasicKind).bits : 64;
  return (value, count) => {
    if (count < 0n) runtimeErrorPanic('negative shift amount');
    if (operator === '<<') return count >= BigInt(bits) ? 0n : wrap(value << count);
    if (count >= BigInt(bits)) return value < 0n ? -1n : 0n;
    return value >> count;
  };
}

/** Compares two ordered values: integers, floats, or strings, which compare by their bytes. */
export function ordering(operator: string): (a: Value, b: Value) => boolean {
  switch (operator) {
    case '<': {
      return (a, b) => (a as number) < (b as number);
    }
    case '<=': {
      return (a, b) => (a as number) <= (b as number);
    }
    case '>': {
      return (a, b) => (a as number) > (b as number);
    }
    case '>=': {
      return (a, b) => (a as number) >= (b as number);
    }
  }
  throw new Error(`Invalid comparison ${operator}`);
}

export function negate(type: Type): (value: Value) => Value {
  if (isComplex(type)) return (value) => new Complex(-(value as Complex).re, -(value as Complex).im);
  if (isFloat(type)) return (value) => -(value as number);
  const wrap = integerWrapper(type);
  return (value) => wrap(-(value as bigint));
}

export function bitwiseNot(type: Type): (value: Value) => Value {
  const wrap = integerWrapper(type);
  return (value) => wrap(~(value as bigint));
}
