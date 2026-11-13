// code-gauge-allow-file fileNcss 508 -- Transcribes the methods of _pydecimal that belong together.
import { currentRuntime } from '../runtimeContext';
import { repeatText } from '../stringBuilder';
import { times } from './decimalArithmetic';
import { type DecimalContext, etiny } from './decimalContext';
import {
  adjusted,
  checkNans,
  compareValues,
  copyNegate,
  type Dec,
  dec,
  digitsOf,
  type FiniteDec,
  fix,
  INFINITY,
  infinityKind,
  isEven,
  isFinite,
  isInteger,
  isNonzero,
  isSpecial,
  multiply,
  NEGATIVE_INFINITY,
  ONE,
  raiseCondition,
  signedInfinity,
  tenTo,
  truncatedInt,
  ZERO,
} from './decimalNumber';

// Transcribes the power, exponential, and logarithm functions of `_pydecimal`, which round correctly.

const bitLength = (value: bigint): number => (value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length);
const decimalLength = (value: bigint): number => digitsOf(value).length;

function divNearest(a: bigint, b: bigint): bigint {
  const q = floorDiv(a, b);
  const r = a - q * b;
  return q + (2n * r + (q & 1n) > b ? 1n : 0n);
}

function floorDiv(a: bigint, b: bigint): bigint {
  const runtime = currentRuntime();
  runtime.chargeBigint(a, b);
  runtime.spend();
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function rshiftNearest(x: bigint, shift: number): bigint {
  const b = 1n << BigInt(shift);
  const q = x >> BigInt(shift);
  return q + (2n * (x & (b - 1n)) + (q & 1n) > b ? 1n : 0n);
}

function sqrtNearest(n: bigint, start: bigint): bigint {
  let a = start;
  let b = 0n;
  while (a !== b) {
    currentRuntime().spend();
    [b, a] = [a, (a - floorDiv(-n, a)) >> 1n];
  }
  return a;
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

/** An approximation of `M * log(x / M)`. */
function ilog(x: bigint, m: bigint, l = 8): bigint {
  let y = x - m;
  let r = 0;
  const bigL = BigInt(l);
  while ((r <= l && absolute(y) << (bigL - BigInt(r)) >= m) || (r > l && absolute(y) >> (BigInt(r) - bigL) >= m)) {
    y = divNearest(multiply(m, y) << 1n, m + sqrtNearest(multiply(m, m + rshiftNearest(y, r)), m));
    r += 1;
  }
  const t = -Math.floor((-10 * decimalLength(m)) / (3 * l));
  const yShift = rshiftNearest(y, r);
  let w = divNearest(m, BigInt(t));
  for (let k = t - 1; k > 0; k--) w = divNearest(m, BigInt(k)) - divNearest(multiply(yShift, w), m);
  return divNearest(multiply(w, y), m);
}

let log10Digits = '23025850929940456840179914546843642076011014886';

/** The first p + 1 digits of ln(10). */
function log10DigitsOf(p: number): bigint {
  if (p >= log10Digits.length) {
    let extra = 3;
    let digits: string;
    for (;;) {
      const m = tenTo(p + extra + 2);
      digits = divNearest(ilog(10n * m, m), 100n).toString();
      if (digits.slice(-extra) !== '0'.repeat(extra)) break;
      extra += 3;
    }
    log10Digits = digits.replace(/0+$/, '').slice(0, -1);
  }
  return BigInt(log10Digits.slice(0, p + 1));
}

function dlog10(coefficient: bigint, e: number, precision: number): bigint {
  const p = precision + 2;
  const l = decimalLength(coefficient);
  const f = e + l - (e + l >= 1 ? 1 : 0);
  let logD: bigint;
  let logTenPower: bigint;
  if (p > 0) {
    const m = tenTo(p);
    const k = e + p - f;
    const c = k >= 0 ? coefficient * tenTo(k) : divNearest(coefficient, tenTo(-k));
    logD = divNearest(ilog(c, m) * m, log10DigitsOf(p));
    logTenPower = BigInt(f) * m;
  } else {
    logD = 0n;
    logTenPower = divNearest(BigInt(f), tenTo(-p));
  }
  return divNearest(logTenPower + logD, 100n);
}

function dlog(coefficient: bigint, e: number, precision: number): bigint {
  const p = precision + 2;
  const l = decimalLength(coefficient);
  const f = e + l - (e + l >= 1 ? 1 : 0);
  let logD = 0n;
  if (p > 0) {
    const k = e + p - f;
    const c = k >= 0 ? coefficient * tenTo(k) : divNearest(coefficient, tenTo(-k));
    logD = ilog(c, tenTo(p));
  }
  let fLogTen = 0n;
  if (f) {
    const extra = String(Math.abs(f)).length - 1;
    if (p + extra >= 0) fLogTen = divNearest(BigInt(f) * log10DigitsOf(p + extra), tenTo(extra));
  }
  return divNearest(fLogTen + logD, 100n);
}

function iexp(x: bigint, m: bigint, l = 8): bigint {
  const r = bitLength((x << BigInt(l)) / m);
  const t = -Math.floor((-10 * decimalLength(m)) / (3 * l));
  let y = divNearest(x, BigInt(t));
  let mShift = m << BigInt(r);
  for (let i = t - 1; i > 0; i--) y = divNearest(multiply(x, mShift + y), mShift * BigInt(i));
  for (let k = r - 1; k >= 0; k--) {
    mShift = m << BigInt(k + 2);
    y = divNearest(multiply(y, y + mShift), mShift);
  }
  return m + y;
}

function dexp(c: bigint, e: number, precision: number): [bigint, number] {
  const p = precision + 2;
  const extra = Math.max(0, e + decimalLength(c) - 1);
  const q = p + extra;
  const shift = e + q;
  const cShift = shift >= 0 ? c * tenTo(shift) : floorDiv(c, tenTo(-shift));
  const divisor = log10DigitsOf(q);
  const quotient = floorDiv(cShift, divisor);
  const rest = divNearest(cShift - quotient * divisor, tenTo(extra));
  return [divNearest(iexp(rest, tenTo(p)), 1000n), Number(quotient) - p + 3];
}

function dpower(xc: bigint, xe: number, yc: bigint, ye: number, p: number): [bigint, number] {
  const b = decimalLength(yc) + ye;
  const lxc = dlog(xc, xe, p + b + 1);
  const shift = ye - b;
  const pc = shift >= 0 ? lxc * yc * tenTo(shift) : divNearest(lxc * yc, tenTo(-shift));
  if (pc === 0n) {
    if (decimalLength(xc) + xe >= 1 === yc > 0n) return [tenTo(p - 1) + 1n, 1 - p];
    return [tenTo(p) - 1n, -p];
  }
  const [coefficient, exp] = dexp(pc, -(p + 1), p + 1);
  return [divNearest(coefficient, 10n), exp + 1];
}

function log10LowerBound(c: bigint): number {
  const text = c.toString();
  const correction: Record<string, number> = { 1: 100, 2: 70, 3: 53, 4: 40, 5: 31, 6: 23, 7: 16, 8: 10, 9: 5 };
  return 100 * text.length - correction[text[0]];
}

/** Repeats a computation with more guard digits until its result rounds unambiguously to `p` digits. */
function untilUnambiguous(
  p: number,
  start: number,
  step: number,
  compute: (places: number) => bigint
): [bigint, number] {
  let places = start;
  for (;;) {
    currentRuntime().spend();
    const coefficient = compute(places);
    const magnitude = coefficient < 0n ? -coefficient : coefficient;
    const digits = decimalLength(magnitude) - p - 1;
    // Python computes a float modulus for a negative digit count, which leaves no remainder for an integer.
    if (digits >= 0 && magnitude % (5n * tenTo(digits)) !== 0n) return [coefficient, places];
    places += step;
  }
}

// exp, ln, and log10 -------------------------------------------------------------------------------------------------

// code-gauge-allow functionNcss 34 -- Transcribes _pydecimal's algorithm of the same name.
export function exponential(self: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, undefined, context);
  if (nan) return nan;
  if (infinityKind(self) === -1) return ZERO;
  if (!isNonzero(self)) return ONE;
  if (infinityKind(self) === 1) return self;
  const p = context.prec;
  const adj = adjusted(self);
  let result: Dec;
  if (self.sign === 0 && adj > String((context.Emax + 1) * 3).length) result = dec(0, '1', context.Emax + 1);
  else if (self.sign === 1 && adj > String((-etiny(context) + 1) * 3).length) result = dec(0, '1', etiny(context) - 1);
  else if (self.sign === 0 && adj < -p) result = dec(0, `1${repeatText('0', p - 1)}1`, -p);
  else if (self.sign === 1 && adj < -p - 1) result = dec(0, repeatText('9', p + 1), -p - 1);
  else {
    const c = self.sign ? -BigInt(self.int) : BigInt(self.int);
    const e = self.exp as number;
    let exp = 0;
    const [coefficient] = untilUnambiguous(p, 3, 3, (extra) => {
      const [value, valueExp] = dexp(c, e, p + extra);
      exp = valueExp;
      return value;
    });
    result = dec(0, coefficient.toString(), exp);
  }
  return fix(result, { ...context, rounding: 'ROUND_HALF_EVEN' });
}

function lnExpBound(self: FiniteDec): number {
  const adj = self.exp + self.int.length - 1;
  if (adj >= 1) return String(Math.floor((adj * 23) / 10)).length - 1;
  if (adj <= -2) return String(Math.floor(((-1 - adj) * 23) / 10)).length - 1;
  const c = BigInt(self.int);
  const e = self.exp;
  if (adj === 0) {
    const num = (c - tenTo(-e)).toString();
    const den = c.toString();
    return num.length - den.length - (num < den ? 1 : 0);
  }
  return e + (tenTo(-e) - c).toString().length - 1;
}

export function naturalLog(self: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, undefined, context);
  if (nan) return nan;
  if (!isNonzero(self)) return NEGATIVE_INFINITY;
  if (infinityKind(self) === 1) return INFINITY;
  if (compareValues(self, ONE) === 0) return ZERO;
  if (self.sign === 1) return raiseCondition(context, 'InvalidOperation');
  const p = context.prec;
  const c = BigInt(self.int);
  const e = self.exp as number;
  const [coefficient, places] = untilUnambiguous(p, p - lnExpBound(self as FiniteDec) + 2, 3, (count) =>
    dlog(c, e, count)
  );
  return fix(dec(coefficient < 0n ? 1 : 0, digitsOf(coefficient), -places), {
    ...context,
    rounding: 'ROUND_HALF_EVEN',
  });
}

