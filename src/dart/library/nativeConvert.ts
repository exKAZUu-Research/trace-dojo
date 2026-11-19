// code-gauge-allow-file fileNcss 411 -- dart:convert's JSON, UTF-8, and Base64 codecs, each transcribed from the SDK.
import { formatDouble } from '../format';
import { HashStore } from '../hashStore';
import { DartThrow, type Runtime } from '../runtime';
import { coreTypes, DYNAMIC, interfaceType } from '../types';
import { DartList, DartObject, type Value } from '../values';
import { newMap } from './nativeCollections';
import { define, intArg, newList, stringArg } from './nativeSupport';

/** A string as Dart's JSON encoder writes it: quotes, backslashes, control characters, and lone surrogates escaped. */
// code-gauge-allow functionCognitiveComplexity 16 -- A transcription of the SDK's algorithm, case by case.
function quoteJson(text: string): string {
  let result = '"';
  for (let position = 0; position < text.length; position++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- JSON escapes UTF-16 code units.
    const code = text.charCodeAt(position);
    const char = text[position];
    if (char === '"') result += String.raw`\"`;
    else if (char === '\\') result += String.raw`\\`;
    else if (code < 0x20) {
      const short: Record<number, string> = { 8: 'b', 9: 't', 10: 'n', 12: 'f', 13: 'r' };
      result += short[code] ? `\\${short[code]}` : `\\u${code.toString(16).padStart(4, '0')}`;
    } else if (code >= 0xd8_00 && code <= 0xdf_ff) {
      // oxlint-disable-next-line unicorn/prefer-code-point -- JSON escapes UTF-16 code units.
      const next = text.charCodeAt(position + 1);
      if (code <= 0xdb_ff && next >= 0xdc_00 && next <= 0xdf_ff) {
        result += char + text[position + 1];
        position++;
      } else {
        result += `\\u${code.toString(16)}`;
      }
    } else {
      result += char;
    }
  }
  return `${result}"`;
}

function isMap(value: Value): value is DartObject {
  return value instanceof DartObject && value.native instanceof HashStore && value.native.isMap;
}

function encodeJson(runtime: Runtime, value: Value, toEncodable: Value, indent: string | undefined): string {
  return new JsonStringifier(runtime, toEncodable, indent).write(value, 0);
}

/** Writes JSON as Dart's _JsonStringifier does: one case per kind of value, and toEncodable or toJson for the rest. */
class JsonStringifier {
  private readonly visiting: Value[] = [];

  constructor(
    private readonly runtime: Runtime,
    private readonly toEncodable: Value,
    private readonly indent: string | undefined
  ) {}

  /**
   * A value JSON cannot hold (NaN, a map with keys other than strings, an object) goes through toEncodable once, and
   * any failure in writing what it returns is reported for this value, as the SDK's writeObject does.
   */
  write(current: Value, depth: number): string {
    this.runtime.spend();
    const direct = this.writeJsonValue(current, depth);
    if (direct !== undefined) return direct;
    const { runtime } = this;
    if (this.visiting.includes(current)) runtime.throwError('JsonCyclicError', '', [current]);
    this.visiting.push(current);
    try {
      const text = this.writeJsonValue(this.convert(current), depth);
      if (text === undefined) return runtime.throwError('JsonUnsupportedObjectError', '', [current]);
      return text;
    } catch (error) {
      if (error instanceof DartThrow)
        runtime.throwError('JsonUnsupportedObjectError', '', [current], { cause: error.value });
      throw error;
    } finally {
      this.visiting.pop();
    }
  }

