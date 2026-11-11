import { currentRuntime } from '../runtimeContext';
import { type Condition, type DecimalContext, etiny, etop, type Rounding } from './decimalContext';

/**
 * A decimal number as `_pydecimal` stores it: a sign, the digits of the coefficient, and an exponent, or for special
 * values the payload digits and 'F' (infinity), 'n' (quiet NaN), or 'N' (signaling NaN) in place of the exponent.
 */
export interface Dec {
  readonly sign: 0 | 1;
  readonly int: string;
  readonly exp: number | 'F' | 'n' | 'N';
}

/** A finite decimal, whose exponent is a number. */
export type FiniteDec = Dec & { readonly exp: number };

export function dec(sign: boolean | number, int: string, exp: Dec['exp']): Dec {
  return { sign: sign ? 1 : 0, int, exp };
}

export const ZERO = dec(0, '0', 0);
export const ONE = dec(0, '1', 0);
export const NEGATIVE_ONE = dec(1, '1', 0);
export const NAN = dec(0, '', 'n');
export const INFINITY = dec(0, '0', 'F');
export const NEGATIVE_INFINITY = dec(1, '0', 'F');

export function signedInfinity(sign: number): Dec {
  return sign ? NEGATIVE_INFINITY : INFINITY;
}

export const isSpecial = (value: Dec): boolean => typeof value.exp === 'string';
export const isFinite = (value: Dec): value is FiniteDec => typeof value.exp === 'number';
/** 1 for a quiet NaN, 2 for a signaling NaN, and 0 otherwise. */
export const nanKind = (value: Dec): number => (value.exp === 'n' ? 1 : value.exp === 'N' ? 2 : 0);
export const isNan = (value: Dec): boolean => value.exp === 'n' || value.exp === 'N';
/** 1 for +Infinity, -1 for -Infinity, and 0 otherwise. */
export const infinityKind = (value: Dec): number => (value.exp === 'F' ? (value.sign ? -1 : 1) : 0);
/** Python's truth value of a Decimal: special values are true. */
export const isNonzero = (value: Dec): boolean => isSpecial(value) || value.int !== '0';
export const isZero = (value: Dec): boolean => !isSpecial(value) && value.int === '0';

export function adjusted(value: Dec): number {
  return isFinite(value) ? value.exp + value.int.length - 1 : 0;
}

export function bigOf(digits: string): bigint {
  return digits === '' ? 0n : BigInt(digits);
}

export function digitsOf(value: bigint): string {
  return (value < 0n ? -value : value).toString();
}

export function tenTo(exponent: number): bigint {
  currentRuntime().chargeBits(BigInt(Math.max(exponent, 0)) * 4n);
  return 10n ** BigInt(exponent);
}

export function multiply(a: bigint, b: bigint): bigint {
  currentRuntime().chargeBigint(a, b);
  return a * b;
}

// Conditions ---------------------------------------------------------------------------------------------------------

/** Records a condition as `Context._raise_error` does, returning the result the condition substitutes when untrapped. */
export function raiseCondition(context: DecimalContext, condition: Condition, argument?: Dec | number): Dec {
  context.status.add(condition);
  switch (condition) {
    case 'DivisionByZero': {
      return signedInfinity(argument as number);
    }
    case 'Overflow': {
      return overflowResult(context, argument as number);
    }
    case 'InvalidOperation': {
      if (typeof argument === 'object') return fixNan(dec(argument.sign, argument.int, 'n'), context);
      return NAN;
    }
    default: {
      return NAN;
    }
  }
}

function overflowResult(context: DecimalContext, sign: number): Dec {
  const { rounding } = context;
  if (['ROUND_HALF_UP', 'ROUND_HALF_EVEN', 'ROUND_HALF_DOWN', 'ROUND_UP'].includes(rounding)) {
    return signedInfinity(sign);
  }
  if (sign === 0 && rounding === 'ROUND_CEILING') return signedInfinity(sign);
  if (sign === 1 && rounding === 'ROUND_FLOOR') return signedInfinity(sign);
  return dec(sign, '9'.repeat(context.prec), context.Emax - context.prec + 1);
}

export function checkNans(self: Dec, other: Dec | undefined, context: DecimalContext): Dec | undefined {
  const selfNan = nanKind(self);
  const otherNan = other ? nanKind(other) : 0;
  if (!selfNan && !otherNan) return undefined;
  if (selfNan === 2) return raiseCondition(context, 'InvalidOperation', self);
  if (otherNan === 2) return raiseCondition(context, 'InvalidOperation', other);
  if (selfNan) return fixNan(self, context);
  return fixNan(other as Dec, context);
}

