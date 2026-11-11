// code-gauge-allow-file fileNcss 533 -- Transcribes the methods of _pydecimal that belong together.
import { type DecimalContext, etiny, etop, type Rounding } from './decimalContext';
import {
  adjusted,
  bigOf,
  checkNans,
  compareValues,
  copyAbs,
  copyNegate,
  type Dec,
  dec,
  digitsOf,
  fix,
  infinityKind,
  isFinite,
  isNan,
  isNonzero,
  isSpecial,
  multiply,
  NAN,
  nanKind,
  NEGATIVE_ONE,
  ONE,
  raiseCondition,
  rescale,
  signedInfinity,
  tenTo,
  truncatedInt,
  ZERO,
} from './decimalNumber';

// The arithmetic of `_pydecimal.Decimal`, whose methods these functions transcribe, operating on context states.

interface WorkRep {
  sign: 0 | 1;
  int: bigint;
  exp: number;
}

function workRep(value: Dec): WorkRep {
  return { sign: value.sign, int: BigInt(value.int), exp: value.exp as number };
}

function fromWork(value: WorkRep): Dec {
  return dec(value.sign, value.int.toString(), value.exp);
}

export function negate(self: Dec, context: DecimalContext): Dec {
  if (isSpecial(self)) {
    const nan = checkNans(self, undefined, context);
    if (nan) return nan;
  }
  const result = !isNonzero(self) && context.rounding !== 'ROUND_FLOOR' ? copyAbs(self) : copyNegate(self);
  return fix(result, context);
}

export function plus(self: Dec, context: DecimalContext): Dec {
  if (isSpecial(self)) {
    const nan = checkNans(self, undefined, context);
    if (nan) return nan;
  }
  return fix(!isNonzero(self) && context.rounding !== 'ROUND_FLOOR' ? copyAbs(self) : self, context);
}

export function absolute(self: Dec, context: DecimalContext): Dec {
  if (isSpecial(self)) {
    const nan = checkNans(self, undefined, context);
    if (nan) return nan;
  }
  return self.sign ? negate(self, context) : plus(self, context);
}

/** `Decimal.__add__`. */
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes _pydecimal's algorithm of the same name.
export function add(self: Dec, other: Dec, context: DecimalContext): Dec {
  if (isSpecial(self) || isSpecial(other)) {
    const nan = checkNans(self, other, context);
    if (nan) return nan;
    if (infinityKind(self)) {
      if (self.sign !== other.sign && infinityKind(other)) return raiseCondition(context, 'InvalidOperation');
      return self;
    }
    if (infinityKind(other)) return other;
  }
  const selfExp = self.exp as number;
  const otherExp = other.exp as number;
  let exp = Math.min(selfExp, otherExp);
  const negativeZero = context.rounding === 'ROUND_FLOOR' && self.sign !== other.sign ? 1 : 0;
  if (!isNonzero(self) && !isNonzero(other)) {
    return fix(dec(negativeZero || Math.min(self.sign, other.sign), '0', exp), context);
  }
  if (!isNonzero(self)) {
    exp = Math.max(exp, otherExp - context.prec - 1);
    return fix(rescale(other, exp, context.rounding), context);
  }
  if (!isNonzero(other)) {
    exp = Math.max(exp, selfExp - context.prec - 1);
    return fix(rescale(self, exp, context.rounding), context);
  }
  const [op1, op2] = normalize(workRep(self), workRep(other), context.prec);
  return fix(addAligned(op1, op2, negativeZero), context);
}

function addAligned(first: WorkRep, second: WorkRep, negativeZero: number): Dec {
  let op1 = first;
  let op2 = second;
  let sign: 0 | 1 = 0;
  if (op1.sign !== op2.sign) {
    if (op1.int === op2.int) return dec(negativeZero, '0', op1.exp);
    if (op1.int < op2.int) [op1, op2] = [op2, op1];
    if (op1.sign === 1) {
      sign = 1;
      [op1, op2] = [
        { ...op1, sign: op2.sign },
        { ...op2, sign: op1.sign },
      ];
    }
  } else if (op1.sign === 1) {
    sign = 1;
    op2 = { ...op2, sign: 0 };
  }
  const int = op2.sign === 0 ? op1.int + op2.int : op1.int - op2.int;
  return fromWork({ sign, int, exp: op1.exp });
}

