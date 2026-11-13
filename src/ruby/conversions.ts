// code-gauge-allow-file fileNcss 411 -- The conversions module keeps one concern's cases together.
import { ExecutionLimitError, LIMITS } from '../interpreter/limits';
import { argumentError, implicitConversionError, rangeError, rubyError, typeError } from './errors';
import { hashGet } from './hashes';
import { callMethod, callProc, type Gen, respondsTo, runToEnd } from './interp';
import { NIL, RArray, RBasic, RClass, RHash, RObject, RProc, RRange, RString, RSymbol, type Value } from './objects';
import { rt } from './runtime';
import { classOf, isA, realClassOf, str, stringBytes, truthy } from './values';

// Numbers -------------------------------------------------------------------------------------------------------------

/** Formats a Float as `Float#to_s` does: the shortest digits, in exponent form below 1e-4 or from 1e16. */
// code-gauge-allow duplicateLines 15 -- Ruby numeric formatting shares the same exponent threshold as the other interpreters.
export function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponent] = Math.abs(value).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const point = Number(exponent) + 1;
  if (point < -3 || (point > 15 && point >= digits.length)) {
    const power = point - 1;
    return `${sign}${digits[0]}.${digits.slice(1) || '0'}e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
  }
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Converts an Integer to a Float as Ruby does, rounding to nearest even, with huge values becoming infinite. */
export const intToFloat: (value: bigint) => number = Number;

/** Converts a Float to an Integer, truncating, or raises for NaN and infinities as `to_i` does. */
export function floatToInt(value: number): bigint {
  if (Number.isNaN(value)) throw floatDomain('NaN');
  if (!Number.isFinite(value)) throw floatDomain(value > 0 ? 'Infinity' : '-Infinity');
  return BigInt(Math.trunc(value));
}

function floatDomain(message: string): unknown {
  return rubyError(rt().c.FloatDomainError, message);
}

/** The Integer an argument stands for, as Ruby's implicit `to_int` conversion makes it (floats truncate). */
export function* toInt(value: Value): Gen<bigint> {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return floatToInt(value);
  if (value instanceof RBasic && classOf(value).findMethod('to_int')) {
    const converted = yield* callMethod(value, 'to_int', [], undefined, undefined, { fcall: true });
    if (typeof converted === 'bigint') return converted;
    const name = realClassOf(value).name;
    throw typeError(`can't convert ${name} to Integer (${name}#to_int gives ${realClassOf(converted).name})`);
  }
  throw implicitConversionError(value, 'Integer');
}

export function* toIndex(value: Value): Gen<number> {
  return (yield* toIndexExact(value)).number;
}

export function* toIndexExact(value: Value): Gen<{ number: number; integer: bigint }> {
  const integer = yield* toInt(value);
  if (integer > 9_223_372_036_854_775_807n || integer < -9_223_372_036_854_775_808n) {
    throw rangeError(`bignum too big to convert into 'long'`);
  }
  return { number: Number(integer), integer };
}

export function* toRubyInt(value: Value): Gen<number> {
  const integer = yield* toInt(value);
  if (integer < -9_223_372_036_854_775_808n || integer > 9_223_372_036_854_775_807n) {
    throw rangeError("bignum too big to convert into 'long'");
  }
  if (integer < -2_147_483_648n) throw rangeError(`integer ${integer} too small to convert to 'int'`);
  if (integer > 2_147_483_647n) throw rangeError(`integer ${integer} too big to convert to 'int'`);
  return Number(integer);
}

export function toIndexSync(value: Value): number {
  return runToEnd(toIndex(value));
}

/** The String an argument stands for, by Ruby's implicit `to_str` conversion. */
export function* toStr(value: Value): Gen<string> {
  return (yield* toStrValue(value)).s;
}

export function* toStrValue(value: Value): Gen<RString> {
  if (value instanceof RString) return value;
  if (value instanceof RBasic && classOf(value).findMethod('to_str')) {
    const converted = yield* callMethod(value, 'to_str', [], undefined, undefined, { fcall: true });
    if (converted instanceof RString) return converted;
    const name = realClassOf(value).name;
    throw typeError(`can't convert ${name} to String (${name}#to_str gives ${realClassOf(converted).name})`);
  }
  throw implicitConversionError(value, 'String');
}

