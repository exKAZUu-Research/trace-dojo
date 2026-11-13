// code-gauge-allow-file fileNcss 679 -- The libNumeric module keeps one concern's cases together.
import {
  comparisonFailed,
  floatToInt,
  formatFloat,
  inspect,
  numericCompare,
  numericEquals,
  toFloat,
  toInt,
  toRubyInt,
  toStr,
} from './conversions';
import { def, sdef } from './define';
import { argumentError, floatDomainError, rangeError, rubyError, typeError, zeroDivisionError } from './errors';
import { roundFloatDigits, roundHalfAway } from './floatFormat';
import { floatFraction, floatStepCount, fusedMultiplyAdd } from './floatMath';
import { exactFloatPower } from './floatPower';
import { callBlock, callMethod, type Gen, respondsTo } from './interp';
import { makeEnumerator, sizedEnumerator } from './libEnumerator';
import { NIL, RArray, type RHash, type RProc, RString, RSymbol, type Value } from './objects';
import { rt, RubyError, UnsupportedFeatureError } from './runtime';
import { arr, realClassOf, str, truthy } from './values';

type Num = bigint | number;

function isNum(value: Value): value is Num {
  return typeof value === 'bigint' || typeof value === 'number';
}

/** The error for an operand that is not a number: "String can't be coerced into Integer". */
function coerceError(value: Value, into: string): unknown {
  const name = value === NIL ? 'nil' : value === true ? 'true' : value === false ? 'false' : realClassOf(value).name;
  return typeError(`${name} can't be coerced into ${into}`);
}

/** Applies an operator to a number and a value that is not one, through the value's `coerce`. */
function* coerceBinary(self: Num, other: Value, op: string, target?: string): Gen {
  if (respondsTo(other, 'coerce')) {
    const pair = yield* callMethod(other, 'coerce', [self]);
    if (!(pair instanceof RArray) || pair.items.length !== 2) throw typeError('coerce must return [x, y]');
    return yield* callMethod(pair.items[0], op, [pair.items[1]]);
  }
  throw coerceError(other, target ?? (typeof self === 'bigint' ? 'Integer' : 'Float'));
}

function* coerceCompare(self: Num, other: Value, op: string): Gen {
  if (respondsTo(other, 'coerce')) {
    const pair = yield* callMethod(other, 'coerce', [self]);
    if (pair instanceof RArray && pair.items.length === 2) return yield* callMethod(pair.items[0], op, [pair.items[1]]);
  }
  throw comparisonFailed(self, other);
}

/** Floor division of integers, as Ruby's `/` rounds toward negative infinity. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw zeroDivisionError();
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

export function floorMod(a: bigint, b: bigint): bigint {
  if (b === 0n) throw zeroDivisionError();
  const remainder = a % b;
  return remainder !== 0n && remainder < 0n !== b < 0n ? remainder + b : remainder;
}

function floatMod(x: number, y: number): number {
  if (y === 0) throw zeroDivisionError();
  const remainder = x % y;
  if (y * remainder < 0) return remainder + y;
  return remainder;
}

/** Ruby's `flodivmod`: the quotient rounded from `(x - mod) / y` and the modulo with the divisor's sign. */
function floatDivmod(x: number, y: number): [number, number] {
  if (y === 0) throw zeroDivisionError();
  let mod = x === 0 || (!Number.isFinite(y) && Number.isFinite(x)) ? x : x % y;
  let div = !Number.isFinite(x) && Number.isFinite(y) ? x : roundHalfAway((x - mod) / y);
  if (y * mod < 0) {
    mod += y;
    div -= 1;
  }
  return [div, mod];
}

function intPow(base: bigint, exponent: bigint): Value {
  if (exponent < 0n) {
    if (base === 1n) return 1n;
    if (base === -1n) return exponent % 2n === 0n ? 1n : -1n;
    if (base === 0n) throw zeroDivisionError();
    throw new UnsupportedFeatureError('負の指数の累乗（結果が有理数になるもの）');
  }
  if (exponent === 0n) return 1n;
  if (base === 0n || base === 1n) return base;
  if (base === -1n) return exponent % 2n === 0n ? 1n : -1n;
  const bits = integerBits(base);
  if (base !== 0n && base !== 1n && base !== -1n && BigInt(bits) * exponent > 32_000_000n) {
    throw argumentError('exponent is too large');
  }
  rt().spend(Number((BigInt(bits) * exponent) / 4096n));
  return base ** exponent;
}

function integerBits(value: bigint): number {
  return (value < 0n ? -value : value).toString(2).length;
}

function chargeIntegerResult(bits: number, cost: number): void {
  if (bits > 32_000_000) throw argumentError('integer size too large');
  rt().spend(Math.ceil(cost / 4096));
}

function floatPow(base: number, exponent: number): Value {
  if (base < 0 && !Number.isInteger(exponent) && Number.isFinite(exponent)) {
    throw new UnsupportedFeatureError('負の数の小数乗（結果が複素数になるもの）');
  }
  return exactFloatPower(base, exponent) ?? base ** exponent;
}