function log10ExpBound(self: FiniteDec): number {
  const adj = self.exp + self.int.length - 1;
  if (adj >= 1) return String(adj).length - 1;
  if (adj <= -2) return String(-1 - adj).length - 1;
  const c = BigInt(self.int);
  const e = self.exp;
  if (adj === 0) {
    const num = (c - tenTo(-e)).toString();
    const den = (231n * c).toString();
    return num.length - den.length - (num < den ? 1 : 0) + 2;
  }
  const num = (tenTo(-e) - c).toString();
  return num.length + e - (num < '231' ? 1 : 0) - 1;
}

export function log10(self: Dec, context: DecimalContext): Dec {
  const nan = checkNans(self, undefined, context);
  if (nan) return nan;
  if (!isNonzero(self)) return NEGATIVE_INFINITY;
  if (infinityKind(self) === 1) return INFINITY;
  if (self.sign === 1) return raiseCondition(context, 'InvalidOperation');
  let result: Dec;
  if (/^10*$/.test(self.int)) {
    const value = (self.exp as number) + self.int.length - 1;
    result = dec(value < 0 ? 1 : 0, String(Math.abs(value)), 0);
  } else {
    const p = context.prec;
    const c = BigInt(self.int);
    const e = self.exp as number;
    const start = p - log10ExpBound(self as FiniteDec) + 2;
    const [coefficient, places] = untilUnambiguous(p, start, 3, (count) => dlog10(c, e, count));
    result = dec(coefficient < 0n ? 1 : 0, digitsOf(coefficient), -places);
  }
  return fix(result, { ...context, rounding: 'ROUND_HALF_EVEN' });
}