/** Aligns two operands of an addition, as `_normalize` does, rounding away digits that cannot matter. */
function normalize(op1: WorkRep, op2: WorkRep, prec: number): [WorkRep, WorkRep] {
  const firstIsTmp = op1.exp >= op2.exp;
  const tmp = { ...(firstIsTmp ? op1 : op2) };
  const other = { ...(firstIsTmp ? op2 : op1) };
  const tmpLength = digitsOf(tmp.int).length;
  const otherLength = digitsOf(other.int).length;
  const exp = tmp.exp + Math.min(-1, tmpLength - prec - 2);
  if (otherLength + other.exp - 1 < exp) {
    other.int = 1n;
    other.exp = exp;
  }
  tmp.int = multiply(tmp.int, tenTo(tmp.exp - other.exp));
  tmp.exp = other.exp;
  return firstIsTmp ? [tmp, other] : [other, tmp];
}

export function subtract(self: Dec, other: Dec, context: DecimalContext): Dec {
  if (isSpecial(self) || isSpecial(other)) {
    const nan = checkNans(self, other, context);
    if (nan) return nan;
  }
  return add(self, copyNegate(other), context);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes _pydecimal's algorithm of the same name.
export function times(self: Dec, other: Dec, context: DecimalContext): Dec {
  const sign = self.sign ^ other.sign;
  if (isSpecial(self) || isSpecial(other)) {
    const nan = checkNans(self, other, context);
    if (nan) return nan;
    if (infinityKind(self))
      return isNonzero(other) ? signedInfinity(sign) : raiseCondition(context, 'InvalidOperation');
    if (infinityKind(other))
      return isNonzero(self) ? signedInfinity(sign) : raiseCondition(context, 'InvalidOperation');
  }
  const exp = (self.exp as number) + (other.exp as number);
  if (!isNonzero(self) || !isNonzero(other)) return fix(dec(sign, '0', exp), context);
  if (self.int === '1') return fix(dec(sign, other.int, exp), context);
  if (other.int === '1') return fix(dec(sign, self.int, exp), context);
  return fix(dec(sign, multiply(BigInt(self.int), BigInt(other.int)).toString(), exp), context);
}

/** `Decimal.__truediv__`. */
// code-gauge-allow functionCognitiveComplexity 22 -- Transcribes _pydecimal's algorithm of the same name.
// code-gauge-allow functionNcss 36 -- Transcribes _pydecimal's algorithm of the same name.
export function divide(self: Dec, other: Dec, context: DecimalContext): Dec {
  const sign = self.sign ^ other.sign;
  if (isSpecial(self) || isSpecial(other)) {
    const nan = checkNans(self, other, context);
    if (nan) return nan;
    if (infinityKind(self) && infinityKind(other)) return raiseCondition(context, 'InvalidOperation');
    if (infinityKind(self)) return signedInfinity(sign);
    raiseCondition(context, 'Clamped');
    return dec(sign, '0', etiny(context));
  }
  if (!isNonzero(other)) {
    if (!isNonzero(self)) return raiseCondition(context, 'DivisionUndefined');
    return raiseCondition(context, 'DivisionByZero', sign);
  }
  const selfExp = self.exp as number;
  const otherExp = other.exp as number;
  if (!isNonzero(self)) return fix(dec(sign, '0', selfExp - otherExp), context);
  const shift = other.int.length - self.int.length + context.prec + 1;
  let exp = selfExp - otherExp - shift;
  const a = BigInt(self.int);
  const b = BigInt(other.int);
  const numerator = shift >= 0 ? multiply(a, tenTo(shift)) : a;
  const denominator = shift >= 0 ? b : multiply(b, tenTo(-shift));
  let coefficient = numerator / denominator;
  if (numerator % denominator !== 0n) {
    if (coefficient % 5n === 0n) coefficient += 1n;
  } else {
    const ideal = selfExp - otherExp;
    while (exp < ideal && coefficient % 10n === 0n) {
      coefficient /= 10n;
      exp += 1;
    }
  }
  return fix(dec(sign, coefficient.toString(), exp), context);
}

/** The integer quotient and remainder, as `Decimal._divide` does. */
function divideInteger(self: Dec, other: Dec, context: DecimalContext): [Dec, Dec] {
  const sign = self.sign ^ other.sign;
  const idealExp = infinityKind(other) ? (self.exp as number) : Math.min(self.exp as number, other.exp as number);
  const expDiff = adjusted(self) - adjusted(other);
  if (!isNonzero(self) || infinityKind(other) || expDiff <= -2) {
    return [dec(sign, '0', 0), rescale(self, idealExp, context.rounding)];
  }
  if (expDiff <= context.prec) {
    const op1 = workRep(self);
    const op2 = workRep(other);
    if (op1.exp >= op2.exp) op1.int = multiply(op1.int, tenTo(op1.exp - op2.exp));
    else op2.int = multiply(op2.int, tenTo(op2.exp - op1.exp));
    const quotient = op1.int / op2.int;
    const remainder = op1.int % op2.int;
    if (quotient.toString().length <= context.prec) {
      return [dec(sign, quotient.toString(), 0), dec(self.sign, remainder.toString(), idealExp)];
    }
  }
  const result = raiseCondition(context, 'DivisionImpossible');
  return [result, result];
}

export function divideWithRemainder(self: Dec, other: Dec, context: DecimalContext): [Dec, Dec] {
  const nan = checkNans(self, other, context);
  if (nan) return [nan, nan];
  const sign = self.sign ^ other.sign;
  if (infinityKind(self)) {
    if (infinityKind(other)) {
      const result = raiseCondition(context, 'InvalidOperation');
      return [result, result];
    }
    return [signedInfinity(sign), raiseCondition(context, 'InvalidOperation')];
  }
  if (!isNonzero(other)) {
    if (!isNonzero(self)) {
      const result = raiseCondition(context, 'DivisionUndefined');
      return [result, result];
    }
    return [raiseCondition(context, 'DivisionByZero', sign), raiseCondition(context, 'InvalidOperation')];
  }
  const [quotient, remainder] = divideInteger(self, other, context);
  return [quotient, fix(remainder, context)];
}

export function remainder(self: Dec, other: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, other, context);
  if (nan) return nan;
  if (infinityKind(self)) return raiseCondition(context, 'InvalidOperation');
  if (!isNonzero(other)) {
    return raiseCondition(context, isNonzero(self) ? 'InvalidOperation' : 'DivisionUndefined');
  }
  return fix(divideInteger(self, other, context)[1], context);
}