// code-gauge-allow duplicateLines 18 -- Ruby integer and float arithmetic use matching operator cases with different numeric representations.
// code-gauge-allow functionNcss 31 -- Arithmetic dispatches Integer and Float operands across Ruby operators and zero-division rules.
function arithmetic(op: string, a: Num, b: Num): Value {
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    const bitsA = integerBits(a);
    const bitsB = integerBits(b);
    if (op === '+' || op === '-') chargeIntegerResult(Math.max(bitsA, bitsB) + 1, bitsA + bitsB);
    if (op === '*') chargeIntegerResult(bitsA + bitsB, (bitsA * bitsB) / 1024);
    switch (op) {
      case '+': {
        return a + b;
      }
      case '-': {
        return a - b;
      }
      case '*': {
        return a * b;
      }
      case '/': {
        return floorDiv(a, b);
      }
      case '%': {
        return floorMod(a, b);
      }
      case '**': {
        return intPow(a, b);
      }
    }
  }
  const x = Number(a);
  const y = Number(b);
  switch (op) {
    case '+': {
      return x + y;
    }
    case '-': {
      return x - y;
    }
    case '*': {
      return x * y;
    }
    case '/': {
      return x / y;
    }
    case '%': {
      return floatMod(x, y);
    }
    case '**': {
      return floatPow(x, y);
    }
  }
  throw new Error(`Unknown operator ${op}`);
}

for (const owner of ['Integer', 'Float']) {
  for (const op of ['+', '-', '*', '/', '%', '**']) {
    def(
      owner,
      op === '%' ? ['%', 'modulo'] : op === '**' ? ['**', 'pow'] : op,
      op === '**' ? [1, 2] : 1,
      function* (self: Num, args) {
        const [other] = args;
        if (op === '**' && args.length === 2) return yield* modPow(self, other, args[1]);
        if (isNum(other)) return arithmetic(op, self, other);
        return yield* coerceBinary(self, other, op);
      }
    );
  }
  def(owner, '-@', 0, (self: Num) => (typeof self === 'bigint' ? -self : -self));
  def(owner, '+@', 0, (self: Num) => self);
  def(owner, ['==', '==='], 1, function* (self: Num, [other]) {
    if (isNum(other)) return numericEquals(self, other);
    if (other === NIL || typeof other === 'boolean' || other instanceof RString || other instanceof RSymbol)
      return false;
    return truthy(yield* callMethod(other, '==', [self]));
  });
  def(owner, 'eql?', 1, (self: Num, [other]) => typeof self === typeof other && numericEquals(self, other as Num));
  def(
    owner,
    'equal?',
    1,
    (self: Num, [other]) =>
      typeof self === typeof other && (typeof self === 'number' ? Object.is(self, other) : self === other)
  );
  def(owner, '<=>', 1, function* (self: Num, [other]) {
    if (isNum(other)) {
      const order = numericCompare(self, other);
      return order === undefined ? NIL : BigInt(order);
    }
    if (respondsTo(other, 'coerce')) {
      const pair = yield* callMethod(other, 'coerce', [self]);
      if (pair instanceof RArray && pair.items.length === 2)
        return yield* callMethod(pair.items[0], '<=>', pair.items.slice(1));
    }
    return NIL;
  });
  for (const op of ['<', '<=', '>', '>=']) {
    def(owner, op, 1, function* (self: Num, [other]) {
      if (!isNum(other)) return yield* coerceCompare(self, other, op);
      const order = numericCompare(self, other);
      if (order === undefined) return false;
      return op === '<' ? order < 0 : op === '<=' ? order <= 0 : op === '>' ? order > 0 : order >= 0;
    });
  }
  def(owner, 'coerce', 1, function* (self: Num, [other]) {
    if (typeof self === 'bigint' && typeof other === 'bigint') return arr([other, self]);
    if (isNum(other)) return arr([Number(other), Number(self)]);
    if (other instanceof RString) {
      return arr([yield* kernelFloat(other, undefined), Number(self)]);
    }
    throw typeError(`can't convert ${other === NIL ? 'nil' : realClassOf(other).name} into Float`);
  });
  def(owner, 'divmod', 1, function* (self: Num, [other]) {
    if (!isNum(other)) return yield* coerceBinary(self, other, 'divmod');
    if (typeof self === 'bigint' && typeof other === 'bigint')
      return arr([floorDiv(self, other), floorMod(self, other)]);
    const [div, mod] = floatDivmod(Number(self), Number(other));
    return arr([floatToInt(div), mod]);
  });
  def(owner, 'div', 1, function* (self: Num, [other]) {
    if (!isNum(other)) return yield* coerceBinary(self, other, 'div');
    if (typeof self === 'bigint' && typeof other === 'bigint') return floorDiv(self, other);
    return floatToInt(floatDivmod(Number(self), Number(other))[0]);
  });
  def(owner, 'fdiv', 1, (self: Num, [other]) => {
    if (!isNum(other)) throw coerceError(other, typeof self === 'bigint' ? 'Integer' : 'Float');
    return Number(self) / Number(other);
  });
  def(owner, 'quo', 1, (self: Num, [other]) => {
    if (!isNum(other)) return coerceBinary(self, other, 'quo', typeof self === 'bigint' ? 'Rational' : 'Float');
    if (typeof self === 'bigint' && typeof other === 'bigint') {
      throw new UnsupportedFeatureError('Integer#quo（有理数）');
    }
    return Number(self) / Number(other);
  });
  def(owner, 'remainder', 1, (self: Num, [other]) => {
    if (!isNum(other)) throw coerceError(other, typeof self === 'bigint' ? 'Integer' : 'Float');
    if (typeof self === 'bigint' && typeof other === 'bigint') {
      if (other === 0n) throw zeroDivisionError();
      return self % other;
    }
    if (other === 0 || other === 0n) throw zeroDivisionError();
    return Number(self) % Number(other);
  });
  def(owner, ['abs', 'magnitude'], 0, (self: Num) =>
    typeof self === 'bigint' ? (self < 0n ? -self : self) : Math.abs(self)
  );
  def(owner, 'zero?', 0, (self: Num) => (typeof self === 'bigint' ? self === 0n : self === 0));
  def(owner, 'nonzero?', 0, (self: Num) => ((typeof self === 'bigint' ? self === 0n : self === 0) ? NIL : self));
  def(owner, 'positive?', 0, (self: Num) => (typeof self === 'bigint' ? self > 0n : self > 0));
  def(owner, 'negative?', 0, (self: Num) =>
    typeof self === 'bigint' ? self < 0n : self < 0 || (Object.is(self, -0) && false)
  );
  def(owner, 'integer?', 0, (self: Num) => typeof self === 'bigint');
  def(owner, 'finite?', 0, (self: Num) => typeof self === 'bigint' || Number.isFinite(self));
  def(owner, 'infinite?', 0, (self: Num) => {
    if (typeof self === 'bigint' || Number.isFinite(self) || Number.isNaN(self)) return NIL;
    return self > 0 ? 1n : -1n;
  });
  def(owner, 'to_f', 0, Number);
  def(owner, 'to_c', 0, () => {
    throw new UnsupportedFeatureError('to_c（複素数）');
  });
  def(owner, ['to_r', 'rationalize'], [0, 1], () => {
    throw new UnsupportedFeatureError('to_r（有理数）');
  });
  def(
    owner,
    'step',
    [0, 2],
    function* (self: Num, args, block, keywords) {
      return yield* numericStep(self, args, block, keywords);
    },
    { keywords: true }
  );
  def(owner, 'clone', [0, 1], (self) => self);
  def(owner, 'dup', 0, (self) => self);
}
def('Integer', 'ceildiv', 1, function* (self: bigint, [other]) {
  const quotient = yield* callMethod(-self, 'div', [other]);
  return typeof quotient === 'bigint' ? -quotient : -Number(quotient);
});

