import { sharedPythonClasses } from '../annotations';
import type { BinaryOperator } from '../ast';
import { pyRepr } from '../conversions';
import { hashInt } from '../hashing';
import { registerModule } from '../modules';
import { divmodFloat, exactBinary, floorDivInt, intToString, modInt, parseIntText } from '../numbers';
import { callValue, getAttribute, getAttributeOrUndefined } from '../objects';
import { binaryOp } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { strLength, strRepr } from '../strings';
import { gcd, toFloat, toInt } from '../typeNumbers';
import {
  classOf,
  complexClass,
  isInstanceOf,
  newTuple,
  None,
  NotImplemented,
  pyError,
  typeError,
  typeName,
  valueError,
} from '../types';
import { type Kwargs, PyClass, PyComplex, PyNumberInstance, PyTuple, type PyValue } from '../values';
import { noteSubclass } from './abc';
import { newDecimal, PyDecimal } from './decimal';
import { fromInteger } from './decimalArithmetic';
import { formatFractionValue } from './fractionFormat';
import { abcMetaClass, complexAbstractClass, integralClass, rationalClass, realClass } from './numbers';
import { bindArguments, defineProperty, defineSlot, pythonMethod } from './numberSupport';

/** A `fractions.Fraction`, always in lowest terms with a positive denominator. */
export class PyFraction extends PyNumberInstance {
  constructor(
    cls: PyClass,
    readonly numerator: bigint,
    readonly denominator: bigint
  ) {
    super(cls);
  }

  reprText(): string {
    return `${this.cls.name}(${this.numerator}, ${this.denominator})`;
  }
}

type Ratio = readonly [bigint, bigint];

export const fractionClass = new PyClass('Fraction', [rationalClass], abcMetaClass);
fractionClass.mro = [fractionClass, ...rationalClass.mro];
fractionClass.module = 'fractions';
fractionClass.isBaseType = true;
// CPython writes Fraction in Python, as a class without annotations that programs could change.
sharedPythonClasses.add(fractionClass);

const NEW_SIGNATURE = { qualified: 'Fraction.__new__', params: ['numerator', 'denominator'], required: 0 };

fractionClass.construct = (cls: PyClass, args: PyValue[], kwargs: Kwargs) => {
  const [numerator, denominator] = bindArguments(NEW_SIGNATURE, args, kwargs);
  return newFraction(cls, numerator ?? 0n, denominator ?? None);
};

/** Creates a fraction already in lowest terms, as `Fraction._from_coprime_ints` does. */
export function fromCoprime([numerator, denominator]: Ratio, cls: PyClass = fractionClass): PyFraction {
  return new PyFraction(cls, numerator, denominator);
}

/** `Fraction(numerator, denominator)`. */
// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes fractions.py.
function newFraction(cls: PyClass, numerator: PyValue, denominator: PyValue): PyFraction {
  if (denominator === None) {
    if (typeof numerator === 'bigint') return fromCoprime([numerator, 1n], cls);
    const ratio = rationalRatio(numerator);
    if (ratio) return fromCoprime(ratio, cls);
    if (typeof numerator === 'number') return fromCoprime(floatRatio(numerator), cls);
    const asRatio = numerator instanceof PyClass ? undefined : getAttributeOrUndefined(numerator, 'as_integer_ratio');
    if (asRatio !== undefined) return fromCoprime(pairOf(callValue(asRatio, [])), cls);
    if (typeof numerator === 'string') return normalized(parseFraction(numerator), cls);
    throw typeError('argument should be a string or a Rational instance or have the as_integer_ratio() method');
  }
  if (typeof numerator === 'bigint' && typeof denominator === 'bigint')
    return normalized([numerator, denominator], cls);
  const a = rationalRatio(numerator);
  const b = rationalRatio(denominator);
  if (!a || !b) throw typeError('both arguments should be Rational instances');
  return normalized([a[0] * b[1], b[0] * a[1]], cls);
}

function normalized([numerator, denominator]: Ratio, cls: PyClass = fractionClass): PyFraction {
  if (denominator === 0n) throw pyError('ZeroDivisionError', `Fraction(${intToString(numerator)}, 0)`);
  let divisor = gcd(numerator, denominator);
  if (denominator < 0n) divisor = -divisor;
  return fromCoprime([numerator / divisor, denominator / divisor], cls);
}

