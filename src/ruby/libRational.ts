import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { formatFloat, rEquals, toFloat, toInt, toStr, tryImplicitConversion } from './conversions';
import { def } from './define';
import { argumentError, floatDomainError, typeError, zeroDivisionError } from './errors';
import { exceptionOption } from './exceptionOption';
import { exactDecimal } from './floatFormat';
import { bigintRatio } from './floatMath';
import { floatPower } from './floatPower';
import { digest } from './hashes';
import { chargeIntegerResult, integerBits, integerGcd } from './integerBudget';
import { callMethod, type Gen } from './interp';
import { isRubyFloat, NIL, RArray, RObject, RString, RSymbol, type Value } from './objects';
import { rt, RubyError, UnsupportedFeatureError } from './runtime';
import { arr, isA, realClassOf, str, truthy } from './values';

/** A Rational's value in lowest terms, with a positive denominator. */
interface Fraction {
  numerator: bigint;
  denominator: bigint;
  hashKey(): string;
}

function boundedMultiply(left: bigint, right: bigint): bigint {
  const leftBits = integerBits(left);
  const rightBits = integerBits(right);
  chargeIntegerResult(leftBits + rightBits, (leftBits * rightBits) / 1024);
  return left * right;
}

function boundedAdd(left: bigint, right: bigint): bigint {
  const leftBits = integerBits(left);
  const rightBits = integerBits(right);
  chargeIntegerResult(Math.max(leftBits, rightBits) + 1, leftBits + rightBits);
  return left + right;
}

export function makeRational(numerator: bigint, denominator: bigint): RObject {
  if (denominator === 0n) throw zeroDivisionError();
  chargeIntegerResult(Math.max(integerBits(numerator), integerBits(denominator)), 0);
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = integerGcd(numerator, denominator) || 1n;
  const rational = new RObject(rt().c.Rational);
  const fraction: Fraction = {
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
    hashKey() {
      return `q${this.numerator}/${this.denominator}`;
    },
  };
  rational.data = fraction;
  rational.frozen = true;
  return rational;
}

export function isRational(value: Value): value is RObject {
  return value instanceof RObject && value.cls === rt().c.Rational;
}

export function fractionOf(value: RObject): Fraction {
  return value.data as Fraction;
}

/** A Float's exact value as a Rational, as `Float#to_r` gives it. */
export function floatToRational(value: number): RObject {
  if (!Number.isFinite(value)) throw floatDomainError(formatFloat(value));
  const { digits, scale } = exactDecimal(value);
  return makeRational(value < 0 ? -digits : digits, 10n ** BigInt(scale));
}

function asFraction(value: Value): { numerator: bigint; denominator: bigint } | undefined {
  if (typeof value === 'bigint') return { numerator: value, denominator: 1n };
  if (isRational(value)) return fractionOf(value);
  return undefined;
}

function toNumber(fraction: { numerator: bigint; denominator: bigint }): number {
  return bigintRatio(fraction.numerator, fraction.denominator);
}

function* arithmetic(self: RObject, other: Value, op: string): Gen {
  const a = fractionOf(self);
  if (isRubyFloat(other)) return yield* callMethod(toNumber(a), op, [other]);
  const b = asFraction(other);
  if (!b) {
    const [left, right] = yield* coercePair(self, other);
    return yield* callMethod(left, op, [right]);
  }
  switch (op) {
    case '+': {
      return makeRational(
        boundedAdd(boundedMultiply(a.numerator, b.denominator), boundedMultiply(b.numerator, a.denominator)),
        boundedMultiply(a.denominator, b.denominator)
      );
    }
    case '-': {
      return makeRational(
        boundedAdd(boundedMultiply(a.numerator, b.denominator), -boundedMultiply(b.numerator, a.denominator)),
        boundedMultiply(a.denominator, b.denominator)
      );
    }
    case '*': {
      return makeRational(boundedMultiply(a.numerator, b.numerator), boundedMultiply(a.denominator, b.denominator));
    }
    default: {
      if (b.numerator === 0n) throw zeroDivisionError();
      return makeRational(boundedMultiply(a.numerator, b.denominator), boundedMultiply(a.denominator, b.numerator));
    }
  }
}