export function floorDivide(self: Dec, other: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, other, context);
  if (nan) return nan;
  if (infinityKind(self)) {
    if (infinityKind(other)) return raiseCondition(context, 'InvalidOperation');
    return signedInfinity(self.sign ^ other.sign);
  }
  if (!isNonzero(other)) {
    if (isNonzero(self)) return raiseCondition(context, 'DivisionByZero', self.sign ^ other.sign);
    return raiseCondition(context, 'DivisionUndefined');
  }
  return divideInteger(self, other, context)[0];
}

/** `Decimal.remainder_near`. */
// code-gauge-allow functionNcss 33 -- Transcribes _pydecimal's algorithm of the same name.
export function remainderNear(self: Dec, other: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, other, context);
  if (nan) return nan;
  if (infinityKind(self)) return raiseCondition(context, 'InvalidOperation');
  if (!isNonzero(other)) {
    return raiseCondition(context, isNonzero(self) ? 'InvalidOperation' : 'DivisionUndefined');
  }
  if (infinityKind(other)) return fix(self, context);
  const idealExp = Math.min(self.exp as number, other.exp as number);
  if (!isNonzero(self)) return fix(dec(self.sign, '0', idealExp), context);
  const expDiff = adjusted(self) - adjusted(other);
  if (expDiff >= context.prec + 1) return raiseCondition(context, 'DivisionImpossible');
  if (expDiff <= -2) return fix(rescale(self, idealExp, context.rounding), context);
  const op1 = workRep(self);
  const op2 = workRep(other);
  if (op1.exp >= op2.exp) op1.int = multiply(op1.int, tenTo(op1.exp - op2.exp));
  else op2.int = multiply(op2.int, tenTo(op2.exp - op1.exp));
  let quotient = op1.int / op2.int;
  let rest = op1.int % op2.int;
  if (2n * rest + (quotient & 1n) > op2.int) {
    rest -= op2.int;
    quotient += 1n;
  }
  if (quotient.toString().length > context.prec) return raiseCondition(context, 'DivisionImpossible');
  const sign = rest < 0n ? 1 - self.sign : self.sign;
  return fix(dec(sign, digitsOf(rest), idealExp), context);
}