  private writeJsonValue(current: Value, depth: number): string | undefined {
    if (current === undefined) return 'null';
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'number') return Number.isFinite(current) ? formatDouble(current) : undefined;
    if (typeof current === 'string') return quoteJson(current);
    if (this.visiting.includes(current)) this.runtime.throwError('JsonCyclicError', '', [current]);
    if (current instanceof DartList) return this.writeList(current, depth);
    if (isMap(current)) return this.writeMap(current, depth);
    return undefined;
  }

  private writeList(list: DartList, depth: number): string {
    if (list.elements.length === 0) return '[]';
    this.visiting.push(list);
    const parts = list.elements.map((element) => this.write(element, depth + 1));
    this.visiting.pop();
    return this.wrap('[', parts, ']', depth);
  }

  private writeMap(map: DartObject, depth: number): string | undefined {
    const store = map.native as unknown as HashStore;
    if (store.size === 0) return '{}';
    if ([...store.positions()].some((position) => typeof store.keyAt(position) !== 'string')) return undefined;
    this.visiting.push(map);
    const parts: string[] = [];
    for (const position of store.positions()) {
      const key = store.keyAt(position) as string;
      const separator = this.indent === undefined ? ':' : ': ';
      parts.push(`${quoteJson(key)}${separator}${this.write(store.entryValues[position], depth + 1)}`);
    }
    this.visiting.pop();
    return this.wrap('{', parts, '}', depth);
  }

  private wrap(open: string, parts: string[], close: string, depth: number): string {
    const { indent } = this;
    const newline = indent === undefined ? '' : `\n${indent.repeat(depth + 1)}`;
    const end = indent === undefined ? '' : `\n${indent.repeat(depth)}`;
    return `${open}${newline}${parts.join(`,${newline}`)}${end}${close}`;
  }

  /** The encodable value of another object, from toEncodable or the object's toJson. */
  private convert(current: Value): Value {
    const { runtime } = this;
    return this.toEncodable === undefined
      ? runtime.invoke(current, 'toJson', { positional: [], named: undefined, isDynamic: true }, [], undefined)
      : runtime.callValue(this.toEncodable, { positional: [current], named: undefined }, [], runtime.userCallRow);
  }
}

define('_jsonEncode', (runtime, _receiver, [value, toEncodable, indent]) =>
  encodeJson(runtime, value, toEncodable, indent === undefined ? undefined : stringArg(runtime, indent, 'indent'))
);

/** A JSON parser that keeps Dart's distinction of ints and doubles and reports Dart's FormatException messages. */
class JsonParser {
  position = 0;

  constructor(
    private readonly runtime: Runtime,
    private readonly text: string
  ) {}

  fail(message: string, offset = this.position): never {
    this.runtime.throwError('FormatException', '', [message, this.text, BigInt(offset)]);
  }

  skipSpace(): void {
    while (this.position < this.text.length && ' \t\n\r'.includes(this.text[this.position])) this.position++;
  }

  parse(): Value {
    this.skipSpace();
    const value = this.value();
    this.skipSpace();
    if (this.position < this.text.length) this.fail('Unexpected character');
    return value;
  }