// code-gauge-allow functionCognitiveComplexity 17 -- The ordered cases for exact Rational coercion and rounding share state; splitting them solely for the metric would hide their sequencing.
function* coercePair(self: RObject, other: Value): Gen<[Value, Value]> {
  const pair = yield* tryImplicitConversion(other, 'coerce', [self]);
  if (pair === undefined) {
    const name =
      other === NIL
        ? 'nil'
        : typeof other === 'boolean'
          ? String(other)
          : other instanceof RString
            ? 'String'
            : other instanceof RSymbol
              ? `:${other.name}`
              : realClassOf(other).name;
    throw typeError(`${name} can't be coerced into Rational`);
  }
  if (!(pair instanceof RArray) || pair.items.length !== 2) throw typeError('coerce must return [x, y]');
  return [pair.items[0], pair.items[1]];
}

for (const op of ['+', '-', '*', '/', 'quo']) {
  def('Rational', op, 1, (self: RObject, [other]) => arithmetic(self, other, op === 'quo' ? '/' : op));
}
for (const op of ['%', 'modulo', 'remainder', 'div', 'divmod', 'fdiv'] as const) {
  def('Rational', op, 1, (self: RObject, [other]) => rationalDivision(self, other, op));
}
def('Rational', 'finite?', 0, () => true);
def('Rational', 'step', [0, -1], () => {
  throw new UnsupportedFeatureError('Rational#step');
});

function* rationalDivision(
  self: RObject,
  other: Value,
  op: '%' | 'modulo' | 'remainder' | 'div' | 'divmod' | 'fdiv'
): Gen {
  if (op === 'fdiv') {
    const divisor = (yield* rEquals(other, 0n)) ? 0 : other;
    const divided = yield* arithmetic(self, divisor, '/');
    return isRational(divided) ? toNumber(fractionOf(divided)) : yield* toFloat(divided);
  }
  if (op === 'div') return yield* numericDiv(self, other);
  if (op === 'divmod') return arr([yield* numericDiv(self, other), yield* numericModulo(self, other)]);
  if (op === 'remainder') return yield* numericRemainder(self, other);
  return yield* numericModulo(self, other);
}

function* numericDiv(left: Value, right: Value): Gen {
  if (yield* rEquals(0n, right)) throw zeroDivisionError();
  const quotient = yield* callMethod(left, '/', [right]);
  return yield* callMethod(quotient, 'floor', []);
}

function* numericModulo(left: Value, right: Value): Gen {
  const quotient = yield* callMethod(left, 'div', [right]);
  const product = yield* callMethod(right, '*', [quotient]);
  return yield* callMethod(left, '-', [product]);
}

function* numericRemainder(self: RObject, other: Value): Gen {
  const [left, right] = isA(other, rt().c.Numeric) ? [self, other] : yield* coercePair(self, other);
  const remainder = yield* callMethod(left, '%', [right]);
  if (yield* rEquals(remainder, 0n)) return remainder;
  const opposite =
    (truthy(yield* callMethod(left, '<', [0n])) && truthy(yield* callMethod(right, '>', [0n]))) ||
    (truthy(yield* callMethod(left, '>', [0n])) && truthy(yield* callMethod(right, '<', [0n])));
  if (!opposite) return remainder;
  if (isRubyFloat(right) && Math.abs(Number(right)) === Infinity) return left;
  return yield* callMethod(remainder, '-', [right]);
}