// code-gauge-allow functionCognitiveComplexity 18 -- Transcribes _pydecimal's algorithm of the same name.
export function fusedMultiplyAdd(self: Dec, other: Dec, third: Dec, context: DecimalContext): Dec {
  let product: Dec;
  if (isSpecial(self) || isSpecial(other)) {
    if (self.exp === 'N') return raiseCondition(context, 'InvalidOperation', self);
    if (other.exp === 'N') return raiseCondition(context, 'InvalidOperation', other);
    if (self.exp === 'n') product = self;
    else if (other.exp === 'n') product = other;
    else if (self.exp === 'F') {
      if (!isNonzero(other)) return raiseCondition(context, 'InvalidOperation');
      product = signedInfinity(self.sign ^ other.sign);
    } else {
      if (!isNonzero(self)) return raiseCondition(context, 'InvalidOperation');
      product = signedInfinity(self.sign ^ other.sign);
    }
  } else {
    product = dec(
      self.sign ^ other.sign,
      multiply(BigInt(self.int), BigInt(other.int)).toString(),
      (self.exp as number) + (other.exp as number)
    );
  }
  return add(product, third, context);
}

// Quantization -------------------------------------------------------------------------------------------------------

export function normalizeValue(self: Dec, context: DecimalContext): Dec {
  if (isSpecial(self)) {
    const nan = checkNans(self, undefined, context);
    if (nan) return nan;
  }
  const fixed = fix(self, context);
  if (infinityKind(fixed)) return fixed;
  if (!isNonzero(fixed)) return dec(fixed.sign, '0', 0);
  const expMax = context.clamp ? etop(context) : context.Emax;
  let end = fixed.int.length;
  let exp = fixed.exp as number;
  while (fixed.int[end - 1] === '0' && exp < expMax) {
    exp += 1;
    end -= 1;
  }
  return dec(fixed.sign, fixed.int.slice(0, end), exp);
}

/** `Decimal.quantize`. */
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes _pydecimal's algorithm of the same name.
export function quantize(self: Dec, exp: Dec, rounding: Rounding, context: DecimalContext): Dec {
  if (isSpecial(self) || isSpecial(exp)) {
    const nan = checkNans(self, exp, context);
    if (nan) return nan;
    if (infinityKind(exp) || infinityKind(self)) {
      if (infinityKind(exp) && infinityKind(self)) return self;
      return raiseCondition(context, 'InvalidOperation');
    }
  }
  const target = exp.exp as number;
  if (!(etiny(context) <= target && target <= context.Emax)) return raiseCondition(context, 'InvalidOperation');
  if (!isNonzero(self)) return fix(dec(self.sign, '0', target), context);
  const selfAdjusted = adjusted(self);
  if (selfAdjusted > context.Emax || selfAdjusted - target + 1 > context.prec) {
    return raiseCondition(context, 'InvalidOperation');
  }
  const result = rescale(self, target, rounding);
  if (adjusted(result) > context.Emax || result.int.length > context.prec) {
    return raiseCondition(context, 'InvalidOperation');
  }
  if (isNonzero(result) && adjusted(result) < context.Emin) raiseCondition(context, 'Subnormal');
  if ((result.exp as number) > (self.exp as number)) {
    if (compareValues(result, self) !== 0) raiseCondition(context, 'Inexact');
    raiseCondition(context, 'Rounded');
  }
  return fix(result, context);
}

export function toIntegralExact(self: Dec, rounding: Rounding, context: DecimalContext): Dec {
  if (isSpecial(self)) return checkNans(self, undefined, context) ?? self;
  if ((self.exp as number) >= 0) return self;
  if (!isNonzero(self)) return dec(self.sign, '0', 0);
  const result = rescale(self, 0, rounding);
  if (compareValues(result, self) !== 0) raiseCondition(context, 'Inexact');
  raiseCondition(context, 'Rounded');
  return result;
}

export function toIntegralValue(self: Dec, rounding: Rounding, context: DecimalContext): Dec {
  if (isSpecial(self)) return checkNans(self, undefined, context) ?? self;
  if ((self.exp as number) >= 0) return self;
  return rescale(self, 0, rounding);
}