for (const owner of ['Integer', 'Float']) {
  def(owner, 'real?', 0, () => true);
  def(owner, 'real', 0, (self: Num) => self);
  def(owner, ['imag', 'imaginary'], 0, () => 0n);
  def(owner, 'i', 0, () => {
    throw new UnsupportedFeatureError('Numeric#i（複素数）');
  });
  def(owner, 'abs2', 0, (self: Num) => numericAbs2(self));
  def(owner, ['conj', 'conjugate'], 0, (self: Num) => self);
  def(owner, ['arg', 'angle', 'phase'], 0, (self: Num) => numericArg(self));
  def(owner, ['rect', 'rectangular'], 0, (self: Num) => arr([self, 0n]));
  def(owner, 'polar', 0, (self: Num) =>
    arr([typeof self === 'bigint' ? (self < 0n ? -self : self) : Math.abs(self), numericArg(self)])
  );
  def(owner, 'numerator', 0, (self: Num) => (typeof self === 'bigint' ? self : floatFraction(self).numerator));
  def(owner, 'denominator', 0, (self: Num) => (typeof self === 'bigint' ? 1n : floatFraction(self).denominator));
}

function numericArg(value: Num): Num {
  if (typeof value === 'bigint') return value < 0n ? Math.PI : 0n;
  if (Number.isNaN(value)) return Number.NaN;
  return value < 0 || Object.is(value, -0) ? Math.PI : 0n;
}

function numericAbs2(value: Num): Num {
  if (typeof value === 'number') return value * value;
  const bits = integerBits(value);
  chargeIntegerResult(2 * bits, (bits * bits) / 1024);
  return value * value;
}

function* modPow(self: Num, exponent: Value, modulus: Value): Gen {
  if (typeof self !== 'bigint' || typeof exponent !== 'bigint' || typeof modulus !== 'bigint') {
    throw typeError('Integer#pow() 2nd argument not allowed unless all arguments are integers');
  }
  if (exponent < 0n) throw rangeError('Integer#pow() 1st argument cannot be negative when 2nd argument specified');
  if (modulus === 0n) throw zeroDivisionError();
  let result = 1n;
  let base = floorMod(self, modulus);
  let power = exponent;
  while (power > 0n) {
    rt().spend();
    if (power & 1n) result = floorMod(result * base, modulus);
    base = floorMod(base * base, modulus);
    power >>= 1n;
  }
  return floorMod(result, modulus);
}

function* numericStep(self: Num, args: Value[], block: RProc | undefined, keywords: RHash | undefined): Gen {
  let [limit = NIL, step = 1n] = args;
  if (keywords) {
    for (const entry of keywords.map.values()) {
      const name = entry.key instanceof RSymbol ? entry.key.name : '';
      if (name === 'to') {
        if (args.length > 0) throw argumentError('to is given twice');
        limit = entry.value;
      } else if (name === 'by') {
        if (args.length > 1) throw argumentError('step is given twice');
        step = entry.value;
      } else throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
    }
  }
  if (!isNum(step)) throw typeError(`no implicit conversion of ${realClassOf(step).name} into Integer`);
  if (step === 0n || step === 0) {
    if (!block) throw argumentError("step can't be 0");
    throw argumentError("step can't be 0");
  }
  if (limit !== NIL && !isNum(limit)) throw comparisonFailed(self, limit);
  if (!block) return makeEnumerator(self, 'step', args, keywords);
  const useFloat = typeof self === 'number' || typeof limit === 'number' || typeof step === 'number';
  if (!useFloat) {
    const begin = self as bigint;
    const by = step as bigint;
    for (
      let value = begin;
      limit === NIL || (by > 0n ? value <= (limit as bigint) : value >= (limit as bigint));
      value += by
    ) {
      yield* callBlock(block, [value], false);
    }
    return self;
  }
  const begin = Number(self);
  const by = Number(step);
  const end = limit === NIL ? (by > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY) : Number(limit);
  const count = floatStepCount(begin, end, by);
  if (Number.isNaN(count)) throw floatDomainError('NaN');
  if (!Number.isFinite(count)) {
    for (let index = 0; ; index++) yield* callBlock(block, [fusedMultiplyAdd(index, by, begin)], false);
  }
  for (let index = 0; index < count; index++) {
    const value = fusedMultiplyAdd(index, by, begin);
    yield* callBlock(block, [by > 0 ? Math.min(value, end) : Math.max(value, end)], false);
  }
  return self;
}