// code-gauge-allow functionCognitiveComplexity 30 -- Exact powers, fractional domains and custom coercion retain Ruby numeric dispatch order.
def('Rational', '**', 1, function* (self: RObject, [exponent]) {
  const { numerator, denominator } = fractionOf(self);
  const rationalPower = isRational(exponent) ? fractionOf(exponent) : undefined;
  if (rationalPower?.denominator === 1n) exponent = rationalPower.numerator;
  const exactPower = typeof exponent === 'bigint' ? exponent : rationalPower?.numerator;
  if (exactPower !== undefined) {
    const identity = exactPowerIdentity(numerator, denominator, exactPower);
    if (identity) return identity;
  }
  if (typeof exponent === 'bigint') {
    if (denominator === 1n && numerator === -1n) return makeRational(exponent % 2n !== 0n ? -1n : 1n, 1n);
    const magnitude = exponent < 0n ? -exponent : exponent;
    const bits = [numerator, denominator]
      .map((value) => (value < 0n ? -value : value))
      .filter((value) => value > 1n)
      .reduce((total, value) => total + value.toString(2).length, 0);
    rt().spend(Math.ceil((bits * Number(magnitude)) / 256));
    if (exponent >= 0n) return makeRational(numerator ** exponent, denominator ** exponent);
    return makeRational(denominator ** -exponent, numerator ** -exponent);
  }
  if (!isRubyFloat(exponent) && !isRational(exponent)) {
    const [left, right] = yield* coercePair(self, exponent);
    return yield* callMethod(left, '**', [right]);
  }
  const power = yield* toFloat(exponent);
  if (numerator < 0n && (Number.isNaN(power) || (!Number.isInteger(power) && Number.isFinite(power))))
    throw new UnsupportedFeatureError('複素数（Rational の小数乗）');
  return floatPower(toNumber(fractionOf(self)), power);
});
function exactPowerIdentity(numerator: bigint, denominator: bigint, power: bigint): RObject | undefined {
  if (power === 0n || numerator === denominator) return makeRational(1n, 1n);
  if (numerator !== 0n) return undefined;
  if (power < 0n) throw zeroDivisionError();
  return makeRational(0n, 1n);
}

def('Rational', '-@', 0, (self: RObject) => makeRational(-fractionOf(self).numerator, fractionOf(self).denominator));
// code-gauge-allow functionCognitiveComplexity 18 -- The ordered cases for exact Rational coercion and rounding share state; splitting them solely for the metric would hide their sequencing.
def('Rational', '<=>', 1, function* (self: RObject, [other]) {
  const a = fractionOf(self);
  if (isRubyFloat(other)) {
    if (Number.isNaN(Number(other))) return NIL;
    const x = toNumber(a);
    return x < Number(other) ? -1n : x > Number(other) ? 1n : 0n;
  }
  const b = asFraction(other);
  if (!b) {
    const pair = yield* tryImplicitConversion(other, 'coerce', [self]);
    if (pair === undefined || pair === NIL) return NIL;
    if (!(pair instanceof RArray) || pair.items.length !== 2) throw typeError('coerce must return [x, y]');
    return yield* callMethod(pair.items[0], '<=>', [pair.items[1]]);
  }
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1n : difference > 0n ? 1n : 0n;
});
def('Rational', '==', 1, function* (self: RObject, [other]) {
  if (isRubyFloat(other)) return toNumber(fractionOf(self)) === Number(other);
  const b = asFraction(other);
  if (b !== undefined)
    return b.numerator === fractionOf(self).numerator && b.denominator === fractionOf(self).denominator;
  return yield* callMethod(other, '==', [self]);
});
def('Rational', 'coerce', 1, (self: RObject, [other]) => {
  if (isRational(other)) return arr([other, self]);
  if (typeof other === 'bigint') return arr([makeRational(other, 1n), self]);
  if (isRubyFloat(other)) return arr([other, toNumber(fractionOf(self))]);
  throw typeError(`${realClassOf(other).name} can't be coerced into Rational`);
});
def('Rational', 'numerator', 0, (self: RObject) => fractionOf(self).numerator);
def('Rational', 'denominator', 0, (self: RObject) => fractionOf(self).denominator);
def('Rational', 'to_s', 0, (self: RObject) => str(`${fractionOf(self).numerator}/${fractionOf(self).denominator}`));
def('Rational', 'inspect', 0, (self: RObject) =>
  str(`(${fractionOf(self).numerator}/${fractionOf(self).denominator})`)
);
def('Rational', 'to_f', 0, (self: RObject) => toNumber(fractionOf(self)));
def('Rational', 'to_r', 0, (self) => self);
def('NilClass', 'to_r', 0, () => makeRational(0n, 1n));
def('Rational', 'rationalize', [0, 1], (self: RObject, args) => {
  if (args.length > 0) throw new UnsupportedFeatureError('Rational#rationalize（許容誤差）');
  return self;
});
def('Rational', ['to_i', 'to_int'], 0, (self: RObject) => fractionOf(self).numerator / fractionOf(self).denominator);
def('Rational', 'truncate', [0, 1], (self: RObject, args) => roundTo(self, args, 'truncate'));
def('Rational', 'hash', 0, (self: RObject) => {
  const fraction = fractionOf(self);
  rt().spend(Math.ceil((integerBits(fraction.numerator) + integerBits(fraction.denominator)) / 64));
  return BigInt(`0x${digest(fraction.hashKey())}`);
});
def(
  'Rational',
  'eql?',
  1,
  (self: RObject, [other]) =>
    isRational(other) &&
    fractionOf(other).numerator === fractionOf(self).numerator &&
    fractionOf(other).denominator === fractionOf(self).denominator
);
def('Rational', ['abs', 'magnitude'], 0, (self: RObject) => {
  const { numerator, denominator } = fractionOf(self);
  return makeRational(numerator < 0n ? -numerator : numerator, denominator);
});
def('Rational', '+@', 0, (self: RObject) => self);
def('Rational', 'abs2', 0, (self: RObject) => arithmetic(self, self, '*'));
def('Rational', 'nonzero?', 0, (self: RObject) => (fractionOf(self).numerator === 0n ? NIL : self));
def('Rational', 'infinite?', 0, () => NIL);
def('Rational', 'real?', 0, () => true);
def('Rational', 'real', 0, (self: RObject) => self);
def('Rational', 'imaginary', 0, () => 0n);
for (const name of ['to_c', 'rect', 'polar', 'arg', 'conj', 'i']) {
  def('Rational', name, [0, -1], () => {
    throw new UnsupportedFeatureError(`Rational#${name}（複素数）`);
  });
}
def('Rational', 'zero?', 0, (self: RObject) => fractionOf(self).numerator === 0n);
def('Rational', 'positive?', 0, (self: RObject) => fractionOf(self).numerator > 0n);
def('Rational', 'negative?', 0, (self: RObject) => fractionOf(self).numerator < 0n);
def('Rational', 'integer?', 0, () => false);

