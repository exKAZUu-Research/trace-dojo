import type { BinaryOperator } from './ast';
import { floatPower } from './floatPower';
import { fusedMultiplyAdd as fma } from './modules/mathFma';
import { asFloat, floatRepr } from './numbers';
import { complexClass, NotImplemented, pyError } from './types';
import { PyComplex, type PyValue } from './values';

export function newComplex(real: number, imag: number): PyComplex {
  return new PyComplex(complexClass, real, imag);
}

export function isComplexOperand(value: PyValue): value is PyComplex | bigint | number | boolean {
  return (
    value instanceof PyComplex || typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean'
  );
}

interface Parts {
  real: number;
  imag: number;
}

function partsOf(value: PyComplex | bigint | number | boolean): Parts {
  if (value instanceof PyComplex) return { real: value.real, imag: value.imag };
  return { real: asFloat(value), imag: 0 };
}

function product(a: Parts, b: Parts): Parts {
  return { real: a.real * b.real - a.imag * b.imag, imag: a.real * b.imag + a.imag * b.real };
}

/**
 * Divides as CPython's _Py_c_quot does, with the message of the operator that divides for a zero divisor. The C
 * compiler of the CPython this matches contracts each `x * y ± z` of the algorithm into one fused multiply-add.
 */
function quotient(a: Parts, b: Parts, zeroDivisor = 'division by zero'): Parts {
  const absReal = Math.abs(b.real);
  const absImag = Math.abs(b.imag);
  let result: Parts = { real: Number.NaN, imag: Number.NaN };
  if (absReal >= absImag) {
    if (absReal === 0) throw pyError('ZeroDivisionError', zeroDivisor);
    const ratio = b.imag / b.real;
    const denominator = fma(b.imag, ratio, b.real);
    result = { real: fma(a.imag, ratio, a.real) / denominator, imag: fma(-a.real, ratio, a.imag) / denominator };
  } else if (absImag >= absReal) {
    const ratio = b.real / b.imag;
    const denominator = fma(b.real, ratio, b.imag);
    result = { real: fma(a.real, ratio, a.imag) / denominator, imag: fma(a.imag, ratio, -a.real) / denominator };
  }
  return Number.isNaN(result.real) && Number.isNaN(result.imag) ? recoveredQuotient(a, b, result) : result;
}

/** Recovers the infinities and zeros that computed as nan+nanj, as C11's Annex G.5.2 and CPython do. */
function recoveredQuotient(a: Parts, b: Parts, result: Parts): Parts {
  if ((isInfinite(a.real) || isInfinite(a.imag)) && Number.isFinite(b.real) && Number.isFinite(b.imag)) {
    const x = copySign(isInfinite(a.real) ? 1 : 0, a.real);
    const y = copySign(isInfinite(a.imag) ? 1 : 0, a.imag);
    return {
      real: Number.POSITIVE_INFINITY * fma(x, b.real, y * b.imag),
      imag: Number.POSITIVE_INFINITY * fma(y, b.real, -x * b.imag),
    };
  }
  if ((isInfinite(b.real) || isInfinite(b.imag)) && Number.isFinite(a.real) && Number.isFinite(a.imag)) {
    const x = copySign(isInfinite(b.real) ? 1 : 0, b.real);
    const y = copySign(isInfinite(b.imag) ? 1 : 0, b.imag);
    return { real: 0 * fma(a.real, x, a.imag * y), imag: 0 * fma(a.imag, x, -a.real * y) };
  }
  return result;
}

const isInfinite = (value: number): boolean => value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY;

/** C's copysign, for which JavaScript cannot read a NaN's sign, taken as positive. */
function copySign(magnitude: number, sign: number): number {
  return sign < 0 || Object.is(sign, -0) ? -Math.abs(magnitude) : Math.abs(magnitude);
}

function powerUnsigned(x: Parts, n: number): Parts {
  let result: Parts = { real: 1, imag: 0 };
  let power = x;
  for (let mask = 1; mask > 0 && n >= mask; mask *= 2) {
    if (Math.floor(n / mask) % 2 === 1) result = product(result, power);
    power = product(power, power);
  }
  return result;
}

const ZERO_TO_NEGATIVE_POWER = 'zero to a negative or complex power';