// Power --------------------------------------------------------------------------------------------------------------

/** `Decimal.__pow__` without a modulus. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes _pydecimal's algorithm of the same name.
export function power(base: Dec, other: Dec, context: DecimalContext): Dec {
  const nan = checkNans(base, other, context);
  if (nan) return nan;
  if (!isNonzero(other)) return isNonzero(base) ? ONE : raiseCondition(context, 'InvalidOperation');
  let self = base;
  let resultSign: 0 | 1 = 0;
  if (self.sign === 1) {
    if (isInteger(other)) {
      if (!isEven(other)) resultSign = 1;
    } else if (isNonzero(self)) {
      return raiseCondition(context, 'InvalidOperation');
    }
    self = copyNegate(self);
  }
  if (!isNonzero(self)) return other.sign === 0 ? dec(resultSign, '0', 0) : signedInfinity(resultSign);
  if (infinityKind(self)) return other.sign === 0 ? signedInfinity(resultSign) : dec(resultSign, '0', 0);
  if (compareValues(self, ONE) === 0) return powerOfOne(self as FiniteDec, other, resultSign, context);
  const selfAdjusted = adjusted(self);
  if (infinityKind(other)) {
    return (other.sign === 0) === selfAdjusted < 0 ? dec(resultSign, '0', 0) : signedInfinity(resultSign);
  }
  return powerFinite(self as FiniteDec, other as FiniteDec, resultSign, context);
}

function powerOfOne(self: FiniteDec, other: Dec, resultSign: 0 | 1, context: DecimalContext): Dec {
  let exp: number;
  if (isInteger(other)) {
    let multiplier: number;
    if (other.sign === 1) multiplier = 0;
    else if (compareValues(other, dec(0, String(context.prec), 0)) > 0) multiplier = context.prec;
    else multiplier = Number(truncatedInt(other as FiniteDec));
    exp = self.exp * multiplier;
    if (exp < 1 - context.prec) {
      exp = 1 - context.prec;
      raiseCondition(context, 'Rounded');
    }
  } else {
    raiseCondition(context, 'Inexact');
    raiseCondition(context, 'Rounded');
    exp = 1 - context.prec;
  }
  return dec(resultSign, `1${repeatText('0', -exp)}`, exp);
}

// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes _pydecimal's algorithm of the same name.
function powerFinite(self: FiniteDec, other: FiniteDec, resultSign: 0 | 1, context: DecimalContext): Dec {
  let result: Dec | undefined;
  let exact = false;
  const bound = log10ExpBound(self) + adjusted(other);
  if (adjusted(self) >= 0 === (other.sign === 0)) {
    if (bound >= String(context.Emax).length) result = dec(resultSign, '1', context.Emax + 1);
  } else if (bound >= String(-etiny(context)).length) {
    result = dec(resultSign, '1', etiny(context) - 1);
  }
  if (result === undefined && !isInteger(other)) return powerReal(self, other, context);
  if (result === undefined) {
    const exactResult = powerExact(self, other, context.prec + 1);
    if (exactResult !== undefined) {
      result = resultSign === 1 ? dec(1, exactResult.int, exactResult.exp) : exactResult;
      exact = true;
    }
  }
  if (result === undefined) {
    const p = context.prec;
    const xc = BigInt(self.int);
    const yc = other.sign ? -BigInt(other.int) : BigInt(other.int);
    let exp = 0;
    const [coefficient] = untilUnambiguous(p, 3, 3, (extra) => {
      const [value, valueExp] = dpower(xc, self.exp, yc, other.exp, p + extra);
      exp = valueExp;
      return value;
    });
    result = dec(resultSign, coefficient.toString(), exp);
  }
  if (exact && !isInteger(other)) return fixInexactPower(result, context);
  return fix(result, context);
}

/**
 * A power with a non-integral exponent, computed as libmpdec does: exp(y * ln(x)) with guard digits, rounded once to
 * the context. Unlike `_pydecimal`, it does not detect exact results, which directed roundings can then round down.
 */