/** The numerator and denominator of an instance of `numbers.Rational`, or undefined for any other value. */
export function rationalRatio(value: PyValue): Ratio | undefined {
  if (typeof value === 'bigint') return [value, 1n];
  if (typeof value === 'boolean') return [value ? 1n : 0n, 1n];
  if (value instanceof PyFraction) return [value.numerator, value.denominator];
  if (!isInstanceOf(value, rationalClass)) return undefined;
  return [intOf(getAttribute(value, 'numerator')), intOf(getAttribute(value, 'denominator'))];
}

function intOf(value: PyValue): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  throw typeError(`'${typeName(value)}' object cannot be interpreted as an integer`);
}

function pairOf(value: PyValue): Ratio {
  if (!(value instanceof PyTuple) || value.items.length !== 2) throw typeError('cannot unpack non-iterable object');
  return [intOf(value.items[0]), intOf(value.items[1])];
}

/** `float.as_integer_ratio()`. */
export function floatRatio(value: number): Ratio {
  if (Number.isNaN(value)) throw valueError('cannot convert NaN to integer ratio');
  if (!Number.isFinite(value)) throw pyError('OverflowError', 'cannot convert Infinity to integer ratio');
  let { mantissa, exponent } = exactBinary(value);
  if (mantissa === 0n) return [0n, 1n];
  while (exponent < 0 && (mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent++;
  }
  return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}

const DIGITS = String.raw`\p{Nd}+(?:_\p{Nd}+)*`;
const RATIONAL_FORMAT = new RegExp(
  String.raw`^\s*([-+]?)(?=\p{Nd}|\.\p{Nd})(\p{Nd}*|${DIGITS})(?:(?:\s*/\s*(${DIGITS}))?|(?:\.(\p{Nd}*|${DIGITS}))?(?:E([-+]?${DIGITS}))?)\s*$`,
  'iu'
);

function parseFraction(text: string): Ratio {
  const match = RATIONAL_FORMAT.exec(text);
  if (!match) throw valueError(`Invalid literal for Fraction: ${strRepr(text)}`);
  const [, sign, num, denom, decimal, exp] = match;
  let numerator = parseDigits(num || '0');
  let denominator = 1n;
  if (denom) {
    denominator = parseDigits(denom);
  } else {
    if (decimal) {
      const digits = decimal.replaceAll('_', '');
      const scale = powerOfTen(BigInt(strLength(digits)));
      numerator = numerator * scale + parseDigits(digits);
      denominator *= scale;
    }
    if (exp) {
      const exponent = parseDigits(exp);
      if (exponent >= 0n) numerator *= powerOfTen(exponent);
      else denominator *= powerOfTen(-exponent);
    }
  }
  return [sign === '-' ? -numerator : numerator, denominator];
}

function parseDigits(text: string): bigint {
  return parseIntText(text, 10) as bigint;
}

function powerOfTen(exponent: bigint): bigint {
  currentRuntime().chargeBits(exponent * 4n);
  return 10n ** exponent;
}

function power(base: bigint, exponent: bigint): bigint {
  if (base === 0n || base === 1n || exponent === 0n) return exponent === 0n ? 1n : base;
  if (base === -1n) return exponent % 2n === 0n ? 1n : -1n;
  currentRuntime().chargeBits(BigInt((base < 0n ? -base : base).toString(2).length) * exponent);
  return base ** exponent;
}

function ratioOf(value: PyValue): Ratio {
  const fraction = value as PyFraction;
  return [fraction.numerator, fraction.denominator];
}

// Arithmetic ---------------------------------------------------------------------------------------------------------

function multiply(a: bigint, b: bigint): bigint {
  currentRuntime().chargeBigint(a, b);
  return a * b;
}

function add([na, da]: Ratio, [nb, db]: Ratio): PyValue {
  return normalized([multiply(na, db) + multiply(nb, da), multiply(da, db)]);
}

function subtract([na, da]: Ratio, [nb, db]: Ratio): PyValue {
  return normalized([multiply(na, db) - multiply(nb, da), multiply(da, db)]);
}

function times([na, da]: Ratio, [nb, db]: Ratio): PyValue {
  return normalized([multiply(na, nb), multiply(da, db)]);
}

function divide([na, da]: Ratio, [nb, db]: Ratio): PyValue {
  if (nb === 0n) throw pyError('ZeroDivisionError', `Fraction(${intToString(db)}, 0)`);
  return normalized([multiply(na, db), multiply(nb, da)]);
}

function floorDivide([na, da]: Ratio, [nb, db]: Ratio): PyValue {
  return floorDivInt(multiply(na, db), multiply(da, nb));
}

function divideWithRemainder([na, da]: Ratio, [nb, db]: Ratio): PyValue {
  const left = multiply(na, db);
  const right = multiply(da, nb);
  return newTuple([floorDivInt(left, right), normalized([modInt(left, right), multiply(da, db)])]);
}

function remainder([na, da]: Ratio, [nb, db]: Ratio): PyValue {
  return normalized([modInt(multiply(na, db), multiply(nb, da)), multiply(da, db)]);
}

type Monomorphic = (a: Ratio, b: Ratio) => PyValue;
type Fallback = (a: PyValue, b: PyValue) => PyValue;

const operatorFallback =
  (operator: BinaryOperator): Fallback =>
  (a, b) =>
    binaryOp(operator, a, b);

const divmodFallback: Fallback = (a, b) => newTuple(divmodFloat(a as number, b as number));

/** Defines `__name__` and `__rname__` as `Fraction._operator_fallbacks` does. */
// code-gauge-allow functionCognitiveComplexity 21 -- Transcribes fractions.py.
function defineOperator(name: string, monomorphic: Monomorphic, fallback: Fallback, handleComplex = true): void {
  defineSlot(fractionClass, `__${name}__`, (self, [other]) => {
    if (other instanceof PyFraction) return monomorphic(ratioOf(self), ratioOf(other));
    if (typeof other === 'bigint' || typeof other === 'boolean') return monomorphic(ratioOf(self), [BigInt(other), 1n]);
    if (typeof other === 'number') return fallback(toFloat(self), other);
    if (handleComplex && other instanceof PyComplex) return fallback(toFloat(self), other);
    return NotImplemented;
  });
  defineSlot(fractionClass, `__r${name}__`, (self, [other]) => {
    const ratio = rationalRatio(other);
    if (ratio) return monomorphic(ratio, ratioOf(self));
    if (typeof other === 'number' || isInstanceOf(other, realClass)) return fallback(toFloat(other), toFloat(self));
    if (handleComplex && isInstanceOf(other, complexAbstractClass)) {
      return fallback(other instanceof PyComplex ? other : callValue(complexClass, [other]), toFloat(self));
    }
    return NotImplemented;
  });
}

defineOperator('add', add, operatorFallback('+'));
defineOperator('sub', subtract, operatorFallback('-'));
defineOperator('mul', times, operatorFallback('*'));
defineOperator('truediv', divide, operatorFallback('/'));
defineOperator('floordiv', floorDivide, operatorFallback('//'), false);
defineOperator('divmod', divideWithRemainder, divmodFallback, false);
defineOperator('mod', remainder, operatorFallback('%'), false);

/** `a ** b` for a fraction `a`. */
function fractionPower(a: Ratio, b: PyValue): PyValue {
  const ratio = rationalRatio(b);
  if (ratio) {
    const [numerator, denominator] = ratio;
    if (denominator !== 1n) return binaryOp('**', toFloat(fromCoprime(a)), toFloat(b));
    if (numerator >= 0n) return fromCoprime([power(a[0], numerator), power(a[1], numerator)]);
    if (a[0] > 0n) return fromCoprime([power(a[1], -numerator), power(a[0], -numerator)]);
    if (a[0] === 0n) throw pyError('ZeroDivisionError', `Fraction(${intToString(power(a[1], -numerator))}, 0)`);
    return fromCoprime([power(-a[1], -numerator), power(-a[0], -numerator)]);
  }
  if (typeof b === 'number' || b instanceof PyComplex) return binaryOp('**', toFloat(fromCoprime(a)), b);
  return NotImplemented;
}

defineSlot(fractionClass, '__pow__', (self, [other, modulo]) => {
  if (modulo !== undefined && modulo !== None) return NotImplemented;
  return fractionPower(ratioOf(self), other);
});
defineSlot(fractionClass, '__rpow__', (self, [other, modulo]) => {
  if (modulo !== undefined && modulo !== None) return NotImplemented;
  const [numerator, denominator] = ratioOf(self);
  if (denominator === 1n && numerator >= 0n) return binaryOp('**', other, numerator);
  const ratio = rationalRatio(other);
  if (ratio) return fractionPower(ratioOf(normalized(ratio)), self);
  if (denominator === 1n) return binaryOp('**', other, numerator);
  return binaryOp('**', other, toFloat(self));
});

defineSlot(fractionClass, '__pos__', (self) => fromCoprime(ratioOf(self)));
defineSlot(fractionClass, '__neg__', (self) => {
  const [numerator, denominator] = ratioOf(self);
  return fromCoprime([-numerator, denominator]);
});
defineSlot(fractionClass, '__abs__', (self) => {
  const [numerator, denominator] = ratioOf(self);
  return fromCoprime([numerator < 0n ? -numerator : numerator, denominator]);
});

const truncate = ([numerator, denominator]: Ratio): bigint =>
  numerator < 0n ? -floorDivInt(-numerator, denominator) : numerator / denominator;

defineSlot(fractionClass, '__int__', (self) => truncate(ratioOf(self)));
defineSlot(fractionClass, '__trunc__', (self) => truncate(ratioOf(self)));
defineSlot(fractionClass, '__floor__', (self) => floorDivInt(...ratioOf(self)));
defineSlot(fractionClass, '__ceil__', (self) => -floorDivInt(-ratioOf(self)[0], ratioOf(self)[1]));

/** Rounds a ratio to the nearest integer, halves to even. */
export function roundHalfEven([numerator, denominator]: Ratio): bigint {
  const floor = floorDivInt(numerator, denominator);
  const twice = modInt(numerator, denominator) * 2n;
  if (twice < denominator) return floor;
  if (twice > denominator) return floor + 1n;
  return floor % 2n === 0n ? floor : floor + 1n;
}

pythonMethod(fractionClass, { params: ['ndigits'], required: 0 }, '__round__', (self, [ndigits]) => {
  if (ndigits === undefined || ndigits === None) return roundHalfEven(ratioOf(self));
  const digits = intOf(ndigits);
  const shift = powerOfTen(digits < 0n ? -digits : digits);
  const [numerator, denominator] = ratioOf(self);
  if (digits > 0n) return normalized([roundHalfEven([numerator * shift, denominator]), shift]);
  return normalized([roundHalfEven([numerator, denominator * shift]) * shift, 1n]);
});

// Comparisons and hashing --------------------------------------------------------------------------------------------

const HASH_MODULUS = (1n << 61n) - 1n;
const HASH_INF = 314_159n;

function modularPower(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let square = base % modulus;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * square) % modulus;
    square = (square * square) % modulus;
  }
  return result;
}