// Integer -------------------------------------------------------------------------------------------------------------

def('Integer', ['to_s', 'inspect'], [0, 1], function* (self: bigint, args) {
  const base = args.length > 0 ? yield* toRubyInt(args[0]) : 10;
  if (base < 2 || base > 36) throw argumentError(`invalid radix ${base}`);
  rt().checkStringLength(Math.ceil(integerBits(self) / Math.log2(base)) + 1);
  return str(self.toString(base));
});
def('Integer', ['to_i', 'to_int'], 0, (self) => self);
def('Integer', 'hash', 0, (self: bigint) => self);
for (const [name, op] of [
  ['&', (a: bigint, b: bigint) => a & b],
  ['|', (a: bigint, b: bigint) => a | b],
  ['^', (a: bigint, b: bigint) => a ^ b],
] as const) {
  def('Integer', name, 1, function* (self: bigint, [other]) {
    if (typeof other === 'bigint') return op(self, other);
    if (typeof other === 'number') throw coerceError(other, 'Integer');
    return yield* coerceBinary(self, other, name);
  });
}
def('Integer', '~', 0, (self: bigint) => ~self);
def('Integer', '<<', 1, function* (self: bigint, [other]) {
  return shift(self, yield* toInt(other));
});
def('Integer', '>>', 1, function* (self: bigint, [other]) {
  return shift(self, -(yield* toInt(other)));
});

function shift(value: bigint, amount: bigint): bigint {
  if (value === 0n) return 0n;
  if (amount >= 0n) {
    if (amount > 32_000_000n) throw rangeError('shift width too big');
    chargeIntegerResult(integerBits(value) + Number(amount), integerBits(value) + Number(amount));
    return value << amount;
  }
  return value >> -amount;
}

def('Integer', '[]', 1, function* (self: bigint, [index]) {
  const bit = yield* toInt(index);
  if (bit < 0n) return 0n;
  return (self >> bit) & 1n;
});
def('Integer', 'times', 0, function* (self: bigint, _args, block) {
  if (!block) return sizedEnumerator(self, 'times', [], () => (self > 0n ? self : 0n));
  for (let index = 0n; index < self; index++) yield* callBlock(block, [index], false);
  return self;
});
def('Integer', 'upto', 1, function* (self: bigint, [limit], block) {
  if (!block) return makeEnumerator(self, 'upto', [limit]);
  if (typeof limit === 'number') {
    for (let index = self; (numericCompare(index, limit) ?? 1) <= 0; index++) yield* callBlock(block, [index], false);
    return self;
  }
  if (typeof limit !== 'bigint') throw comparisonFailed(self, limit);
  for (let index = self; index <= limit; index++) yield* callBlock(block, [index], false);
  return self;
});
def('Integer', 'downto', 1, function* (self: bigint, [limit], block) {
  if (!block) return makeEnumerator(self, 'downto', [limit]);
  if (typeof limit === 'number') {
    for (let index = self; (numericCompare(index, limit) ?? -1) >= 0; index--) yield* callBlock(block, [index], false);
    return self;
  }
  if (typeof limit !== 'bigint') throw comparisonFailed(self, limit);
  for (let index = self; index >= limit; index--) yield* callBlock(block, [index], false);
  return self;
});
def('Integer', ['succ', 'next'], 0, (self: bigint) => self + 1n);
def('Integer', 'pred', 0, (self: bigint) => self - 1n);
def('Integer', 'even?', 0, (self: bigint) => self % 2n === 0n);
def('Integer', 'odd?', 0, (self: bigint) => self % 2n !== 0n);
def('Integer', 'chr', [0, 1], (self: bigint, args) => {
  if (args.length > 0) throw new UnsupportedFeatureError('Integer#chr の文字コードの指定');
  if (self < 0n || self > 255n) throw rangeError(`${self} out of char range`);
  const char = str(String.fromCodePoint(Number(self)));
  char.binary = self > 127n;
  return char;
});
def('Integer', 'ord', 0, (self) => self);
def('Integer', 'size', 0, (self: bigint) => BigInt(Math.max(8, Math.ceil(integerBits(self) / 8))));
def('Integer', 'bit_length', 0, (self: bigint) => {
  const value = self < 0n ? -self - 1n : self;
  return value === 0n ? 0n : BigInt(value.toString(2).length);
});
def('Integer', 'digits', [0, 1], function* (self: bigint, args) {
  const base = args.length > 0 ? yield* toInt(args[0]) : 10n;
  if (base < 0n) throw argumentError('negative radix');
  if (base < 2n) throw argumentError(`invalid radix ${base}`);
  if (self < 0n) throw rubyError(rt().c['Math::DomainError'], 'out of domain');
  if (self === 0n) return arr([0n]);
  const digits: Value[] = [];
  for (let value = self; value > 0n; value /= base) {
    rt().spend();
    digits.push(value % base);
  }
  return arr(digits);
});
def('Integer', 'gcd', 1, (self: bigint, [other]) => {
  if (typeof other !== 'bigint') throw typeError('not an integer');
  return gcd(self, other);
});
def('Integer', 'lcm', 1, (self: bigint, [other]) => {
  if (typeof other !== 'bigint') throw typeError('not an integer');
  if (self === 0n || other === 0n) return 0n;
  const result = (self * other) / gcd(self, other);
  return result < 0n ? -result : result;
});
def('Integer', 'gcdlcm', 1, (self: bigint, [other]) => {
  if (typeof other !== 'bigint') throw typeError('not an integer');
  const divisor = gcd(self, other);
  const multiple = self === 0n || other === 0n ? 0n : (self * other) / divisor;
  return arr([divisor, multiple < 0n ? -multiple : multiple]);
});

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

