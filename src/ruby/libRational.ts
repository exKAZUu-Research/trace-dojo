import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { formatFloat, rEquals, toFloat, toInt, tryImplicitConversion } from './conversions';
import { coreMethod, def } from './define';
import { floatDomainError, rubyError, typeError, zeroDivisionError } from './errors';
import { exceptionOption } from './exceptionOption';
import { exactDecimal } from './floatFormat';
import { bigintRatio } from './floatMath';
import { formatString } from './format';
import { digest } from './hashes';
import { chargeIntegerResult, integerBits, integerGcd } from './integerBudget';
import { callMethod, type Gen, invoke } from './interp';
import { advertisesPublicMethod } from './libMeta';
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

export function rationalToFloat(value: RObject): number {
  return toNumber(fractionOf(value));
}

export function addRationals(left: RObject, right: bigint | RObject): RObject {
  const a = fractionOf(left);
  const b = typeof right === 'bigint' ? { numerator: right, denominator: 1n } : fractionOf(right);
  return addFractions(a, b);
}

function addFractions(
  a: Pick<Fraction, 'numerator' | 'denominator'>,
  b: Pick<Fraction, 'numerator' | 'denominator'>
): RObject {
  return makeRational(
    boundedAdd(boundedMultiply(a.numerator, b.denominator), boundedMultiply(b.numerator, a.denominator)),
    boundedMultiply(a.denominator, b.denominator)
  );
}

function* arithmetic(self: RObject, other: Value, op: string): Gen {
  const a = fractionOf(self);
  if (isRubyFloat(other))
    return yield* invoke(coreMethod(rt().c.Float, op), toNumber(a), [other], undefined, undefined, true);
  const b = asFraction(other);
  if (!b) {
    const [left, right] = yield* coercePair(self, other);
    return yield* callMethod(left, op, [right], undefined, undefined, { fcall: true });
  }
  switch (op) {
    case '+': {
      return addFractions(a, b);
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
  const quotient = yield* callMethod(left, '/', [right], undefined, undefined, { fcall: true });
  return yield* callMethod(quotient, 'floor', [], undefined, undefined, { fcall: true });
}

function* numericModulo(left: Value, right: Value): Gen {
  const quotient = yield* callMethod(left, 'div', [right], undefined, undefined, { fcall: true });
  const product = yield* callMethod(right, '*', [quotient], undefined, undefined, { fcall: true });
  return yield* callMethod(left, '-', [product], undefined, undefined, { fcall: true });
}

function* numericRemainder(self: RObject, other: Value): Gen {
  const [left, right] = isA(other, rt().c.Numeric) ? [self, other] : yield* coercePair(self, other);
  const remainder = yield* callMethod(left, '%', [right], undefined, undefined, { fcall: true });
  if (yield* rEquals(remainder, 0n)) return remainder;
  const opposite =
    (truthy(yield* callMethod(left, '<', [0n], undefined, undefined, { fcall: true })) &&
      truthy(yield* callMethod(right, '>', [0n], undefined, undefined, { fcall: true }))) ||
    (truthy(yield* callMethod(left, '>', [0n], undefined, undefined, { fcall: true })) &&
      truthy(yield* callMethod(right, '<', [0n], undefined, undefined, { fcall: true })));
  if (!opposite) return remainder;
  if (isRubyFloat(right) && Math.abs(Number(right)) === Infinity) return left;
  return yield* callMethod(remainder, '-', [right], undefined, undefined, { fcall: true });
}

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
    return rationalIntegerPower(numerator, denominator, exponent);
  }
  if (isRubyFloat(exponent) || rationalPower) throw new UnsupportedFeatureError('Rational を含む Float の累乗');
  const [left, right] = yield* coercePair(self, exponent);
  return yield* callMethod(left, '**', [right], undefined, undefined, { fcall: true });
});