  // code-gauge-allow duplicateLines 16 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  value(): Value {
    this.runtime.spend();
    if (this.position >= this.text.length) this.fail('Unexpected end of input');
    const char = this.text[this.position];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    if (char === '-' || (char >= '0' && char <= '9')) return this.number();
    for (const [word, result] of [
      ['true', true],
      ['false', false],
      ['null', undefined],
    ] as const) {
      if (char === word[0]) return this.keyword(word, result);
    }
    return this.fail('Unexpected character');
  }

  /** A keyword cut short by the end of the text is reported at the end, and a misspelled one at its start. */
  keyword(word: string, result: Value): Value {
    const start = this.position;
    const rest = this.text.slice(start, start + word.length);
    if (rest === word) {
      this.position += word.length;
      return result;
    }
    if (rest.length < word.length && word.startsWith(rest)) this.fail('Unexpected end of input', this.text.length);
    return this.fail('Unexpected character', start);
  }

  // code-gauge-allow functionCognitiveComplexity 16 -- A transcription of the SDK's algorithm, case by case.
  // code-gauge-allow functionNcss 31 -- A transcription of the SDK's algorithm, case by case.
  object(): Value {
    this.position++;
    const map = newMap(this.runtime, interfaceType(coreTypes.string), DYNAMIC);
    const store = map.native as unknown as HashStore;
    this.skipSpace();
    if (this.text[this.position] === '}') {
      this.position++;
      return map;
    }
    for (;;) {
      this.skipSpace();
      if (this.position >= this.text.length) this.fail('Unexpected end of input');
      if (this.text[this.position] !== '"') this.fail('Unexpected character');
      const key = this.string();
      this.skipSpace();
      if (this.position >= this.text.length) this.fail('Unexpected end of input');
      if (this.text[this.position] !== ':') this.fail('Unexpected character');
      this.position++;
      this.skipSpace();
      store.set(key, this.value());
      this.skipSpace();
      if (this.position >= this.text.length) this.fail('Unexpected end of input');
      const next = this.text[this.position++];
      if (next === '}') return map;
      if (next !== ',') this.fail('Unexpected character', this.position - 1);
    }
  }

  array(): Value {
    this.position++;
    const values: Value[] = [];
    this.skipSpace();
    if (this.text[this.position] === ']') {
      this.position++;
      return newList(this.runtime, DYNAMIC, values);
    }
    for (;;) {
      this.skipSpace();
      values.push(this.value());
      this.skipSpace();
      if (this.position >= this.text.length) this.fail('Unexpected end of input');
      const next = this.text[this.position++];
      if (next === ']') return newList(this.runtime, DYNAMIC, values);
      if (next !== ',') this.fail('Unexpected character', this.position - 1);
    }
  }

  // code-gauge-allow duplicateLines 30 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
  // code-gauge-allow functionCognitiveComplexity 16 -- A transcription of the SDK's algorithm, case by case.
  string(): string {
    this.position++;
    let result = '';
    for (;;) {
      if (this.position >= this.text.length) this.fail('Unterminated string', this.text.length);
      const char = this.text[this.position++];
      if (char === '"') return result;
      // oxlint-disable-next-line unicorn/prefer-code-point -- JSON control characters are UTF-16 code units.
      if (char.charCodeAt(0) < 0x20) this.fail('Control character in string', this.position - 1);
      if (char !== '\\') {
        result += char;
        continue;
      }
      const escape = this.text[this.position++];
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (escape in simple) {
        result += simple[escape];
      } else if (escape === 'u') {
        const hex = this.text.slice(this.position, this.position + 4);
        if (!/^[\da-fA-F]{4}$/.test(hex)) this.fail('Invalid unicode escape', this.position - 1);
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        this.position += 4;
      } else {
        this.fail('Unrecognized string escape', this.position);
      }
    }
  }

  /** Numbers as the SDK's parser reads them, which reports a number cut short by the end of the text separately. */
  number(): Value {
    const start = this.position;
    if (this.text[this.position] === '-') {
      this.position++;
      this.requireMore();
      if (!this.isDigit()) this.fail('Missing expected digit', this.position);
    }
    this.integerPart();
    const hasFraction = this.fractionPart();
    const hasExponent = this.exponentPart();
    const literal = this.text.slice(start, this.position);
    if (!hasFraction && !hasExponent) {
      const value = BigInt(literal);
      if (value <= 9_223_372_036_854_775_807n && value >= -9_223_372_036_854_775_808n) return value;
    }
    return Number(literal);
  }

  private integerPart(): void {
    if (this.text[this.position] === '0') {
      this.position++;
      if (this.isDigit()) this.fail('Unexpected character', this.position);
      return;
    }
    this.skipDigits();
  }

  private fractionPart(): boolean {
    if (this.text[this.position] !== '.') return false;
    this.position++;
    this.requireMore();
    if (!this.isDigit()) this.fail('Unexpected character', this.position);
    this.skipDigits();
    return true;
  }

  private exponentPart(): boolean {
    const char = this.text[this.position];
    if (char !== 'e' && char !== 'E') return false;
    this.position++;
    this.requireMore();
    if (this.text[this.position] === '+' || this.text[this.position] === '-') {
      this.position++;
      this.requireMore();
    }
    if (!this.isDigit()) this.fail('Missing expected digit', this.position);
    this.skipDigits();
    return true;
  }

  /** A number that the end of the text cuts short is unterminated, which the SDK reports at the end. */
  private requireMore(): void {
    if (this.position >= this.text.length) this.fail('Unterminated number literal', this.text.length);
  }

  private isDigit(): boolean {
    const char = this.text[this.position];
    return this.position < this.text.length && char >= '0' && char <= '9';
  }

  private skipDigits(): void {
    while (this.isDigit()) this.position++;
  }
}

function revive(runtime: Runtime, key: Value, value: Value, reviver: Value): Value {
  if (value instanceof DartList) {
    for (const [position, element] of value.elements.entries())
      value.elements[position] = revive(runtime, BigInt(position), element, reviver);
  } else if (isMap(value)) {
    const store = value.native as unknown as HashStore;
    const positions = [...store.positions()];
    for (const position of positions)
      store.entryValues[position] = revive(runtime, store.keyAt(position), store.entryValues[position], reviver);
  }
  return runtime.callValue(reviver, { positional: [key, value], named: undefined }, [], runtime.userCallRow);
}

define('_jsonDecode', (runtime, _receiver, [source, reviver]) => {
  const result = new JsonParser(runtime, stringArg(runtime, source, 'source')).parse();
  return reviver === undefined ? result : revive(runtime, undefined, result, reviver);
});

// UTF-8 and Base64