export function combinedStringEncoding(leftBinary: boolean, leftAscii: boolean, right: RString): boolean {
  if (leftBinary === right.binary) return leftBinary;
  const rightAscii = stringBytes(right).every((byte) => byte < 0x80);
  if (!leftAscii && !rightAscii) {
    const leftName = leftBinary ? 'BINARY (ASCII-8BIT)' : String.raw`UTF-8`;
    const rightName = right.binary ? 'BINARY (ASCII-8BIT)' : String.raw`UTF-8`;
    throw rubyError(
      rt().c['Encoding::CompatibilityError'],
      `incompatible character encodings: ${leftName} and ${rightName}`
    );
  }
  return leftAscii && !rightAscii ? right.binary : leftBinary;
}

export function toStrSync(value: Value): string {
  return runToEnd(toStr(value));
}

/** The Float a numeric argument stands for, as `Math` functions convert their arguments. */
export function* toFloat(value: Value): Gen<number> {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return intToFloat(value);
  if (value === NIL) throw typeError("can't convert nil into Float");
  if (value instanceof RString) throw typeError("can't convert String into Float");
  if (isA(value, rt().c.Numeric) && respondsTo(value, 'to_f', true)) {
    const converted = yield* callMethod(value, 'to_f', [], undefined, undefined, { fcall: true });
    if (typeof converted === 'number') return converted;
    throw typeError(
      `can't convert ${realClassOf(value).name} to Float (${realClassOf(value).name}#to_f gives ${realClassOf(converted).name})`
    );
  }
  throw implicitConversionError(value, 'Float');
}

// Strings -------------------------------------------------------------------------------------------------------------

/** The text of a value as `to_s` makes it, which string interpolation and `puts` show. */
export function* toS(value: Value): Gen<string> {
  return (yield* toSValue(value)).s;
}

export function* toSValue(value: Value): Gen<RString> {
  if (value instanceof RString) return value;
  const fast = fastToS(value);
  if (fast !== undefined && !isOverridden(value, 'to_s')) return str(fast);
  const converted = yield* callMethod(value, 'to_s', []);
  if (converted instanceof RString) return converted;
  return str(anyToS(value));
}

function fastToS(value: Value): string | undefined {
  switch (typeof value) {
    case 'bigint': {
      return String(value);
    }
    case 'number': {
      return formatFloat(value);
    }
    case 'boolean': {
      return String(value);
    }
  }
  if (value === NIL) return '';
  if (value instanceof RSymbol) return value.name;
  return undefined;
}

/** Whether the program redefined a library method for a value, which then must run instead of the fast path. */
function isOverridden(value: Value, name: string): boolean {
  const method = classOf(value).findMethod(name);
  return method !== undefined && method.body.kind !== 'native';
}

/** The default text of an object: `#<Foo:0x...>`, with a fake address that stays the same for the object. */
export function anyToS(value: Value): string {
  return `#<${realClassOf(value).name ?? anonymousClassName(realClassOf(value))}:${addressOf(value)}>`;
}

export function addressOf(value: Value): string {
  const runtime = rt();
  const key = value as object;
  let address = runtime.addresses.get(key);
  if (address === undefined) {
    address = runtime.addresses.size;
    runtime.addresses.set(key, address);
  }
  return `0x${(0x7f_1a_2b_3c_00_00n + BigInt(address) * 0x28n).toString(16).padStart(16, '0')}`;
}

export function anonymousClassName(cls: RClass): string {
  return `#<${cls.isModule ? 'Module' : 'Class'}:${addressOf(cls)}>`;
}

/** The text `inspect` makes, which `p` shows. */
export function* inspect(value: Value): Gen<string> {
  return (yield* inspectValue(value)).s;
}

export function* inspectValue(value: Value): Gen<RString> {
  const fast = fastInspect(value);
  if (fast !== undefined && !isOverridden(value, 'inspect')) return str(fast);
  const converted = yield* callMethod(value, 'inspect', []);
  return converted instanceof RString ? converted : yield* toSValue(converted);
}