/** The hash of a rational number, which equals the hash of an equal int, float, or Decimal. */
export function hashRatio([numerator, denominator]: Ratio): bigint {
  const inverse = denominator % HASH_MODULUS === 0n ? 0n : modularPower(denominator, HASH_MODULUS - 2n, HASH_MODULUS);
  const magnitude = inverse === 0n ? HASH_INF : hashInt(hashInt(numerator < 0n ? -numerator : numerator) * inverse);
  const result = numerator >= 0n ? magnitude : -magnitude;
  return result === -1n ? -2n : result;
}

defineSlot(fractionClass, '__hash__', (self) => hashRatio(ratioOf(self)));

defineSlot(fractionClass, '__eq__', (self, [other]) => {
  const [numerator, denominator] = ratioOf(self);
  const ratio = rationalRatio(other);
  if (ratio) return numerator === ratio[0] && denominator === ratio[1];
  const real = other instanceof PyComplex && other.imag === 0 ? other.real : other;
  if (typeof real !== 'number') return NotImplemented;
  if (!Number.isFinite(real)) return false;
  const [n, d] = floatRatio(real);
  return numerator === n && denominator === d;
});

const COMPARISONS = {
  __lt__: (order: number) => order < 0,
  __gt__: (order: number) => order > 0,
  __le__: (order: number) => order <= 0,
  __ge__: (order: number) => order >= 0,
};