/** `Decimal.sqrt`, correctly rounded with ROUND_HALF_EVEN. */
// code-gauge-allow functionCognitiveComplexity 19 -- Transcribes _pydecimal's algorithm of the same name.
// code-gauge-allow functionNcss 45 -- Transcribes _pydecimal's algorithm of the same name.
export function squareRoot(self: Dec, context: DecimalContext): Dec {
  if (isSpecial(self)) {
    const nan = checkNans(self, undefined, context);
    if (nan) return nan;
    if (infinityKind(self) === 1) return self;
  }
  if (!isNonzero(self)) return fix(dec(self.sign, '0', Math.floor((self.exp as number) / 2)), context);
  if (self.sign === 1) return raiseCondition(context, 'InvalidOperation');
  const prec = context.prec + 1;
  const op = workRep(self);
  let e = op.exp >> 1;
  let c = op.int;
  let length: number;
  if (op.exp & 1) {
    c *= 10n;
    length = (self.int.length >> 1) + 1;
  } else {
    length = (self.int.length + 1) >> 1;
  }
  const shift = prec - length;
  let exact: boolean;
  if (shift >= 0) {
    c = multiply(c, tenTo(2 * shift));
    exact = true;
  } else {
    const divisor = tenTo(-2 * shift);
    exact = c % divisor === 0n;
    c /= divisor;
  }
  e -= shift;
  let n = tenTo(prec);
  for (;;) {
    const q = c / n;
    if (n <= q) break;
    n = (n + q) >> 1n;
  }
  exact = exact && n * n === c;
  if (exact) {
    n = shift >= 0 ? n / tenTo(shift) : n * tenTo(-shift);
    e += shift;
  } else if (n % 5n === 0n) {
    n += 1n;
  }
  return fix(dec(0, n.toString(), e), { ...context, rounding: 'ROUND_HALF_EVEN' });
}

// Comparison methods -------------------------------------------------------------------------------------------------

export function compareMethod(self: Dec, other: Dec, context: DecimalContext): Dec {
  if (isSpecial(self) || isSpecial(other)) {
    const nan = checkNans(self, other, context);
    if (nan) return nan;
  }
  const order = compareValues(self, other);
  return order === 0 ? ZERO : order < 0 ? NEGATIVE_ONE : ONE;
}

type Choice = (self: Dec, other: Dec) => number;

/** `max`, `min`, `max_mag`, and `min_mag`, which differ in how they order and which operand wins. */
// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes _pydecimal's algorithm of the same name.
export function choose(self: Dec, other: Dec, context: DecimalContext, order: Choice, wantLarger: boolean): Dec {
  if (isSpecial(self) || isSpecial(other)) {
    const selfNan = nanKind(self);
    const otherNan = nanKind(other);
    if (selfNan || otherNan) {
      if (otherNan === 1 && selfNan === 0) return fix(self, context);
      if (selfNan === 1 && otherNan === 0) return fix(other, context);
      return checkNans(self, other, context) as Dec;
    }
  }
  let comparison = order(self, other);
  if (comparison === 0) comparison = compareTotal(self, other);
  const larger = comparison === -1 ? other : self;
  const smaller = comparison === -1 ? self : other;
  return fix(wantLarger ? larger : smaller, context);
}

export const byValue: Choice = compareValues;
export const byMagnitude: Choice = (self, other) => compareValues(copyAbs(self), copyAbs(other));

/** `Decimal.compare_total`: -1, 0, or 1 in the total order of the specification. */
export function compareTotal(self: Dec, other: Dec): number {
  if (self.sign && !other.sign) return -1;
  if (!self.sign && other.sign) return 1;
  const flip = self.sign ? -1 : 1;
  const selfNan = nanKind(self);
  const otherNan = nanKind(other);
  if (selfNan || otherNan) return compareNans(self, other, flip);
  const order = compareValues(self, other);
  if (order !== 0) return order;
  if ((self.exp as number) < (other.exp as number)) return -flip;
  if ((self.exp as number) > (other.exp as number)) return flip;
  return 0;
}

function compareNans(self: Dec, other: Dec, flip: number): number {
  const selfNan = nanKind(self);
  const otherNan = nanKind(other);
  if (selfNan === otherNan) return comparePayloads(self.int, other.int) * flip;
  // A quiet NaN orders above a signaling one, and both above numbers.
  return selfNan === 1 || (selfNan === 2 && otherNan !== 1) ? flip : -flip;
}

function comparePayloads(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Other methods ------------------------------------------------------------------------------------------------------

export function logb(self: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, undefined, context);
  if (nan) return nan;
  if (infinityKind(self)) return signedInfinity(0);
  if (!isNonzero(self)) return raiseCondition(context, 'DivisionByZero', 1);
  return fix(fromInteger(BigInt(adjusted(self))), context);
}

export function fromInteger(value: bigint): Dec {
  return dec(value < 0n ? 1 : 0, digitsOf(value), 0);
}

/** The integer value of an operand that must be an integer with exponent 0 in `[-limit, limit]`, or undefined. */
function integerOperand(other: Dec, limit: number): number | undefined {
  if (other.exp !== 0) return undefined;
  const value = Number(truncatedInt(other as Dec & { exp: number }));
  return -limit <= value && value <= limit ? value : undefined;
}