function rationalIntegerPower(numerator: bigint, denominator: bigint, exponent: bigint): RObject {
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
    return yield* callMethod(pair.items[0], '<=>', [pair.items[1]], undefined, undefined, { fcall: true });
  }
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1n : difference > 0n ? 1n : 0n;
});
def('Rational', '==', 1, function* (self: RObject, [other]) {
  if (isRubyFloat(other)) return toNumber(fractionOf(self)) === Number(other);
  const b = asFraction(other);
  if (b !== undefined)
    return b.numerator === fractionOf(self).numerator && b.denominator === fractionOf(self).denominator;
  return yield* rEquals(other, self);
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
def('Rational', 'abs2', 0, (self: RObject) => callMethod(self, '*', [self], undefined, undefined, { fcall: true }));
def('Rational', 'nonzero?', 0, function* (self: RObject) {
  return truthy(yield* callMethod(self, 'zero?', [], undefined, undefined, { fcall: true })) ? NIL : self;
});
def('Rational', 'infinite?', 0, () => NIL);
def('Rational', 'real?', 0, () => true);
def('Rational', 'real', 0, (self: RObject) => self);
def('Rational', 'imaginary', 0, () => 0n);
for (const name of ['to_c', 'rect', 'polar', 'arg', 'conj', 'i']) {
  def('Rational', name, [0, -1], () => {
    throw new UnsupportedFeatureError(`Rational#${name}（複素数）`);
  });
}
def('Rational', 'zero?', 0, (self: RObject) => rEquals(self, 0n));
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

function* convertRationalArguments(args: Value[], raise: boolean): Gen {
  if (args.includes(NIL)) {
    if (!raise) return NIL;
    throw typeError("can't convert nil into Rational");
  }
  const first = yield* normalizeRationalArgument(args[0], raise);
  if (first === undefined) return NIL;
  const second = args.length === 1 ? undefined : yield* normalizeRationalArgument(args[1], raise);
  if (args.length === 2 && second === undefined) return NIL;
  if (isRational(first) && (second === undefined || (yield* exactOne(second)))) return first;
  if (second === undefined) {
    if (typeof first === 'bigint') return makeRational(first, 1n);
    return raise ? yield* convertToRational(first, false) : ((yield* rescueRationalConversion(first)) ?? NIL);
  }
  return yield* convertRationalPair(first, second, raise);
}

// code-gauge-allow functionCognitiveComplexity 21 -- Native checked conversions, rescued exceptions and numeric division share ordered operands.
function* convertRationalPair(first: Value, second: Value, raise: boolean): Gen {
  if (!isA(first, rt().c.Numeric)) {
    const converted = raise ? yield* convertToRational(first, true) : yield* rescueRationalConversion(first);
    if (converted === undefined) return NIL;
    first = converted;
  }
  if (!isA(second, rt().c.Numeric)) {
    const converted = raise ? yield* convertToRational(second, true) : yield* rescueRationalConversion(second);
    if (converted === undefined) return NIL;
    second = converted;
  }
  if (
    isA(first, rt().c.Numeric) &&
    isA(second, rt().c.Numeric) &&
    (typeof first !== 'bigint' || typeof second !== 'bigint')
  ) {
    first = (yield* rescueRationalConversion(first)) ?? first;
    if (second === 1n) return first;
    if (typeof first === 'bigint')
      return yield* invoke(coreMethod(rt().c.Integer, '/'), first, [second], undefined, undefined, true);
    return yield* callMethod(first, '/', [second], undefined, undefined, { fcall: true });
  }
  if (typeof first !== 'bigint') throw typeError('not an integer');
  if (typeof second !== 'bigint') {
    if (!raise) return NIL;
    throw typeError('not an integer');
  }
  return makeRational(first, second);
}

function* normalizeRationalArgument(value: Value, raise: boolean): Gen<Value | undefined> {
  if (typeof value === 'bigint' || isRational(value)) return value;
  if (isRubyFloat(value)) return floatToRational(Number(value));
  if (value instanceof RString) return yield* rationalFromString(value, raise);
  if (!(yield* advertisesPublicMethod(value, 'to_r'))) {
    try {
      const converted = yield* tryImplicitConversion(value, 'to_int');
      if (typeof converted === 'bigint') return converted;
    } catch (error) {
      if (!(error instanceof RubyError)) throw error;
    }
  }
  return value;
}

function* convertToRational(value: Value, checked: boolean): Gen<RObject | typeof NIL> {
  if (isRational(value)) return value;
  const converted = yield* tryImplicitConversion(value, 'to_r');
  if (converted === undefined) {
    if (checked) return NIL;
    throw typeError(`can't convert ${realClassOf(value).name} into Rational`);
  }
  if (converted === NIL && checked) return NIL;
  if (isRational(converted)) return converted;
  throw typeError(
    `can't convert ${realClassOf(value).name} to Rational (${realClassOf(value).name}#to_r gives ${realClassOf(converted).name})`
  );
}

function* rescueRationalConversion(value: Value): Gen<RObject | undefined> {
  try {
    const result = yield* convertToRational(value, false);
    return result instanceof RObject ? result : undefined;
  } catch (error) {
    if (error instanceof RubyError) return undefined;
    throw error;
  }
}

function* exactOne(value: Value): Gen<boolean> {
  const fraction = asFraction(value);
  return fraction ? fraction.numerator === 1n && fraction.denominator === 1n : yield* rEquals(value, 1n);
}

function* rationalFromString(source: RString, raise: boolean): Gen<RObject | undefined> {
  const text = source.s.replaceAll(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
  const result = parseRationalText(text, true, raise);
  if (result || !raise) return result;
  const messageFormat = str('invalid value for convert(): %p');
  messageFormat.binary = true;
  throw rubyError(rt().c.ArgumentError, yield* formatString(messageFormat, [source]));
}

function parseRationalText(text: string, exact: boolean, raise = true): RObject | undefined {
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
  if (!raise && denominator.numerator === 0n) return undefined;
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
    return yield* convertRationalArguments(args, raise);
  },
  { visibility: 'private', keywords: true }
);
def('String', 'to_r', 0, function (self: RString) {
  return parseRationalText(self.s.replace(/^[ \t\n\r\f\v]+/, ''), false) ?? makeRational(0n, 1n);
});
