import { formatFloat, toFloat, toInt, toStr } from './conversions';
import { def } from './define';
import { argumentError, floatDomainError, typeError, zeroDivisionError } from './errors';
import { exactDecimal } from './floatFormat';
import { callMethod, type Gen } from './interp';
import { NIL, RArray, RObject, RString, type Value } from './objects';
import { rt, UnsupportedFeatureError } from './runtime';
import { arr, realClassOf, str } from './values';

/** A Rational's value in lowest terms, with a positive denominator. */
interface Fraction {
  numerator: bigint;
  denominator: bigint;
  hashKey(): string;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function makeRational(numerator: bigint, denominator: bigint): RObject {
  if (denominator === 0n) throw zeroDivisionError();
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator) || 1n;
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

function fractionOf(value: RObject): Fraction {
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
  return Number(fraction.numerator) / Number(fraction.denominator);
}

function* arithmetic(self: RObject, other: Value, op: string): Gen {
  const a = fractionOf(self);
  if (typeof other === 'number') return yield* callMethod(toNumber(a), op, [other]);
  const b = asFraction(other);
  if (!b) {
    if (other === NIL || other instanceof RString)
      throw typeError(`${other === NIL ? 'nil' : 'String'} can't be coerced into Rational`);
    const pair = yield* callMethod(other, 'coerce', [self]);
    if (!(pair instanceof RArray) || pair.items.length !== 2) throw typeError('coerce must return [x, y]');
    return yield* callMethod(pair.items[0], op, [pair.items[1]]);
  }
  switch (op) {
    case '+': {
      return makeRational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
    }
    case '-': {
      return makeRational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
    }
    case '*': {
      return makeRational(a.numerator * b.numerator, a.denominator * b.denominator);
    }
    default: {
      if (b.numerator === 0n) throw zeroDivisionError();
      return makeRational(a.numerator * b.denominator, a.denominator * b.numerator);
    }
  }
}

for (const op of ['+', '-', '*', '/', 'quo']) {
  def('Rational', op, 1, (self: RObject, [other]) => arithmetic(self, other, op === 'quo' ? '/' : op));
}
def('Rational', '**', 1, function* (self: RObject, [exponent]) {
  const { numerator, denominator } = fractionOf(self);
  if (typeof exponent === 'bigint') {
    if (exponent === 0n) return makeRational(1n, 1n);
    if (numerator === 0n) {
      if (exponent < 0n) throw zeroDivisionError();
      return makeRational(0n, 1n);
    }
    if (denominator === 1n && (numerator === 1n || numerator === -1n))
      return makeRational(numerator === -1n && exponent % 2n !== 0n ? -1n : 1n, 1n);
    const magnitude = exponent < 0n ? -exponent : exponent;
    const bits = [numerator, denominator]
      .map((value) => (value < 0n ? -value : value))
      .filter((value) => value > 1n)
      .reduce((total, value) => total + value.toString(2).length, 0);
    rt().spend(Math.ceil((bits * Number(magnitude)) / 256));
    if (exponent >= 0n) return makeRational(numerator ** exponent, denominator ** exponent);
    if (numerator === 0n) throw zeroDivisionError();
    return makeRational(denominator ** -exponent, numerator ** -exponent);
  }
  const power = yield* toFloat(exponent);
  if (numerator < 0n && !Number.isInteger(power)) throw new UnsupportedFeatureError('複素数（Rational の小数乗）');
  return toNumber(fractionOf(self)) ** power;
});
def('Rational', '-@', 0, (self: RObject) => makeRational(-fractionOf(self).numerator, fractionOf(self).denominator));
def('Rational', '<=>', 1, (self: RObject, [other]) => {
  const a = fractionOf(self);
  if (typeof other === 'number') {
    const x = toNumber(a);
    return x < other ? -1n : x > other ? 1n : 0n;
  }
  const b = asFraction(other);
  if (!b) return NIL;
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1n : difference > 0n ? 1n : 0n;
});
def('Rational', '==', 1, (self: RObject, [other]) => {
  if (typeof other === 'number') return toNumber(fractionOf(self)) === other;
  const b = asFraction(other);
  return (
    b !== undefined && b.numerator === fractionOf(self).numerator && b.denominator === fractionOf(self).denominator
  );
});
def('Rational', 'coerce', 1, (self: RObject, [other]) => {
  if (typeof other === 'bigint') return arr([makeRational(other, 1n), self]);
  if (typeof other === 'number') return arr([other, toNumber(fractionOf(self))]);
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
def('Rational', 'rationalize', [0, 1], (self: RObject, args) => {
  if (args.length > 0) throw new UnsupportedFeatureError('Rational#rationalize（許容誤差）');
  return self;
});
def('Rational', ['to_i', 'truncate'], 0, (self: RObject) => fractionOf(self).numerator / fractionOf(self).denominator);
def('Rational', 'hash', 0, (self: RObject) => fractionOf(self).numerator ^ fractionOf(self).denominator);
def(
  'Rational',
  'eql?',
  1,
  (self: RObject, [other]) =>
    isRational(other) &&
    fractionOf(other).numerator === fractionOf(self).numerator &&
    fractionOf(other).denominator === fractionOf(self).denominator
);
def('Rational', 'abs', 0, (self: RObject) => {
  const { numerator, denominator } = fractionOf(self);
  return makeRational(numerator < 0n ? -numerator : numerator, denominator);
});
def('Rational', 'zero?', 0, (self: RObject) => fractionOf(self).numerator === 0n);
def('Rational', 'positive?', 0, (self: RObject) => fractionOf(self).numerator > 0n);
def('Rational', 'negative?', 0, (self: RObject) => fractionOf(self).numerator < 0n);
def('Rational', 'integer?', 0, () => false);

function floorDivide(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

function* roundTo(self: RObject, args: Value[], mode: 'floor' | 'ceil' | 'round'): Gen {
  const { numerator, denominator } = fractionOf(self);
  const digits = args.length > 0 ? yield* toInt(args[0]) : 0n;
  const scale = 10n ** (digits < 0n ? -digits : digits);
  const n = digits >= 0n ? numerator * scale : numerator;
  const d = digits >= 0n ? denominator : denominator * scale;
  let result: bigint;
  if (mode === 'floor') result = floorDivide(n, d);
  else if (mode === 'ceil') result = -floorDivide(-n, d);
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
def('Rational', 'round', [0, 1], (self: RObject, args) => roundTo(self, args, 'round'));

def('Integer', 'to_r', 0, (self: bigint) => makeRational(self, 1n));
def('Integer', 'rationalize', [0, 1], (self: bigint) => makeRational(self, 1n));
def('Integer', 'numerator', 0, (self) => self);
def('Integer', 'denominator', 0, () => 1n);
def('Integer', 'quo', 1, function* (self: bigint, [other]) {
  if (typeof other === 'number') return Number(self) / other;
  return yield* arithmetic(makeRational(self, 1n), other, '/');
});
def('Float', 'to_r', 0, (self: number) => floatToRational(self));
def('Float', 'rationalize', [0, 1], () => {
  throw new UnsupportedFeatureError('Float#rationalize（有理数）');
});

/** `Rational(...)`, which reads Integers, Rationals, Floats, and strings such as `"1/3"`. */
function* rationalOf(value: Value): Gen<RObject> {
  if (typeof value === 'bigint') return makeRational(value, 1n);
  if (typeof value === 'number') return floatToRational(value);
  if (isRational(value)) return value;
  const text = (yield* toStr(value)).trim().replaceAll('_', '');
  const match = /^([+-]?\d+)(?:\.(\d+))?(?:\/(\d+))?$/.exec(text);
  if (!match) throw argumentError(`invalid value for convert(): ${JSON.stringify(text)}`);
  const [, whole, fraction = '', denominator = '1'] = match;
  return makeRational(BigInt(whole + fraction), 10n ** BigInt(fraction.length) * BigInt(denominator));
}

def(
  'Kernel',
  'Rational',
  [1, 2],
  function* (_self, args) {
    const first = yield* rationalOf(args[0]);
    if (args.length === 1) return first;
    return yield* arithmetic(first, yield* rationalOf(args[1]), '/');
  },
  { visibility: 'private' }
);
def('String', 'to_r', 0, function* (self: RString) {
  const match = /^\s*([+-]?\d[\d_]*(?:\.\d+)?(?:\/\d+)?)/.exec(self.s);
  return match ? yield* rationalOf(str(match[1])) : makeRational(0n, 1n);
});