for (const [name, test] of Object.entries(COMPARISONS)) {
  defineSlot(fractionClass, name, (self, [other]) => {
    const [numerator, denominator] = ratioOf(self);
    let ratio = rationalRatio(other);
    if (!ratio && typeof other === 'number') {
      if (!Number.isFinite(other)) return Number.isNaN(other) ? false : test(other > 0 ? -1 : 1);
      ratio = floatRatio(other);
    }
    if (!ratio) return NotImplemented;
    const left = multiply(numerator, ratio[1]);
    const right = multiply(denominator, ratio[0]);
    return test(left < right ? -1 : left > right ? 1 : 0);
  });
}

defineSlot(fractionClass, '__bool__', (self) => ratioOf(self)[0] !== 0n);

// Other methods ------------------------------------------------------------------------------------------------------

defineSlot(fractionClass, '__repr__', (self) => {
  const [numerator, denominator] = ratioOf(self);
  return `${classOf(self).name}(${intToString(numerator)}, ${intToString(denominator)})`;
});
defineSlot(fractionClass, '__str__', (self) => {
  const [numerator, denominator] = ratioOf(self);
  return denominator === 1n ? intToString(numerator) : `${intToString(numerator)}/${intToString(denominator)}`;
});
pythonMethod(
  fractionClass,
  { params: ['format_spec'], required: 1, positionalOnly: true },
  '__format__',
  (self, [spec]) => {
    if (typeof spec !== 'string')
      throw typeError(`__format__() argument must be str, not ${typeName(spec as PyValue)}`);
    return formatFractionValue(ratioOf(self), spec, classOf(self).name);
  }
);