def('Integer', ['allbits?'], 1, function* (self: bigint, [mask]) {
  const value = yield* toInt(mask);
  return (self & value) === value;
});
def('Integer', ['anybits?'], 1, function* (self: bigint, [mask]) {
  return (self & (yield* toInt(mask))) !== 0n;
});
def('Integer', ['nobits?'], 1, function* (self: bigint, [mask]) {
  return (self & (yield* toInt(mask))) === 0n;
});

function* roundingMode(keywords: RHash | undefined): Gen<'up' | 'even' | 'down'> {
  if (!keywords) return 'up';
  for (const entry of keywords.map.values()) {
    if (!(entry.key instanceof RSymbol) || entry.key.name !== 'half') {
      throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
    }
    const mode = entry.value;
    if (mode === NIL) return 'up';
    const name = mode instanceof RSymbol ? mode.name : mode instanceof RString ? mode.s : undefined;
    if (name === 'up' || name === 'even' || name === 'down') return name;
    throw argumentError(`invalid rounding mode: ${name ?? (yield* inspect(mode))}`);
  }
  return 'up';
}

// code-gauge-allow functionCognitiveComplexity 16 -- Integer rounding applies floor, ceil, truncate, and three half-tie policies to signed values.
function roundInteger(
  value: bigint,
  digits: bigint,
  mode: 'up' | 'even' | 'down' | 'floor' | 'ceil' | 'truncate'
): bigint {
  if (digits >= 0n) return value;
  if (digits < -9_223_372_036_854_775_807n) throw rangeError("bignum too big to convert into 'long'");
  const smallResult = roundedWithoutUnit(value, digits, mode);
  if (smallResult !== undefined) return smallResult;
  if (-digits > 32_000_000n) rt().spend(1_000_001);
  const unit = 10n ** -digits;
  const remainder = floorMod(value, unit);
  const down = value - remainder;
  switch (mode) {
    case 'floor': {
      return down;
    }
    case 'ceil': {
      return remainder === 0n ? value : down + unit;
    }
    case 'truncate': {
      return value < 0n && remainder !== 0n ? down + unit : down;
    }
  }
  const twice = remainder * 2n;
  if (twice < unit) return down;
  if (twice > unit) return down + unit;
  if (mode === 'even') return (down / unit) % 2n === 0n ? down : down + unit;
  if (mode === 'down') return value < 0n ? down + unit : down;
  return value < 0n ? down : down + unit;
}

function roundedWithoutUnit(value: bigint, digits: bigint, mode: string): bigint | undefined {
  if (value === 0n) return 0n;
  if (-digits <= BigInt((value < 0n ? -value : value).toString().length)) return undefined;
  if (mode === 'floor') return value > 0n ? 0n : undefined;
  if (mode === 'ceil') return value < 0n ? 0n : undefined;
  return 0n;
}