/** Whether a comparison involves a NaN, which `<` and friends signal as InvalidOperation. */
export function compareCheckNans(self: Dec, other: Dec, context: DecimalContext): boolean {
  if (!isSpecial(self) && !isSpecial(other)) return false;
  for (const value of [self, other])
    if (value.exp === 'N') return isNonzero(raiseCondition(context, 'InvalidOperation', value));
  for (const value of [self, other])
    if (value.exp === 'n') return isNonzero(raiseCondition(context, 'InvalidOperation', value));
  return false;
}

// Rounding to the context ---------------------------------------------------------------------------------------------

export function fixNan(self: Dec, context: DecimalContext): Dec {
  const maxLength = context.prec - context.clamp;
  if (self.int.length > maxLength) {
    return dec(self.sign, self.int.slice(self.int.length - maxLength).replace(/^0+/, ''), self.exp);
  }
  return self;
}

/** Rounds a decimal to the context's precision and exponent range, as `Decimal._fix` does. */
export function fix(self: Dec, context: DecimalContext): Dec {
  if (!isFinite(self)) return isNan(self) ? fixNan(self, context) : self;
  const tiny = etiny(context);
  const top = etop(context);
  if (self.int === '0') {
    const expMax = context.clamp ? top : context.Emax;
    const newExp = Math.min(Math.max(self.exp, tiny), expMax);
    if (newExp === self.exp) return self;
    raiseCondition(context, 'Clamped');
    return dec(self.sign, '0', newExp);
  }
  let expMin = self.int.length + self.exp - context.prec;
  if (expMin > top) {
    const result = raiseCondition(context, 'Overflow', self.sign);
    raiseCondition(context, 'Inexact');
    raiseCondition(context, 'Rounded');
    return result;
  }
  const subnormal = expMin < tiny;
  if (subnormal) expMin = tiny;
  if (self.exp < expMin) return fixRounded(self, context, expMin, subnormal);
  if (subnormal) raiseCondition(context, 'Subnormal');
  if (context.clamp === 1 && self.exp > top) {
    raiseCondition(context, 'Clamped');
    return dec(self.sign, self.int + '0'.repeat(self.exp - top), top);
  }
  return self;
}

function fixRounded(value: FiniteDec, context: DecimalContext, minimumExponent: number, subnormal: boolean): Dec {
  let self: FiniteDec = value;
  let expMin = minimumExponent;
  let digits = self.int.length + self.exp - expMin;
  if (digits < 0) {
    self = dec(self.sign, '1', expMin - 1) as FiniteDec;
    digits = 0;
  }
  const changed = roundingChange(self, digits, context.rounding);
  let coefficient = self.int.slice(0, digits) || '0';
  if (changed > 0) {
    coefficient = (BigInt(coefficient) + 1n).toString();
    if (coefficient.length > context.prec) {
      coefficient = coefficient.slice(0, -1);
      expMin += 1;
    }
  }
  const result =
    expMin > etop(context) ? raiseCondition(context, 'Overflow', self.sign) : dec(self.sign, coefficient, expMin);
  if (changed && subnormal) raiseCondition(context, 'Underflow');
  if (subnormal) raiseCondition(context, 'Subnormal');
  if (changed) raiseCondition(context, 'Inexact');
  raiseCondition(context, 'Rounded');
  if (!isNonzero(result)) raiseCondition(context, 'Clamped');
  return result;
}

const allZeros = (digits: string, from: number): boolean => /^0*$/.test(digits.slice(from));
const exactHalf = (digits: string, from: number): boolean => /^50*$/.test(digits.slice(from));

function roundDown(self: Dec, prec: number): number {
  return allZeros(self.int, prec) ? 0 : -1;
}

function roundHalfUp(self: Dec, prec: number): number {
  if ('56789'.includes(self.int[prec] ?? 'x')) return 1;
  return allZeros(self.int, prec) ? 0 : -1;
}

/**
 * Whether rounding the coefficient to its first `prec` digits rounds up (1), truncates nonzero digits (-1), or
 * drops only zeros (0), as the `_round_*` methods of `Decimal` decide.
 */