defineProperty(fractionClass, 'numerator', (self) => ratioOf(self)[0]);
defineProperty(fractionClass, 'denominator', (self) => ratioOf(self)[1]);
defineProperty(fractionClass, '_numerator', (self) => ratioOf(self)[0]);
defineProperty(fractionClass, '_denominator', (self) => ratioOf(self)[1]);
pythonMethod(fractionClass, { params: [], required: 0 }, 'is_integer', (self) => ratioOf(self)[1] === 1n);
pythonMethod(fractionClass, { params: [], required: 0 }, 'as_integer_ratio', (self) => newTuple(ratioOf(self)));
pythonMethod(fractionClass, { params: [], required: 0 }, '__copy__', (self) => self);
pythonMethod(fractionClass, { params: ['memo'], required: 1 }, '__deepcopy__', (self) => self);

pythonMethod(fractionClass, { params: ['max_denominator'], required: 0 }, 'limit_denominator', (self, [limit]) =>
  limitDenominator(ratioOf(self), limit ?? 1_000_000n)
);

function limitDenominator(ratio: Ratio, limitValue: PyValue): PyFraction {
  const limit = intOf(limitValue);
  if (limit < 1n) throw valueError('max_denominator should be at least 1');
  if (ratio[1] <= limit) return fromCoprime(ratio);
  let [p0, q0, p1, q1] = [0n, 1n, 1n, 0n];
  let [n, d] = ratio;
  for (;;) {
    currentRuntime().spend();
    const a = floorDivInt(n, d);
    const q2 = q0 + a * q1;
    if (q2 > limit) break;
    [p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2];
    [n, d] = [d, n - a * d];
  }
  const k = (limit - q0) / q1;
  if (2n * d * (q0 + k * q1) <= ratio[1]) return fromCoprime([p1, q1]);
  return fromCoprime([p0 + k * p1, q0 + k * q1]);
}

pythonMethod(
  fractionClass,
  { params: ['f'], required: 1 },
  'from_float',
  (cls, [value]) => {
    const target = cls as PyClass;
    if (typeof value === 'bigint' || typeof value === 'boolean') return newFraction(target, value, None);
    if (typeof value !== 'number') {
      throw typeError(
        `${target.name}.from_float() only takes floats, not ${pyRepr(value as PyValue)} (${classOf(value as PyValue).name})`
      );
    }
    return fromCoprime(floatRatio(value), target);
  },
  'class'
);

pythonMethod(
  fractionClass,
  { params: ['number'], required: 1 },
  'from_number',
  (cls, [value]) => {
    const target = cls as PyClass;
    const number = value as PyValue;
    const ratio = rationalRatio(number);
    if (ratio) return fromCoprime(ratio, target);
    if (typeof number === 'number') return fromCoprime(floatRatio(number), target);
    const asRatio = number instanceof PyClass ? undefined : getAttributeOrUndefined(number, 'as_integer_ratio');
    if (asRatio !== undefined) return fromCoprime(pairOf(callValue(asRatio, [])), target);
    throw typeError('argument should be a Rational instance or have the as_integer_ratio() method');
  },
  'class'
);

pythonMethod(
  fractionClass,
  { params: ['dec'], required: 1 },
  'from_decimal',
  (cls, [value]) => {
    const target = cls as PyClass;
    let decimal = value as PyValue;
    if (typeof decimal === 'bigint' || typeof decimal === 'boolean' || isInstanceOf(decimal, integralClass)) {
      decimal = newDecimal(fromInteger(toInt(decimal)));
    } else if (!(decimal instanceof PyDecimal)) {
      throw typeError(
        `${target.name}.from_decimal() only takes Decimals, not ${pyRepr(decimal)} (${classOf(decimal).name})`
      );
    }
    return fromCoprime(pairOf(callValue(getAttribute(decimal, 'as_integer_ratio'), [])), target);
  },
  'class'
);

registerModule('fractions', (runtime) => {
  noteSubclass(runtime, rationalClass, fractionClass);
  return new Map<string, PyValue>([['Fraction', fractionClass]]);
});