def(
  'Integer',
  'round',
  [0, 1],
  function* (self: bigint, args, _block, keywords) {
    const digits = args.length > 0 ? BigInt(yield* toRubyInt(args[0])) : 0n;
    return roundInteger(self, digits, yield* roundingMode(keywords));
  },
  { keywords: true }
);
for (const mode of ['floor', 'ceil', 'truncate'] as const) {
  def('Integer', mode, [0, 1], function* (self: bigint, args) {
    const digits = args.length > 0 ? BigInt(yield* toRubyInt(args[0])) : 0n;
    return roundInteger(self, digits, mode);
  });
}
sdef('Integer', 'sqrt', 1, function* (_self, [value]) {
  const n = yield* toInt(value);
  if (n < 0n) throw rubyError(rt().c['Math::DomainError'], 'Numerical argument is out of domain - "isqrt"');
  return isqrt(n);
});

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  const bits = integerBits(n);
  let estimate = 1n << BigInt(Math.ceil(bits / 2));
  for (;;) {
    rt().spend(Math.ceil(bits / 4096));
    const next = (estimate + n / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

// Float ---------------------------------------------------------------------------------------------------------------

def('Float', ['to_s', 'inspect'], 0, (self: number) => str(formatFloat(self)));
def('Float', 'hash', 0, (self: number) => {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, self === 0 ? 0 : self);
  return bits.getBigUint64(0);
});
def('Float', ['to_i', 'to_int'], 0, (self: number) => floatToInt(self));
def('Float', 'nan?', 0, (self: number) => Number.isNaN(self));
def('Float', 'next_float', 0, (self: number) => nextFloat(self, 1));
def('Float', 'prev_float', 0, (self: number) => nextFloat(self, -1));

function nextFloat(value: number, direction: number): number {
  if (Number.isNaN(value)) return value;
  if (!Number.isFinite(value) && Math.sign(value) === Math.sign(direction)) return value;
  if (value === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigInt64(0);
  view.setBigInt64(0, bits + BigInt((value > 0 ? 1 : -1) * direction));
  return view.getFloat64(0);
}

function checkFinite(value: number): void {
  if (Number.isNaN(value)) throw floatDomainError('NaN');
  if (!Number.isFinite(value)) throw floatDomainError(value > 0 ? 'Infinity' : '-Infinity');
}

def(
  'Float',
  'round',
  [0, 1],
  function* (self: number, args, _block, keywords) {
    const digits = args.length > 0 ? yield* toRubyInt(args[0]) : 0;
    const mode = yield* roundingMode(keywords);
    if (digits > 0) {
      if (!Number.isFinite(self)) return self;
      return roundFloatDigits(self, digits, mode);
    }
    checkFinite(self);
    if (digits === 0) {
      let rounded = roundHalfAway(self);
      if (Math.abs(self - Math.trunc(self)) === 0.5) {
        if (mode === 'even') rounded = 2 * Math.round(self / 2);
        else if (mode === 'down') rounded = Math.trunc(self);
      }
      return BigInt(rounded);
    }
    return roundInteger(floatToInt(self), BigInt(digits), mode);
  },
  { keywords: true }
);
def('Float', 'floor', [0, 1], function* (self: number, args) {
  const digits = args.length > 0 ? yield* toRubyInt(args[0]) : 0;
  if (digits > 0) return floorCeilDigits(self, digits, Math.floor);
  checkFinite(self);
  return roundInteger(BigInt(Math.floor(self)), BigInt(digits), 'floor');
});
def('Float', 'ceil', [0, 1], function* (self: number, args) {
  const digits = args.length > 0 ? yield* toRubyInt(args[0]) : 0;
  if (digits > 0) return floorCeilDigits(self, digits, Math.ceil);
  checkFinite(self);
  return roundInteger(BigInt(Math.ceil(self)), BigInt(digits), 'ceil');
});
def('Float', 'truncate', [0, 1], function* (self: number, args) {
  const digits = args.length > 0 ? yield* toRubyInt(args[0]) : 0;
  if (digits > 0) return floorCeilDigits(self, digits, self > 0 ? Math.floor : Math.ceil);
  checkFinite(self);
  return roundInteger(BigInt(Math.trunc(self)), BigInt(digits), 'truncate');
});

function floorCeilDigits(value: number, digits: number, rounding: (x: number) => number): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  if (!Number.isFinite(scale) || !Number.isFinite(value * scale)) return value;
  const scaled = rounding(value * scale);
  const isFloor = rounding === Math.floor;
  const candidate = (isFloor ? scaled + 1 : scaled - 1) / scale;
  if (isFloor ? candidate <= value : candidate >= value) return candidate;
  return scaled / scale;
}

// Kernel conversions --------------------------------------------------------------------------------------------------

function* exceptionOption(keywords: RHash | undefined): Gen<boolean> {
  if (!keywords) return true;
  for (const entry of keywords.map.values()) {
    if (entry.key instanceof RSymbol && entry.key.name === 'exception') return truthy(entry.value);
    throw argumentError(`unknown keyword: ${yield* inspect(entry.key)}`);
  }
  return true;
}

export function* kernelInteger(args: Value[], keywords: RHash | undefined): Gen {
  const raise = yield* exceptionOption(keywords);
  const [value, baseValue] = args;
  const base = baseValue === undefined ? undefined : yield* toRubyInt(baseValue);
  const invalidBase = base !== undefined && (base < 0 || (base !== 0 && (base < 2 || base > 36)));
  let parsedString = false;
  try {
    if (value instanceof RString) {
      parsedString = true;
      if (invalidBase) throw argumentError(`invalid radix ${base}`);
      return parseIntegerValue(value, base);
    }
    if (baseValue === undefined && typeof value === 'bigint') return value;
    if (baseValue === undefined && typeof value === 'number') return floatToInt(value);
    if (value === NIL && baseValue === undefined) throw typeError("can't convert nil into Integer");
    if (baseValue === undefined && respondsTo(value, 'to_int')) {
      const converted = yield* callMethod(value, 'to_int', []);
      if (typeof converted === 'bigint') return converted;
    }
    let convertedString: Value = NIL;
    if (respondsTo(value, 'to_str')) {
      convertedString = yield* callMethod(value, 'to_str', []);
      if (convertedString instanceof RString) {
        parsedString = true;
        if (invalidBase) throw argumentError(`invalid radix ${base}`);
        return parseIntegerValue(convertedString, base);
      }
    }
    if (baseValue !== undefined) {
      if (convertedString !== NIL) throw integerStringConversionError(value, convertedString);
      throw argumentError('base specified for non string value');
    }
    if (respondsTo(value, 'to_i')) {
      const converted = yield* callMethod(value, 'to_i', []);
      if (typeof converted === 'bigint') return converted;
      throw typeError(
        `can't convert ${realClassOf(value).name} to Integer (${realClassOf(value).name}#to_i gives ${realClassOf(converted).name})`
      );
    }
    if (convertedString !== NIL) throw integerStringConversionError(value, convertedString);
    throw typeError(`can't convert ${realClassOf(value).name} into Integer`);
  } catch (error) {
    if (!raise && !(parsedString && invalidBase) && error instanceof RubyError) return NIL;
    throw error;
  }
}

function parseIntegerValue(value: RString, base: number | undefined): bigint {
  const parsed = parseIntegerStrict(value.s, base);
  if (parsed === undefined) throw argumentError(`invalid value for Integer(): ${JSON.stringify(value.s)}`);
  return parsed;
}

function integerStringConversionError(value: Value, converted: Value): RubyError {
  const name = realClassOf(value).name;
  return typeError(`can't convert ${name} to String (${name}#to_str gives ${realClassOf(converted).name})`);
}

/** Parses an Integer as `Integer()` does: prefixes, underscores between digits, and surrounding blanks. */
// code-gauge-allow functionNcss 33 -- Strict Integer parsing validates radix prefixes, signs, underscores, and surrounding whitespace.
export function parseIntegerStrict(text: string, base?: number): bigint | undefined {
  if (base !== undefined && (base < 0 || (base !== 0 && (base < 2 || base > 36)))) {
    throw argumentError(`invalid radix ${base}`);
  }
  const match = /^[\t\n\v\f\r ]*([+-]?)(0[xXbBoOdD]?)?([\dA-Za-z]+(?:_[\dA-Za-z]+)*)[\t\n\v\f\r ]*$/.exec(text);
  if (!match) {
    if (/^[\t\n\v\f\r ]*[+-]?0[\t\n\v\f\r ]*$/.test(text)) return 0n;
    return undefined;
  }
  const [, sign, prefix = '', body] = match;
  let radix = base === undefined || base === 0 ? 10 : base;
  const lower = prefix.toLowerCase();
  if (lower === '0x') radix = check(16, base);
  else if (lower === '0b') radix = check(2, base);
  else if (lower === '0o') radix = check(8, base);
  else if (lower === '0d') radix = check(10, base);
  else if (lower === '0') radix = base === undefined || base === 0 ? 8 : base;
  if (radix === -1) return undefined;
  const digits = (lower === '0' && base !== undefined && base !== 0 && base !== 8 ? `0${body}` : body).replaceAll(
    '_',
    ''
  );
  const valid = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
  if (![...digits.toLowerCase()].every((char) => valid.includes(char))) return undefined;
  let result = 0n;
  let position = 0;
  for (const char of digits.toLowerCase()) {
    if (position++ % 64 === 0) rt().spend();
    result = result * BigInt(radix) + BigInt(valid.indexOf(char));
  }
  return sign === '-' ? -result : result;
}

function check(radix: number, base: number | undefined): number {
  return base === undefined || base === 0 || base === radix ? radix : -1;
}

export function* kernelFloat(value: Value, keywords: RHash | undefined): Gen {
  const raise = yield* exceptionOption(keywords);
  try {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof RString) {
      const parsed = parseFloatStrict(value.s);
      if (parsed === undefined) throw argumentError(`invalid value for Float(): ${JSON.stringify(value.s)}`);
      return parsed;
    }
    if (value === NIL) throw typeError("can't convert nil into Float");
    if (respondsTo(value, 'to_f')) {
      const converted = yield* callMethod(value, 'to_f', []);
      if (typeof converted === 'number') return converted;
      throw typeError(
        `can't convert ${realClassOf(value).name} to Float (${realClassOf(value).name}#to_f gives ${realClassOf(converted).name})`
      );
    }
    throw typeError(`can't convert ${realClassOf(value).name} into Float`);
  } catch (error) {
    if (!raise && error instanceof RubyError) return NIL;
    throw error;
  }
}