function powerReal(self: FiniteDec, other: FiniteDec, context: DecimalContext): Dec {
  const work: DecimalContext = {
    ...context,
    prec: Math.max(self.int.length, context.prec) + 4 + 19,
    rounding: 'ROUND_HALF_EVEN',
    Emin: -MAX_EXPONENT,
    Emax: MAX_EXPONENT,
    clamp: 0,
    status: new Set(),
    traps: new Set(),
  };
  let result = exponential(times(naturalLog(self, work), other, work), work);
  for (const condition of work.status)
    if (!['Inexact', 'Rounded', 'Subnormal', 'Underflow', 'Clamped'].includes(condition)) context.status.add(condition);
  raiseCondition(context, 'Inexact');
  raiseCondition(context, 'Rounded');
  if (isFinite(result) && compareValues(result, ONE) === 0)
    result = dec(0, `1${repeatText('0', context.prec - 1)}`, 1 - context.prec);
  if (infinityKind(result)) result = INFINITY;
  return fix(result, context);
}

const MAX_EXPONENT = Number(999_999_999_999_999_999n);

/** Rounds an exact power with a non-integral exponent, which the specification treats as inexact. */
function fixInexactPower(value: Dec, context: DecimalContext): Dec {
  let result = value;
  if (result.int.length <= context.prec) {
    const expDiff = context.prec + 1 - result.int.length;
    result = dec(result.sign, result.int + repeatText('0', expDiff), (result.exp as number) - expDiff);
  }
  const quiet: DecimalContext = { ...context, status: new Set(), traps: new Set() };
  result = fix(result, quiet);
  quiet.status.add('Inexact');
  if (quiet.status.has('Subnormal')) quiet.status.add('Underflow');
  if (quiet.status.has('Overflow')) raiseCondition(context, 'Overflow', result.sign);
  for (const condition of ['Underflow', 'Subnormal', 'Inexact', 'Rounded', 'Clamped'] as const) {
    if (quiet.status.has(condition)) raiseCondition(context, condition);
  }
  return result;
}