function power(a: Parts, b: Parts): Parts {
  if (b.imag === 0 && b.real === Math.floor(b.real) && Math.abs(b.real) <= 100) {
    const n = b.real;
    return n > 0 ? powerUnsigned(a, n) : quotient({ real: 1, imag: 0 }, powerUnsigned(a, -n), ZERO_TO_NEGATIVE_POWER);
  }
  if (b.real === 0 && b.imag === 0) return { real: 1, imag: 0 };
  if (a.real === 0 && a.imag === 0) {
    if (b.imag !== 0 || b.real < 0) throw pyError('ZeroDivisionError', ZERO_TO_NEGATIVE_POWER);
    return { real: 0, imag: 0 };
  }
  const magnitude = Math.hypot(a.real, a.imag);
  let length = floatPower(magnitude, b.real);
  const angle = Math.atan2(a.imag, a.real);
  let phase = angle * b.real;
  if (b.imag !== 0) {
    length *= Math.exp(-angle * b.imag);
    phase = fma(b.imag, Math.log(magnitude), phase);
  }
  return { real: length * Math.cos(phase), imag: length * Math.sin(phase) };
}

/** Arithmetic with at least one complex operand, mixing in reals as CPython 3.14 does. */
// code-gauge-allow functionNcss 43 -- One case per operator on complex numbers.
// code-gauge-allow functionCognitiveComplexity 24 -- One case per operator on complex numbers.
export function complexBinary(
  operator: BinaryOperator,
  left: PyComplex | bigint | number | boolean,
  right: PyValue
): PyValue {
  if (!isComplexOperand(right)) return NotImplemented;
  const a = partsOf(left);
  const b = partsOf(right);
  const leftReal = !(left instanceof PyComplex);
  const rightReal = !(right instanceof PyComplex);
  let result: Parts;
  switch (operator) {
    case '+': {
      result = { real: a.real + b.real, imag: leftReal ? b.imag : rightReal ? a.imag : a.imag + b.imag };
      break;
    }
    case '-': {
      result = { real: a.real - b.real, imag: leftReal ? -b.imag : rightReal ? a.imag : a.imag - b.imag };
      break;
    }
    case '*': {
      if (rightReal) result = { real: a.real * b.real, imag: a.imag * b.real };
      else if (leftReal) result = { real: a.real * b.real, imag: a.real * b.imag };
      else result = product(a, b);
      break;
    }
    case '/': {
      if (rightReal) {
        if (b.real === 0) throw pyError('ZeroDivisionError', 'division by zero');
        result = { real: a.real / b.real, imag: a.imag / b.real };
      } else {
        result = quotient(a, b);
      }
      break;
    }
    case '**': {
      result = power(a, b);
      break;
    }
    case '//':
    case '%': {
      throw pyError(
        'TypeError',
        `unsupported operand type(s) for ${operator}: '${typeOfOperand(left)}' and '${typeOfOperand(right)}'`
      );
    }
    default: {
      return NotImplemented;
    }
  }
  if (
    !Number.isFinite(result.real + result.imag) &&
    Number.isFinite(a.real + a.imag + b.real + b.imag) &&
    operator === '**'
  ) {
    throw pyError('OverflowError', 'complex exponentiation');
  }
  return newComplex(result.real, result.imag);
}

function typeOfOperand(value: PyComplex | bigint | number | boolean): string {
  if (value instanceof PyComplex) return 'complex';
  return typeof value === 'bigint' ? 'int' : typeof value === 'number' ? 'float' : 'bool';
}

/** A float part of a complex repr, which omits the `.0` a float repr adds. */
function partRepr(value: number): string {
  const text = floatRepr(value);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

export function complexRepr(value: PyComplex): string {
  const { real, imag } = value;
  const imagText = partRepr(imag);
  if (real === 0 && !Object.is(real, -0)) return `${imagText}j`;
  const sign = imag >= 0 || Number.isNaN(imag) ? (Object.is(imag, -0) ? '' : '+') : '';
  return `(${partRepr(real)}${sign}${imagText}j)`;
}

export function complexAbs(value: PyComplex): number {
  const result = Math.hypot(value.real, value.imag);
  if (!Number.isFinite(result) && Number.isFinite(value.real) && Number.isFinite(value.imag)) {
    throw pyError('OverflowError', 'absolute value too large');
  }
  return result;
}