function parseFloatStrict(text: string): number | undefined {
  const trimmed = text.replaceAll(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
  if (/^[+-]?0[xX][\da-fA-F]+(?:_[\da-fA-F]+)*$/.test(trimmed)) return Number(parseIntegerStrict(trimmed));
  if (
    !/^[+-]?(?:\d+(?:_\d+)*)(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+(?:_\d+)*)?$/.test(trimmed) &&
    !/^[+-]?\.\d+(?:_\d+)*(?:[eE][+-]?\d+)?$/.test(trimmed)
  ) {
    return undefined;
  }
  return Number(trimmed.replaceAll('_', ''));
}

/** The leading number of a string, as `String#to_i` reads it: invalid text ends it, giving 0 when nothing came. */
// code-gauge-allow functionCognitiveComplexity 17 -- Lenient Integer parsing scans optional sign and radix prefix until the first invalid digit.
export function parseIntegerLenient(text: string, base = 10): bigint {
  let index = 0;
  while (index < text.length && /[\t\n\v\f\r ]/.test(text[index])) index++;
  let negative = false;
  if (text[index] === '+' || text[index] === '-') {
    negative = text[index] === '-';
    index++;
  }
  const prefix = text.slice(index, index + 2).toLowerCase();
  if (base === 0) {
    base = prefix === '0x' ? 16 : prefix === '0b' ? 2 : prefix === '0o' || text[index] === '0' ? 8 : 10;
  }
  const valid = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  if ((base === 16 && prefix === '0x') || (base === 2 && prefix === '0b') || (base === 8 && prefix === '0o')) {
    index += 2;
  }
  let result = 0n;
  let lastWasDigit = false;
  for (; index < text.length; index++) {
    if (index % 64 === 0) rt().spend();
    const char = text[index].toLowerCase();
    if (char === '_' && lastWasDigit && valid.includes(text[index + 1]?.toLowerCase() ?? '')) {
      lastWasDigit = false;
      continue;
    }
    const digit = valid.indexOf(char);
    if (digit === -1 || char === '') break;
    result = result * BigInt(base) + BigInt(digit);
    lastWasDigit = true;
  }
  return negative ? -result : result;
}

export function parseFloatLenient(text: string): number {
  const match = /^[\t\n\v\f\r ]*([+-]?(?:\d+(?:_\d+)*)?(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+(?:_\d+)*)?)/.exec(text);
  const body = match?.[1].replaceAll('_', '') ?? '';
  if (!/\d/.test(body)) {
    const leading = /^[\t\n\v\f\r ]*([+-]?\d+(?:_\d+)*)/.exec(text);
    return leading ? Number(leading[1].replaceAll('_', '')) : 0;
  }
  const value = Number(body.replace(/[eE][+-]?$/, ''));
  return Number.isNaN(value) ? 0 : value;
}

// Math ----------------------------------------------------------------------------------------------------------------

function domainCheck(name: string, valid: boolean): void {
  if (!valid) throw rubyError(rt().c['Math::DomainError'], `Numerical argument is out of domain - ${name}`);
}

const MATH_FUNCTIONS: [string, number, (...args: number[]) => number, ((...args: number[]) => boolean)?][] = [
  ['sqrt', 1, Math.sqrt, (x) => x >= 0 || Number.isNaN(x)],
  ['cbrt', 1, Math.cbrt],
  ['sin', 1, Math.sin],
  ['cos', 1, Math.cos],
  ['tan', 1, Math.tan],
  ['asin', 1, Math.asin, (x) => (x >= -1 && x <= 1) || Number.isNaN(x)],
  ['acos', 1, Math.acos, (x) => (x >= -1 && x <= 1) || Number.isNaN(x)],
  ['atan', 1, Math.atan],
  ['atan2', 2, Math.atan2],
  ['sinh', 1, Math.sinh],
  ['cosh', 1, Math.cosh],
  ['tanh', 1, Math.tanh],
  ['asinh', 1, Math.asinh],
  ['acosh', 1, Math.acosh, (x) => x >= 1 || Number.isNaN(x)],
  ['atanh', 1, Math.atanh, (x) => (x >= -1 && x <= 1) || Number.isNaN(x)],
  ['exp', 1, Math.exp],
  ['log2', 1, Math.log2, (x) => x >= 0 || Number.isNaN(x)],
  ['log10', 1, Math.log10, (x) => x >= 0 || Number.isNaN(x)],
  ['hypot', 2, Math.hypot],
  ['erf', 1, erf],
  ['erfc', 1, erfc],
];

for (const [name, arity, fn, valid] of MATH_FUNCTIONS) {
  sdef('Math', name, arity, function* (_self, args) {
    const values: number[] = [];
    for (const arg of args) values.push(yield* toFloat(arg));
    if (valid) domainCheck(name, valid(...values));
    return fn(...values);
  });
}
sdef('Math', 'log', [1, 2], function* (_self, args) {
  const x = yield* toFloat(args[0]);
  domainCheck('log', x >= 0 || Number.isNaN(x));
  if (args.length === 1) return mathLog(args[0], x);
  const base = yield* toFloat(args[1]);
  domainCheck('log', base >= 0 || Number.isNaN(base));
  return mathLog(args[0], x) / Math.log(base);
});

/** The natural logarithm, exact for big Integers whose Float conversion would overflow. */
function mathLog(value: Value, x: number): number {
  if (typeof value === 'bigint' && !Number.isFinite(x)) {
    const digits = value.toString(2).length;
    return Math.log(Number(value >> BigInt(digits - 53))) + (digits - 53) * Math.LN2;
  }
  return Math.log(x);
}

function erf(x: number): number {
  if (Math.abs(x) > 1) return 1 - erfc(x);
  const z = x * x;
  return (x * polynomial(z, ERF_T)) / polynomialWithLeadingOne(z, ERF_U);
}

function erfc(x: number): number {
  const ax = Math.abs(x);
  if (ax < 1) return 1 - erf(x);
  if (!Number.isFinite(ax)) return Number.isNaN(ax) ? Number.NaN : x < 0 ? 2 : 0;
  if (ax * ax > 745) return x < 0 ? 2 : 0;
  const tail =
    ax < 8
      ? polynomial(ax, ERFC_P) / polynomialWithLeadingOne(ax, ERFC_Q)
      : polynomial(ax, ERFC_R) / polynomialWithLeadingOne(ax, ERFC_S);
  const result = Math.exp(-ax * ax) * tail;
  return x < 0 ? 2 - result : result;
}

function polynomial(x: number, coefficients: readonly number[]): number {
  let result = 0;
  for (const coefficient of coefficients) result = result * x + coefficient;
  return result;
}

function polynomialWithLeadingOne(x: number, coefficients: readonly number[]): number {
  let result = x + coefficients[0];
  for (let i = 1; i < coefficients.length; i++) result = result * x + coefficients[i];
  return result;
}

// Cephes double-precision erf/erfc rational approximations (Stephen L. Moshier, netlib.org/cephes).
const ERF_T = [
  9.60497373987051638749, 9.00260197203842689217e1, 2.23200534594684319226e3, 7.00332514112805075473e3,
  5.55923013010394962768e4,
];
const ERF_U = [
  3.35617141647503099647e1, 5.21357949780152679795e2, 4.59432382970980127987e3, 2.26290000613890934246e4,
  4.92673942608635921086e4,
];
const ERFC_P = [
  2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687, 4.86371970985681366614e1,
  1.96520832956077098242e2, 5.26445194995477358631e2, 9.3452852717195760754e2, 1.02755188689515710272e3,
  5.57535335369399327526e2,
];
const ERFC_Q = [
  1.32281951154744992508e1, 8.67072140885989742329e1, 3.54937778887819891062e2, 9.75708501743205489753e2,
  1.82390916687909736289e3, 2.24633760818710981792e3, 1.65666309194161350182e3, 5.57535340817727675546e2,
];
const ERFC_R = [
  5.64189583547755073984e-1, 1.27536670759978104416, 5.01905042251180477414, 6.16021097993053585195,
  7.4097426995044893916, 2.9788666537210024067,
];
const ERFC_S = [
  2.2605286322011727659, 9.39603524938001434673, 1.20489539808096656605e1, 1.70814450747565897222e1,
  9.60896809063285878198, 3.3690764510008151605,
];

export function installMathConstants(): void {
  const { c } = rt();
  c.Math.constants.set('PI', Math.PI);
  c.Math.constants.set('E', Math.E);
  c.Float.constants.set('INFINITY', Number.POSITIVE_INFINITY);
  c.Float.constants.set('NAN', Number.NaN);
  c.Float.constants.set('EPSILON', Number.EPSILON);
  c.Float.constants.set('MAX', Number.MAX_VALUE);
  c.Float.constants.set('MIN', 2.2250738585072014e-308);
  c.Float.constants.set('DIG', 15n);
  c.Float.constants.set('MANT_DIG', 53n);
  c.Integer.constants.set('MAX', undefined as never);
  c.Integer.constants.delete('MAX');
}

export { toStr };