function stripTens(coefficient: bigint, exponent: number): [bigint, number] {
  let c = coefficient;
  let e = exponent;
  while (c % 10n === 0n) {
    c /= 10n;
    e += 1;
  }
  return [c, e];
}

function lshiftExact(n: bigint, e: number): bigint | undefined {
  if (n === 0n) return 0n;
  if (e >= 0) return n * tenTo(e);
  const text = digitsOf(n);
  const trailing = text.length - text.replace(/0+$/, '').length;
  return trailing < -e ? undefined : n / tenTo(-e);
}

/** The exact value of x ** y when it has at most p digits, or undefined, as `Decimal._power_exact` decides. */
// code-gauge-allow functionCognitiveComplexity 27 -- Transcribes _pydecimal's algorithm of the same name.
// code-gauge-allow functionNcss 50 -- Transcribes _pydecimal's algorithm of the same name.
function powerExact(self: FiniteDec, other: FiniteDec, p: number): Dec | undefined {
  let [xc, xe] = stripTens(BigInt(self.int), self.exp);
  const [yc, ye] = stripTens(BigInt(other.int), other.exp);
  if (xc === 1n) return powerOfTenExact(self, other, xe, yc, ye, p);
  if (other.sign === 1) return negativePowerExact(xc, xe, yc, ye, p);
  let m: bigint;
  let n: bigint;
  let xcBits = 0;
  if (ye >= 0) {
    m = yc * tenTo(ye);
    n = 1n;
  } else {
    if (xe !== 0 && digitsOf(yc * BigInt(xe)).length <= -ye) return undefined;
    xcBits = bitLength(xc);
    if (digitsOf(yc * BigInt(xcBits)).length <= -ye) return undefined;
    m = yc;
    n = tenTo(-ye);
    while (m % 2n === 0n && n % 2n === 0n) {
      m /= 2n;
      n /= 2n;
    }
    while (m % 5n === 0n && n % 5n === 0n) {
      m /= 5n;
      n /= 5n;
    }
  }
  if (n > 1n) {
    if (BigInt(xcBits) <= n) return undefined;
    if (BigInt(xe) % n !== 0n) return undefined;
    xe = Number(BigInt(xe) / n);
    const root = integerRoot(xc, n);
    if (root === undefined) return undefined;
    xc = root;
  }
  if (xc > 1n && m > BigInt(Math.floor((p * 100) / log10LowerBound(xc)))) return undefined;
  currentRuntime().chargeBits(BigInt(bitLength(xc)) * m);
  xc **= m;
  xe *= Number(m);
  const text = xc.toString();
  if (text.length > p) return undefined;
  let zeros = 0;
  if (isInteger(other) && other.sign === 0) {
    const ideal = self.exp * Number(truncatedInt(other));
    zeros = Math.min(xe - ideal, p - text.length);
  }
  return dec(0, text + repeatText('0', Math.max(zeros, 0)), xe - zeros);
}

function integerRoot(xc: bigint, n: bigint): bigint | undefined {
  let a = 1n << BigInt(-Math.floor(-bitLength(xc) / Number(n)));
  let q: bigint;
  let r: bigint;
  for (;;) {
    currentRuntime().chargeBits(BigInt(bitLength(a)) * n);
    const divisor = a ** (n - 1n);
    q = xc / divisor;
    r = xc % divisor;
    if (a <= q) break;
    a = (a * (n - 1n) + q) / n;
  }
  return a === q && r === 0n ? a : undefined;
}