function fastInspect(value: Value): string | undefined {
  if (value === NIL) return 'nil';
  if (value instanceof RString && !value.binary && !value.rawBytes) return strInspect(value.s);
  if (value instanceof RSymbol) return symInspect(value.name);
  if (typeof value === 'object') return undefined;
  return fastToS(value);
}

/** Inspects the objects a container holds, showing `[...]` for one that contains itself. */
const inspecting = new Set<object>();

export function* inspectArray(array: RArray): Gen<string> {
  if (inspecting.has(array)) return '[...]';
  inspecting.add(array);
  try {
    const parts: string[] = [];
    let length = 2;
    for (const item of array.items) length = pushInspected(parts, yield* inspect(item), length, 2);
    return `[${parts.join(', ')}]`;
  } finally {
    inspecting.delete(array);
  }
}

export function* inspectHash(hash: RHash): Gen<string> {
  if (hash.map.size === 0) return '{}';
  if (inspecting.has(hash)) return '{...}';
  inspecting.add(hash);
  try {
    const parts: string[] = [];
    let length = 2;
    for (const { key, value } of hash.map.values()) {
      if (key instanceof RSymbol) {
        const name = isSimpleSymbol(key.name) ? key.name : yield* inspect(str(key.name));
        length = pushInspected(parts, `${name}: ${yield* inspect(value)}`, length, 2);
      } else {
        length = pushInspected(parts, `${yield* inspect(key)} => ${yield* inspect(value)}`, length, 2);
      }
    }
    return `{${parts.join(', ')}}`;
  } finally {
    inspecting.delete(hash);
  }
}

/** Whether a symbol key shows as `key: value` without quotes in a Hash's inspect. */
function isSimpleSymbol(name: string): boolean {
  return /^[A-Za-z_\u0080-￿][\w\u0080-￿]*[?!]?$/u.test(name);
}