define('_utf8Encode', (runtime, _receiver, [input]) => {
  const bytes = new TextEncoder().encode(stringArg(runtime, input, 'input'));
  return newList(runtime, interfaceType(coreTypes.int), [...bytes].map(BigInt), false);
});
define('_utf8Decode', (runtime, _receiver, [codeUnits, allowMalformed]) => {
  // The VM replaces values that are not bytes with 0xFF, which is invalid.
  const bytes = Uint8Array.from(
    (codeUnits as DartList).elements.map((unit) => {
      const value = Number(intArg(runtime, unit, 'codeUnits'));
      return value >= 0 && value <= 0xff ? value : 0xff;
    })
  );
  if (allowMalformed === true) return new TextDecoder('utf-8').decode(bytes);
  const error = utf8Error(bytes);
  if (error) return runtime.throwError('FormatException', '', [error.message, codeUnits, BigInt(error.offset)]);
  return new TextDecoder('utf-8').decode(bytes);
});

/* oxlint-disable unicorn/prefer-code-point -- The SDK's tables are strings of byte-sized code units. */
const UTF8_TYPES =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.repeat(4) +
  'FFFFFFFFFFFFFFFFGGGGGGGGGGGGGGGG' +
  'HHHHHHHHHHHHHHHHHHHHHHHHHHHIHHHJ' +
  'EEBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' +
  'KCCCCCCCCCCCCDCLONNNMEEEEEEEEEEE';
const [IA, X1, X2, X3, TO, TS, QO, QR, B1, B2, E1, E2, E3, E4, E5, E6, E7] = [
  0x00, 0x30, 0x3a, 0x44, 0x4e, 0x58, 0x62, 0x6c, 0x76, 0x80, 0x41, 0x43, 0x45, 0x47, 0x49, 0x4b, 0x4d,
];
const AB = 0x20;
const UTF8_TRANSITIONS: number[] = [
  0x20,
  // IA, BB, AB: the states before and between characters.
  IA,
  X1,
  X2,
  TS,
  E3,
  E2,
  E2,
  E2,
  E2,
  E2,
  TO,
  X2,
  QR,
  X3,
  QO,
  0x20,
  IA,
  X1,
  X2,
  TS,
  E3,
  E2,
  E2,
  E2,
  E2,
  E2,
  TO,
  B1,
  QR,
  X3,
  QO,
  0x20,
  IA,
  X1,
  X2,
  TS,
  E3,
  E2,
  E2,
  E2,
  E2,
  E2,
  TO,
  X2,
  QR,
  X3,
  QO,
  0x20,
  // X1, X2, X3, TO, TS, QO, QR, B1, B2: inside a character, each overlapping the next by five E1s.
  E1,
  E1,
  E1,
  E1,
  E1,
  IA,
  IA,
  IA,
  IA,
  IA,
  E1,
  E1,
  E1,
  E1,
  E1,
  X1,
  X1,
  X1,
  X1,
  X1,
  E1,
  E1,
  E1,
  E1,
  E1,
  X2,
  X2,
  X2,
  X2,
  X2,
  E1,
  E1,
  E1,
  E1,
  E1,
  E4,
  E4,
  X1,
  X1,
  X1,
  E1,
  E1,
  E1,
  E1,
  E1,
  X1,
  X1,
  E6,
  E6,
  E6,
  E1,
  E1,
  E1,
  E1,
  E1,
  E4,
  X2,
  X2,
  X2,
  X2,
  E1,
  E1,
  E1,
  E1,
  E1,
  X2,
  E5,
  E5,
  E5,
  E5,
  E1,
  E1,
  E1,
  E1,
  E1,
  X1,
  X1,
  X1,
  B2,
  X1,
  E1,
  E1,
  E1,
  E1,
  E1,
  IA,
  IA,
  IA,
  IA,
  AB,
  E1,
  E1,
  E1,
  E1,
  E1,
];
const UTF8_ERRORS: Record<number, string> = {
  [E1]: 'Missing extension byte',
  [E2]: 'Unexpected extension byte',
  [E3]: 'Invalid UTF-8 byte',
  [E4]: 'Overlong encoding',
  [E5]: 'Out of unicode range',
  [E6]: 'Encoded surrogate',
  [E7]: 'Unfinished UTF-8 octet sequence',
};

/** The first error in UTF-8 bytes and its offset, found with the SDK's state machine (utf.dart _Utf8Decoder). */
function utf8Error(bytes: Uint8Array): { message: string; offset: number } | undefined {
  let state = IA;
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (let position = start; position < bytes.length; position++) {
    const type = UTF8_TYPES.charCodeAt(bytes[position]) & 0x1f;
    state = UTF8_TRANSITIONS[state + type] as number;
    if ((state & 1) !== 0) return { message: UTF8_ERRORS[state] as string, offset: position };
  }
  if (state > AB) return { message: UTF8_ERRORS[E7] as string, offset: bytes.length };
  return undefined;
}
/* oxlint-enable unicorn/prefer-code-point */