function powerOfTenExact(
  self: FiniteDec,
  other: FiniteDec,
  base: number,
  yc: bigint,
  yExp: number,
  p: number
): Dec | undefined {
  let xe = BigInt(base) * yc;
  let ye = yExp;
  while (xe % 10n === 0n && xe !== 0n) {
    xe /= 10n;
    ye += 1;
  }
  if (ye < 0) return undefined;
  let exponent = Number(xe * tenTo(ye));
  if (other.sign === 1) exponent = -exponent;
  let zeros = 0;
  if (isInteger(other) && other.sign === 0) {
    const ideal = self.exp * Number(truncatedInt(other));
    zeros = Math.min(exponent - ideal, p - 1);
  }
  return dec(0, `1${repeatText('0', Math.max(zeros, 0))}`, exponent - zeros);
}

// code-gauge-allow functionCognitiveComplexity 20 -- Transcribes _pydecimal's algorithm of the same name.
// code-gauge-allow functionNcss 42 -- Transcribes _pydecimal's algorithm of the same name.
function negativePowerExact(base: bigint, baseExp: number, yc: bigint, ye: number, p: number): Dec | undefined {
  let xc = base;
  const lastDigit = Number(xc % 10n);
  let e: number;
  let xe: bigint | undefined;
  if ([2, 4, 6, 8].includes(lastDigit)) {
    if ((xc & -xc) !== xc) return undefined;
    const emax = Math.floor((p * 93) / 65);
    if (ye >= String(emax).length) return undefined;
    const shifted = lshiftExact(BigInt(bitLength(xc) - 1) * yc, ye);
    xe = lshiftExact(BigInt(baseExp) * yc, ye);
    if (shifted === undefined || xe === undefined || shifted > BigInt(emax)) return undefined;
    e = Number(shifted);
    xc = 5n ** BigInt(e);
  } else if (lastDigit === 5) {
    e = Math.floor((bitLength(xc) * 28) / 65);
    const power5 = 5n ** BigInt(e);
    if (power5 % xc !== 0n) return undefined;
    xc = power5 / xc;
    while (xc % 5n === 0n) {
      xc /= 5n;
      e -= 1;
    }
    const emax = Math.floor((p * 10) / 3);
    if (ye >= String(emax).length) return undefined;
    const shifted = lshiftExact(BigInt(e) * yc, ye);
    xe = lshiftExact(BigInt(baseExp) * yc, ye);
    if (shifted === undefined || xe === undefined || shifted > BigInt(emax)) return undefined;
    e = Number(shifted);
    xc = 2n ** BigInt(e);
  } else {
    return undefined;
  }
  const text = xc.toString();
  if (text.length > p) return undefined;
  return dec(0, text, -e - Number(xe));
}

/** `pow(self, other, modulo)`. */
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes _pydecimal's algorithm of the same name.
export function powerModulo(self: Dec, other: Dec, modulo: Dec, context: DecimalContext): Dec {
  const kinds = [self, other, modulo].map((value) =>
    isSpecial(value) ? (value.exp === 'N' ? 2 : value.exp === 'n' ? 1 : 0) : 0
  );
  if (kinds.some(Boolean)) {
    const signaling = [self, other, modulo].find((_, index) => kinds[index] === 2);
    if (signaling) return raiseCondition(context, 'InvalidOperation', signaling);
    const quiet = [self, other, modulo].find((_, index) => kinds[index] === 1) as Dec;
    return checkNans(quiet, undefined, context) as Dec;
  }
  if (!isInteger(self) || !isInteger(other) || !isInteger(modulo)) return raiseCondition(context, 'InvalidOperation');
  if (other.sign === 1 && isNonzero(other)) return raiseCondition(context, 'InvalidOperation');
  if (!isNonzero(modulo)) return raiseCondition(context, 'InvalidOperation');
  if (adjusted(modulo) >= context.prec) return raiseCondition(context, 'InvalidOperation');
  if (!isNonzero(other) && !isNonzero(self)) return raiseCondition(context, 'InvalidOperation');
  const sign = isEven(other) ? 0 : self.sign;
  const m = truncatedInt(modulo as FiniteDec);
  const modulus = m < 0n ? -m : m;
  const baseValue = truncatedInt(self as FiniteDec);
  const exponent = truncatedInt(other as FiniteDec);
  let result = modularPower((baseValue < 0n ? -baseValue : baseValue) % modulus, exponent, modulus);
  result %= modulus;
  return dec(sign, result.toString(), 0);
}

function modularPower(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n % modulus;
  let square = base % modulus;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = multiply(result, square) % modulus;
    square = multiply(square, square) % modulus;
  }
  return result;
}