export function* inspectRange(value: RRange): Gen<string> {
  const begin = value.begin === NIL && value.end !== NIL ? '' : yield* inspect(value.begin);
  const end = value.end === NIL && value.begin !== NIL ? '' : yield* inspect(value.end);
  if (begin.length + end.length + 3 > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  return `${begin}${value.exclusive ? '...' : '..'}${end}`;
}

export function* inspectObject(object: RBasic): Gen<string> {
  const name = realClassOf(object).name ?? anonymousClassName(realClassOf(object));
  const ivars = [...(object.ivars ?? [])].filter(([key]) => !key.startsWith('@__'));
  if (ivars.length === 0) return `#<${name}:${addressOf(object)}>`;
  if (inspecting.has(object)) return `#<${name}:${addressOf(object)} ...>`;
  inspecting.add(object);
  try {
    const parts: string[] = [];
    let length = name.length + 24;
    for (const [key, value] of ivars) length = pushInspected(parts, `${key}=${yield* inspect(value)}`, length, 2);
    return `#<${name}:${addressOf(object)} ${parts.join(', ')}>`;
  } finally {
    inspecting.delete(object);
  }
}

function pushInspected(parts: string[], part: string, length: number, separatorLength: number): number {
  const total = length + part.length + (parts.length > 0 ? separatorLength : 0);
  if (total > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  rt().spend(Math.ceil(part.length / 256));
  parts.push(part);
  return total;
}

export function* inspectException(exception: RObject): Gen<string> {
  const name = realClassOf(exception).name ?? anonymousClassName(realClassOf(exception));
  const message = yield* toS(yield* callMethod(exception, 'to_s', []));
  if (message === '') return name;
  if (message.includes('\n')) return `#<${name}: ${strInspect(message)}>`;
  return `#<${name}: ${message}>`;
}

export function inspectProc(proc: RProc): string {
  const body = proc.body;
  const location = body.kind === 'block' ? ` main.rb:${body.def.row + 1}` : '';
  return `#<Proc:${addressOf(proc)}${location}${proc.isLambda ? ' (lambda)' : ''}>`;
}

export function className(cls: RClass): string {
  if (cls.isSingleton) {
    const attached = cls.attached as Value;
    const shown = attached instanceof RClass ? className(attached) : runToEnd(inspect(attached));
    return `#<Class:${shown}>`;
  }
  return cls.name ?? anonymousClassName(cls);
}

/** A String's inspect: double-quoted, escaping quotes, backslashes, `#{`, and characters that do not print. */
// code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of value Ruby converts or compares.
// code-gauge-allow functionNcss 53 -- One case per kind of value Ruby converts or compares.
export function strInspect(text: string): string {
  let result = '"';
  for (let index = 0; index < text.length; index++) {
    if (index % 256 === 0) {
      rt().spend();
      if (result.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
    }
    const char = text[index];
    const code = text.codePointAt(index) as number;
    if (code > 0xff_ff) {
      result += isPrintable(code) ? String.fromCodePoint(code) : `\\u{${code.toString(16).toUpperCase()}}`;
      index++;
      continue;
    }
    switch (char) {
      case '"': {
        result += String.raw`\"`;
        break;
      }
      case '\\': {
        result += String.raw`\\`;
        break;
      }
      case '\n': {
        result += String.raw`\n`;
        break;
      }
      case '\t': {
        result += String.raw`\t`;
        break;
      }
      case '\r': {
        result += String.raw`\r`;
        break;
      }
      case '\f': {
        result += String.raw`\f`;
        break;
      }
      case '\v': {
        result += String.raw`\v`;
        break;
      }
      case '\b': {
        result += String.raw`\b`;
        break;
      }
      case '\u0007': {
        result += String.raw`\a`;
        break;
      }
      case '\u001B': {
        result += String.raw`\e`;
        break;
      }
      case '#': {
        const next = text[index + 1];
        result += next === '{' || next === '$' || next === '@' ? String.raw`\#` : '#';
        break;
      }
      default: {
        if (isPrintable(code)) result += char;
        else if (code < 0x80) result += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
        else result += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
      }
    }
  }
  if (result.length > LIMITS.maxStringLength) throw new ExecutionLimitError('storage');
  return `${result}"`;
}

function isPrintable(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return false;
  if (code >= 0x80 && code < 0xa0) return false;
  if (code >= 0xd8_00 && code <= 0xdf_ff) return false;
  return !/[\p{Cc}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(String.fromCodePoint(code)) || code === 0x20;
}

const OPERATOR_SYMBOLS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '==',
  '===',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '<=>',
  '<<',
  '>>',
  '&',
  '|',
  '^',
  '~',
  '!',
  '=~',
  '!~',
  '[]',
  '[]=',
  '+@',
  '-@',
  '`',
]);

export function symInspect(name: string): string {
  if (OPERATOR_SYMBOLS.has(name)) return `:${name}`;
  if (/^(?:\$|@@?)?[A-Za-z_\u0080-￿][\w\u0080-￿]*$/u.test(name)) return `:${name}`;
  if (/^[A-Za-z_\u0080-￿][\w\u0080-￿]*[?!=]$/u.test(name)) return `:${name}`;
  return `:${strInspect(name)}`;
}

// Comparisons ---------------------------------------------------------------------------------------------------------

/** `a == b`, with the library's own types compared without calling methods unless the program redefined them. */
export function* rEquals(a: Value, b: Value, pairs: Map<RBasic, Set<RBasic>> = new Map()): Gen<boolean> {
  if (a === b) return typeof a !== 'number' || !Number.isNaN(a);
  if (typeof a === 'bigint' || typeof a === 'number') {
    if (isOverridden(a, '==')) return truthy(yield* callMethod(a, '==', [b]));
    if (typeof b === 'bigint' || typeof b === 'number') return numericEquals(a, b);
    if (b instanceof RBasic && classOf(b).findMethod('==')?.body.kind === 'user') {
      return truthy(yield* callMethod(b, '==', [a]));
    }
    return false;
  }
  if (typeof a !== 'object' || a === NIL || a instanceof RSymbol) return false;
  if (isOverridden(a, '==')) return truthy(yield* callMethod(a, '==', [b]));
  if (a instanceof RString) return b instanceof RString && truthy(yield* callMethod(a, '==', [b]));
  if (a instanceof RArray) {
    if (!(b instanceof RArray) || a.items.length !== b.items.length) return false;
    return yield* eqlContainer(a, b, pairs, function* () {
      for (let index = 0; index < a.items.length; index++)
        if (!(yield* rEquals(a.items[index], b.items[index], pairs))) return false;
      return true;
    });
  }
  if (a instanceof RHash)
    return b instanceof RHash && (yield* eqlContainer(a, b, pairs, () => hashEquals(a, b, pairs)));
  if (a instanceof RRange) {
    return (
      b instanceof RRange &&
      (yield* eqlContainer(a, b, pairs, function* () {
        return (
          a.exclusive === b.exclusive &&
          (yield* rEquals(a.begin, b.begin, pairs)) &&
          (yield* rEquals(a.end, b.end, pairs))
        );
      }))
    );
  }
  const method = classOf(a).findMethod('==');
  if (method && method.owner !== rt().c.BasicObject && method.owner !== rt().c.Kernel) {
    return truthy(yield* callMethod(a, '==', [b]));
  }
  return false;
}

function* hashEquals(a: RHash, b: Value, pairs: Map<RBasic, Set<RBasic>>): Gen<boolean> {
  return b instanceof RHash && (yield* compareHashEntries(a, b, (left, right) => rEquals(left, right, pairs)));
}

function* compareHashEntries(a: RHash, b: RHash, equals: (left: Value, right: Value) => Gen<boolean>): Gen<boolean> {
  if (a.map.size !== b.map.size) return false;
  a.iterating++;
  b.iterating++;
  try {
    for (const entry of a.map.values()) {
      const other = yield* hashGet(b, entry.key);
      if (!other || !(yield* equals(entry.value, other.value))) return false;
    }
    return true;
  } finally {
    a.iterating--;
    b.iterating--;
  }
}

export function numericEquals(a: bigint | number, b: bigint | number): boolean {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  const float = typeof a === 'number' ? a : (b as number);
  const integer = typeof a === 'bigint' ? a : (b as bigint);
  return Number.isInteger(float) && Number.isFinite(float) && BigInt(float) === integer;
}

/** `a.eql?(b)`: equal values of the same type, as Hash keys compare. */
export function* rEql(a: Value, b: Value, pairs: Map<RBasic, Set<RBasic>> = new Map()): Gen<boolean> {
  if (a instanceof RBasic && isOverridden(a, 'eql?')) return truthy(yield* callMethod(a, 'eql?', [b]));
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return a === b;
  if (a instanceof RString) return b instanceof RString && truthy(yield* callMethod(a, 'eql?', [b]));
  if (a instanceof RArray) return b instanceof RArray && (yield* eqlArray(a, b, pairs));
  if (a instanceof RHash) return b instanceof RHash && (yield* eqlHash(a, b, pairs));
  if (a instanceof RRange) return b instanceof RRange && (yield* eqlRange(a, b, pairs));
  return a === b;
}

function* eqlArray(a: RArray, b: RArray, pairs: Map<RBasic, Set<RBasic>>): Gen<boolean> {
  return yield* eqlContainer(a, b, pairs, function* () {
    if (a.items.length !== b.items.length) return false;
    for (let index = 0; index < a.items.length; index++)
      if (!(yield* rEql(a.items[index], b.items[index], pairs))) return false;
    return true;
  });
}

function* eqlHash(a: RHash, b: RHash, pairs: Map<RBasic, Set<RBasic>>): Gen<boolean> {
  return yield* eqlContainer(a, b, pairs, () => compareHashEntries(a, b, (left, right) => rEql(left, right, pairs)));
}

function* eqlRange(a: RRange, b: RRange, pairs: Map<RBasic, Set<RBasic>>): Gen<boolean> {
  return yield* eqlContainer(a, b, pairs, function* () {
    return a.exclusive === b.exclusive && (yield* rEql(a.begin, b.begin, pairs)) && (yield* rEql(a.end, b.end, pairs));
  });
}

function* eqlContainer(
  a: RBasic,
  b: RBasic,
  pairs: Map<RBasic, Set<RBasic>>,
  compare: () => Gen<boolean>
): Gen<boolean> {
  if (pairs.get(a)?.has(b)) return true;
  const matches = pairs.get(a) ?? new Set<RBasic>();
  matches.add(b);
  pairs.set(a, matches);
  try {
    return yield* compare();
  } finally {
    matches.delete(b);
    if (matches.size === 0) pairs.delete(a);
  }
}

/** The order of two values by `<=>`, raising "comparison of X with Y failed" when they do not compare. */
export function* compareValues(a: Value, b: Value): Gen<number> {
  const order = yield* spaceship(a, b);
  if (order === undefined) throw comparisonFailed(a, b);
  return order;
}

export function comparisonFailed(a: Value, b: Value): unknown {
  const immediate =
    typeof b === 'number' ||
    typeof b === 'boolean' ||
    (typeof b === 'bigint' && b >= -(1n << 62n) && b < 1n << 62n) ||
    (typeof b === 'object' && !(b instanceof RBasic));
  const right = immediate ? runToEnd(inspect(b)) : realClassOf(b).name;
  return argumentError(`comparison of ${realClassOf(a).name} with ${right} failed`);
}

/** `a <=> b` as a number, or `undefined` when it is nil. */
// code-gauge-allow functionCognitiveComplexity 18 -- One case per kind of value Ruby converts or compares.
export function* spaceship(a: Value, b: Value): Gen<number | undefined> {
  if ((typeof a === 'bigint' || typeof a === 'number') && !isOverridden(a, '<=>')) {
    if (typeof b === 'bigint' || typeof b === 'number') return numericCompare(a, b);
    return undefined;
  }
  if (a instanceof RString && b instanceof RString && !isOverridden(a, '<=>')) {
    return compareRubyStrings(a, b);
  }
  const result = yield* callMethod(a, '<=>', [b]);
  if (result === NIL) return undefined;
  if (typeof result === 'bigint') return Number(result > 0n ? 1n : result < 0n ? -1n : 0n);
  if (typeof result === 'number') return Math.sign(result);
  const positive = truthy(yield* callMethod(result, '>', [0n]));
  if (positive) return 1;
  return truthy(yield* callMethod(result, '<', [0n])) ? -1 : 0;
}

// code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of value Ruby converts or compares.
export function numericCompare(a: bigint | number, b: bigint | number): number | undefined {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  // Mixed: compare exactly, since converting a big Integer to a Float loses digits.
  return typeof a === 'number' ? compareFloatInteger(a, b as bigint) : -compareFloatInteger(b as number, a);
}

function compareFloatInteger(float: number, integer: bigint): number {
  if (!Number.isFinite(float)) return float > 0 ? 1 : -1;
  const truncated = BigInt(Math.trunc(float));
  if (truncated !== integer) return truncated > integer ? 1 : -1;
  return Math.sign(float - Math.trunc(float));
}

/** Compares strings by their UTF-8 bytes, which orders code points as their numbers do. */
export function compareStrings(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = a.codePointAt(index) as number;
    const y = b.codePointAt(index) as number;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xff_ff) index++;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function compareRubyStrings(a: RString, b: RString): number {
  const bytes = stringBytes(a);
  const order = compareBytes(bytes, stringBytes(b));
  if (order !== 0 || a.binary === b.binary || bytes.every((byte) => byte < 0x80)) return order;
  return a.binary ? -1 : 1;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** `pattern === value`, as `case` and `when` compare. */
export function* caseEquals(pattern: Value, value: Value): Gen<boolean> {
  if (isOverridden(pattern, '===')) return truthy(yield* callMethod(pattern, '===', [value]));
  if (pattern instanceof RClass) return isA(value, pattern);
  if (pattern instanceof RRange) return yield* rangeCovers(pattern, value);
  if (pattern instanceof RProc) return truthy(yield* callProc(pattern, [value]));
  if (pattern instanceof RObject && classOf(pattern).findMethod('===')?.body.kind === 'native') {
    return truthy(yield* callMethod(pattern, '===', [value]));
  }
  return yield* rEquals(pattern, value);
}

/** Whether a range covers a value: `begin <= value` and `value < end` (or `<=`), with nil ends open. */
export function* rangeCovers(range: RRange, value: Value): Gen<boolean> {
  if (range.begin !== NIL) {
    const order = yield* spaceship(range.begin, value);
    if (order === undefined || order > 0) return false;
  }
  if (range.end !== NIL) {
    const order = yield* spaceship(value, range.end);
    if (order === undefined) return false;
    return range.exclusive ? order < 0 : order <= 0;
  }
  return true;
}