define('_base64Encode', (runtime, _receiver, [bytes, urlSafe]) => {
  const data = Uint8Array.from(
    (bytes as DartList).elements.map((unit) => Number(intArg(runtime, unit, 'bytes')) & 0xff)
  );
  const text = Buffer.from(data).toString('base64');
  return urlSafe === true ? text.replaceAll('+', '-').replaceAll('/', '_') : text;
});
define('_base64Decode', (runtime, _receiver, [source]) => {
  const input = stringArg(runtime, source, 'source');
  const fail = (message: string, offset: number): never =>
    runtime.throwError('FormatException', '', [message, input, BigInt(offset)]);
  const bytes = decodeBase64(input, fail);
  return newList(runtime, interfaceType(coreTypes.int), bytes.map(BigInt), false);
});

/** The inverse of the Base64 alphabets, both the standard and the URL-safe one: -1 for padding, -2 for others. */
const BASE64_VALUES: readonly number[] = Array.from({ length: 128 }, (_, code) => {
  const char = String.fromCodePoint(code);
  if (char === '=' || char === '%') return -1;
  if (char === '-' || char === '+') return 62;
  if (char === '_' || char === '/') return 63;
  const index = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.indexOf(char);
  return index === -1 ? -2 : index;
});

/** Base64 decoding as the SDK's _Base64Decoder does it, with its errors and their offsets. */
// code-gauge-allow functionNcss 34 -- A transcription of the SDK's _Base64Decoder.decodeChunk, case by case.
// code-gauge-allow functionCognitiveComplexity 30 -- A transcription of the SDK's _Base64Decoder.decodeChunk, case by case.
function decodeBase64(input: string, fail: (message: string, offset: number) => never): number[] {
  const output: number[] = [];
  let bits = 0;
  let count = 0;
  for (let position = 0; position < input.length; position++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- Base64 reads UTF-16 code units.
    const code = input.charCodeAt(position);
    const value = code > 127 ? -2 : (BASE64_VALUES[code] as number);
    if (value >= 0) {
      bits = ((bits << 6) | value) & 0xff_ff_ff;
      count = (count + 1) & 3;
      if (count === 0) {
        output.push((bits >> 16) & 0xff, (bits >> 8) & 0xff, bits & 0xff);
        bits = 0;
      }
      continue;
    }
    if (value === -1 && count > 1) {
      if (count === 3) {
        if ((bits & 0x03) !== 0) fail('Invalid encoding before padding', position);
        output.push((bits >> 10) & 0xff, (bits >> 2) & 0xff);
      } else {
        if ((bits & 0x0f) !== 0) fail('Invalid encoding before padding', position);
        output.push((bits >> 4) & 0xff);
      }
      let expected = (3 - count) * 3;
      if (input[position] === '%') expected += 2;
      const remaining = checkBase64Padding(input, position + 1, expected, fail);
      if (remaining > 0) fail('Missing padding character', input.length);
      return output;
    }
    fail('Invalid character', position);
  }
  if (count > 0) fail('Invalid length, must be multiple of four', input.length);
  return output;
}

/** Checks the padding after the first `=` or `%3D`, returning how many padding characters are still missing. */
// code-gauge-allow functionNcss 38 -- A transcription of the SDK's _Base64Decoder._checkPadding, case by case.
// code-gauge-allow functionCognitiveComplexity 28 -- A transcription of the SDK's _Base64Decoder._checkPadding, case by case.
function checkBase64Padding(
  input: string,
  start: number,
  expectedPadding: number,
  fail: (message: string, offset: number) => never
): number {
  let position = start;
  let expected = expectedPadding;
  const end = input.length;
  if (position === end) return expected;
  while (expected > 0) {
    let char = input[position];
    if (expected === 3) {
      if (char === '=') {
        expected -= 3;
        position++;
        break;
      }
      if (char !== '%') break;
      expected--;
      position++;
      if (position === end) break;
      char = input[position];
    }
    const partial = expected > 3 ? expected - 3 : expected;
    if (partial === 2) {
      if (char !== '3') break;
      position++;
      expected--;
      if (position === end) break;
      char = input[position];
    }
    if (char.toLowerCase() !== 'd') break;
    position++;
    expected--;
    if (position === end) break;
  }
  if (position !== end) fail('Invalid padding character', position);
  return expected;
}