export function scaleb(self: Dec, other: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, other, context);
  if (nan) return nan;
  const limit = 2 * (context.Emax + context.prec);
  const amount = integerOperand(other, limit);
  if (amount === undefined) return raiseCondition(context, 'InvalidOperation');
  if (infinityKind(self)) return self;
  return fix(dec(self.sign, self.int, (self.exp as number) + amount), context);
}

function paddedDigits(self: Dec, prec: number): string {
  const pad = prec - self.int.length;
  if (pad > 0) return '0'.repeat(pad) + self.int;
  return pad < 0 ? self.int.slice(-pad) : self.int;
}

export function rotateOrShift(self: Dec, other: Dec, context: DecimalContext, rotate: boolean): Dec {
  const nan = checkNans(self, other, context);
  if (nan) return nan;
  const amount = integerOperand(other, context.prec);
  if (amount === undefined) return raiseCondition(context, 'InvalidOperation');
  if (infinityKind(self)) return self;
  const digits = paddedDigits(self, context.prec);
  let result: string;
  if (rotate)
    result =
      digits.slice(amount < 0 ? digits.length + amount : amount) +
      digits.slice(0, amount < 0 ? digits.length + amount : amount);
  else if (amount < 0) result = digits.slice(0, amount);
  else result = (digits + '0'.repeat(amount)).slice(-context.prec);
  return dec(self.sign, result.replace(/^0+/, '') || '0', self.exp);
}

function isLogical(value: Dec): boolean {
  return value.sign === 0 && value.exp === 0 && /^[01]+$/.test(value.int);
}

export function logical(
  self: Dec,
  other: Dec,
  context: DecimalContext,
  operate: (a: number, b: number) => number
): Dec {
  if (!isLogical(self) || !isLogical(other)) return raiseCondition(context, 'InvalidOperation');
  const a = paddedDigits(self, context.prec);
  const b = paddedDigits(other, context.prec);
  let result = '';
  for (let index = 0; index < a.length; index++) result += String(operate(Number(a[index]), Number(b[index])));
  return dec(0, result.replace(/^0+/, '') || '0', 0);
}

export function logicalInvert(self: Dec, context: DecimalContext): Dec {
  return logical(self, dec(0, '1'.repeat(context.prec), 0), context, (a, b) => a ^ b);
}

export function nextValue(self: Dec, context: DecimalContext, up: boolean): Dec {
  const nan = checkNans(self, undefined, context);
  if (nan) return nan;
  const kind = infinityKind(self);
  if (kind === (up ? 1 : -1)) return self;
  if (kind) return dec(up ? 1 : 0, '9'.repeat(context.prec), etop(context));
  const quiet: DecimalContext = {
    ...context,
    rounding: up ? 'ROUND_CEILING' : 'ROUND_FLOOR',
    status: new Set(),
    traps: new Set(),
  };
  const rounded = fix(self, quiet);
  if (compareValues(rounded, self) !== 0) return rounded;
  const step = dec(0, '1', etiny(quiet) - 1);
  return up ? add(self, step, quiet) : subtract(self, step, quiet);
}

export function nextToward(self: Dec, other: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, other, context);
  if (nan) return nan;
  const comparison = compareValues(self, other);
  if (comparison === 0) return dec(other.sign, self.int, self.exp);
  const result = nextValue(self, context, comparison === -1);
  if (infinityKind(result)) {
    raiseCondition(context, 'Overflow', result.sign);
    raiseCondition(context, 'Inexact');
    raiseCondition(context, 'Rounded');
  } else if (adjusted(result) < context.Emin) {
    for (const condition of ['Underflow', 'Subnormal', 'Inexact', 'Rounded'] as const)
      raiseCondition(context, condition);
    if (!isNonzero(result)) raiseCondition(context, 'Clamped');
  }
  return result;
}

export function numberClass(self: Dec, context: DecimalContext): string {
  if (self.exp === 'N') return 'sNaN';
  if (self.exp === 'n') return 'NaN';
  const sign = self.sign ? '-' : '+';
  if (infinityKind(self)) return `${sign}Infinity`;
  if (!isNonzero(self)) return `${sign}Zero`;
  if (adjusted(self) < context.Emin) return `${sign}Subnormal`;
  return `${sign}Normal`;
}

export { bigOf, isFinite, isNan, NAN };