function floorDivide(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

// code-gauge-allow functionCognitiveComplexity 16 -- The ordered cases for exact Rational coercion and rounding share state; splitting them solely for the metric would hide their sequencing.
function* roundTo(self: RObject, args: Value[], mode: 'floor' | 'ceil' | 'round' | 'truncate'): Gen {
  const { numerator, denominator } = fractionOf(self);
  const digits = args.length > 0 ? yield* toInt(args[0]) : 0n;
  chargePowerOfTen(digits < 0n ? -digits : digits);
  const scale = 10n ** (digits < 0n ? -digits : digits);
  const n = digits >= 0n ? numerator * scale : numerator;
  const d = digits >= 0n ? denominator : denominator * scale;
  let result: bigint;
  if (mode === 'floor') result = floorDivide(n, d);
  else if (mode === 'ceil') result = -floorDivide(-n, d);
  else if (mode === 'truncate') result = n / d;
  else {
    const twice = 2n * (n < 0n ? -n : n) + d;
    const magnitude = twice / (2n * d);
    result = n < 0n ? -magnitude : magnitude;
  }
  if (args.length === 0 || digits === 0n) return result;
  return digits > 0n ? makeRational(result, scale) : result * scale;
}

def('Rational', 'floor', [0, 1], (self: RObject, args) => roundTo(self, args, 'floor'));
def('Rational', 'ceil', [0, 1], (self: RObject, args) => roundTo(self, args, 'ceil'));
def(
  'Rational',
  'round',
  [0, 1],
  (self: RObject, args, _block, keywords) => {
    if (keywords) throw new UnsupportedFeatureError('Rational#round(half:)');
    return roundTo(self, args, 'round');
  },
  { keywords: true }
);

def('Integer', 'to_r', 0, (self: bigint) => makeRational(self, 1n));
def('Integer', 'rationalize', [0, 1], (self: bigint) => makeRational(self, 1n));
def('Integer', 'numerator', 0, (self) => self);
def('Integer', 'denominator', 0, () => 1n);
def('Float', 'to_r', 0, (self: number) => floatToRational(self));
def('Float', 'rationalize', [0, 1], () => {
  throw new UnsupportedFeatureError('Float#rationalize（有理数）');
});

function* rationalOf(value: Value, raise: boolean): Gen<RObject | undefined> {
  if (typeof value === 'bigint') return makeRational(value, 1n);
  if (isRubyFloat(value)) return floatToRational(Number(value));
  if (isRational(value)) return value;
  try {
    if (value === NIL) throw typeError("can't convert nil into Rational");
    if (!(value instanceof RString)) {
      const converted = yield* tryImplicitConversion(value, 'to_r');
      if (converted !== undefined) {
        if (isRational(converted)) return converted;
        throw typeError(
          `can't convert ${realClassOf(value).name} to Rational (${realClassOf(value).name}#to_r gives ${realClassOf(converted).name})`
        );
      }
    }
    const text = (yield* toStr(value)).replaceAll(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
    const result = parseRationalText(text, true);
    if (!result) throw argumentError(`invalid value for convert(): ${JSON.stringify(text)}`);
    return result;
  } catch (error) {
    if (!raise && error instanceof RubyError) return undefined;
    throw error;
  }
}

function parseRationalText(text: string, exact: boolean): RObject | undefined {
  const digits = String.raw`\d(?:_?\d)*`;
  const component = `(?:${digits}(?:\\.(?:${digits})?)?|\\.(?:${digits})?)`;
  const pattern = new RegExp(
    `^([+-]?)(${component})(?:(?<!\\.)[eE]([+-]?${digits}))?(?:/(${component})(?:(?<!\\.)[eE]([+-]?${digits}))?)?`
  );
  const match = pattern.exec(text);
  if (!match || (exact && match[0].length !== text.length)) return undefined;
  const [, sign, decimal, exponentText, denominatorDecimal, denominatorExponent] = match;
  const numerator = decimalComponent(sign, decimal, exponentText);
  const denominator = denominatorDecimal
    ? decimalComponent('', denominatorDecimal, denominatorExponent)
    : { numerator: 1n, denominator: 1n };
  return makeRational(numerator.numerator * denominator.denominator, numerator.denominator * denominator.numerator);
}

function decimalComponent(
  sign: string,
  decimal: string,
  exponentText: string | undefined
): { numerator: bigint; denominator: bigint } {
  const [whole, fraction = ''] = decimal.replaceAll('_', '').split('.');
  let numerator = BigInt(`${whole || '0'}${fraction}`);
  if (sign === '-') numerator = -numerator;
  const exponent = exponentText ? Number(exponentText.replaceAll('_', '')) : 0;
  if (!Number.isSafeInteger(exponent)) throw new ExecutionLimitError('operations');
  chargePowerOfTen(BigInt(Math.abs(exponent)));
  const scale = fraction.length - exponent;
  return {
    numerator: scale < 0 ? numerator * 10n ** BigInt(-scale) : numerator,
    denominator: scale > 0 ? 10n ** BigInt(scale) : 1n,
  };
}

function chargePowerOfTen(magnitude: bigint): void {
  if (magnitude > BigInt(LIMITS.maxOperations)) throw new ExecutionLimitError('operations');
  const digits = Number(magnitude);
  const estimatedWork = Math.ceil((digits * Math.log2(digits + 1)) / 64);
  if (estimatedWork > LIMITS.maxOperations) throw new ExecutionLimitError('operations');
  rt().spend(estimatedWork);
}

def(
  'Kernel',
  'Rational',
  [1, 2],
  function* (_self, args, _block, keywords) {
    const raise = yield* exceptionOption(keywords);
    const first = yield* rationalOf(args[0], raise);
    if (first === undefined) return NIL;
    if (args.length === 1) return first;
    const second = yield* rationalOf(args[1], raise);
    return second === undefined ? NIL : yield* arithmetic(first, second, '/');
  },
  { visibility: 'private', keywords: true }
);
def('String', 'to_r', 0, function (self: RString) {
  return parseRationalText(self.s.replace(/^[ \t\n\r\f\v]+/, ''), false) ?? makeRational(0n, 1n);
});