export function roundingChange(self: Dec, prec: number, rounding: Rounding): number {
  switch (rounding) {
    case 'ROUND_DOWN': {
      return roundDown(self, prec);
    }
    case 'ROUND_UP': {
      return -roundDown(self, prec);
    }
    case 'ROUND_HALF_UP': {
      return roundHalfUp(self, prec);
    }
    case 'ROUND_HALF_DOWN': {
      return exactHalf(self.int, prec) ? -1 : roundHalfUp(self, prec);
    }
    case 'ROUND_HALF_EVEN': {
      const even = prec === 0 || '02468'.includes(self.int[prec - 1]);
      return exactHalf(self.int, prec) && even ? -1 : roundHalfUp(self, prec);
    }
    case 'ROUND_CEILING': {
      return self.sign ? roundDown(self, prec) : -roundDown(self, prec);
    }
    case 'ROUND_FLOOR': {
      return self.sign ? -roundDown(self, prec) : roundDown(self, prec);
    }
    default: {
      if (prec && !'05'.includes(self.int[prec - 1])) return roundDown(self, prec);
      return -roundDown(self, prec);
    }
  }
}

/** Rounds to exponent `exp` without signals, as `Decimal._rescale` does. */
export function rescale(self: Dec, exp: number, rounding: Rounding): Dec {
  if (!isFinite(self)) return self;
  if (self.int === '0') return dec(self.sign, '0', exp);
  if (self.exp >= exp) return dec(self.sign, self.int + '0'.repeat(self.exp - exp), exp);
  let value: Dec = self;
  let digits = self.int.length + self.exp - exp;
  if (digits < 0) {
    value = dec(self.sign, '1', exp - 1);
    digits = 0;
  }
  const changed = roundingChange(value, digits, rounding);
  let coefficient = value.int.slice(0, digits) || '0';
  if (changed === 1) coefficient = (BigInt(coefficient) + 1n).toString();
  return dec(self.sign, coefficient, exp);
}

/** Rounds to `places` significant digits, as `Decimal._round` does. */
export function roundPlaces(self: Dec, places: number, rounding: Rounding): Dec {
  if (!isFinite(self) || self.int === '0') return self;
  let result = rescale(self, adjusted(self) + 1 - places, rounding);
  if (adjusted(result) !== adjusted(self)) result = rescale(result, adjusted(result) + 1 - places, rounding);
  return result;
}

// Comparison ---------------------------------------------------------------------------------------------------------

/** Compares two non-NaN decimals: -1, 0, or 1. */
// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes _pydecimal's algorithm of the same name.
export function compareValues(self: Dec, other: Dec): number {
  if (isSpecial(self) || isSpecial(other)) {
    const a = infinityKind(self);
    const b = infinityKind(other);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const selfSign = self.sign ? -1 : 1;
  if (!isNonzero(self)) return isNonzero(other) ? (other.sign ? 1 : -1) : 0;
  if (!isNonzero(other)) return selfSign;
  if (other.sign < self.sign) return -1;
  if (self.sign < other.sign) return 1;
  const a = adjusted(self);
  const b = adjusted(other);
  if (a !== b) return a > b ? selfSign : -selfSign;
  const selfExp = self.exp as number;
  const otherExp = other.exp as number;
  const left = self.int + '0'.repeat(Math.max(selfExp - otherExp, 0));
  const right = other.int + '0'.repeat(Math.max(otherExp - selfExp, 0));
  if (left === right) return 0;
  return left < right ? -selfSign : selfSign;
}

export function equalValues(a: Dec, b: Dec): boolean {
  return !isNan(a) && !isNan(b) && compareValues(a, b) === 0;
}

// Python's `==` between two Decimals inside an algorithm, which treats NaNs as unequal without signaling.
export function sameValue(a: Dec, b: Dec): boolean {
  return equalValues(a, b);
}

export function isInteger(self: Dec): boolean {
  if (!isFinite(self)) return false;
  if (self.exp >= 0) return true;
  return /^0*$/.test(self.int.slice(self.exp));
}

export function isEven(self: Dec): boolean {
  if (!isNonzero(self) || (self.exp as number) > 0) return true;
  return '02468'.includes(self.int.at(-1 + (self.exp as number)) ?? '0');
}

/** `int(self)` for a finite decimal. */
export function truncatedInt(self: FiniteDec): bigint {
  const magnitude =
    self.exp >= 0 ? multiply(BigInt(self.int), tenTo(self.exp)) : bigOf(self.int.slice(0, self.exp) || '0');
  return self.sign ? -magnitude : magnitude;
}

export function copyAbs(self: Dec): Dec {
  return dec(0, self.int, self.exp);
}

export function copyNegate(self: Dec): Dec {
  return dec(self.sign ? 0 : 1, self.int, self.exp);
}
