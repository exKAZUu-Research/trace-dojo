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

  /** A value JSON cannot hold (NaN, a map with keys other than strings, an object) goes through toEncodable once. */
  write(current: Value, depth: number): string {
    this.runtime.spend();
    const direct = this.writeJsonValue(current, depth);
    if (direct !== undefined) return direct;
    const converted = this.writeJsonValue(this.convert(current), depth);
    if (converted === undefined) this.runtime.throwError('JsonUnsupportedObjectError', '', [current]);
    return converted;
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
    this.visiting.push(current);
    let converted: Value;
    try {
      converted =
        this.toEncodable === undefined
          ? runtime.invoke(current, 'toJson', { positional: [], named: undefined, isDynamic: true }, [], undefined)
          : runtime.callValue(this.toEncodable, { positional: [current], named: undefined }, [], runtime.userCallRow);
    } catch (error) {
      this.visiting.pop();
      if (error instanceof DartThrow)
        runtime.throwError('JsonUnsupportedObjectError', '', [current], { cause: error.value });
      throw error;
    }
    this.visiting.pop();
    return converted;
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

  // code-gauge-allow duplicateLines 15 -- Each function handles its own construct; the shared shape reads better than a helper with flags.
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
      if (this.text.startsWith(word, this.position)) {
        this.position += word.length;
        return result;
      }
    }
    return this.fail('Unexpected character');
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
    const start = this.position;
    this.position++;
    let result = '';
    for (;;) {
      if (this.position >= this.text.length) this.fail('Unterminated string', start);
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
        if (!/^[\da-fA-F]{4}$/.test(hex)) this.fail('Invalid unicode escape', this.position);
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        this.position += 4;
      } else {
        this.fail('Unrecognized string escape', this.position - 1);
      }
    }
  }

  number(): Value {
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.position));
    if (!match) this.fail('Unexpected character');
    this.position += match[0].length;
    if (match[1] === undefined && match[2] === undefined) {
      const value = BigInt(match[0]);
      if (value <= 9_223_372_036_854_775_807n && value >= -9_223_372_036_854_775_808n) return value;
    }
    return Number(match[0]);
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
  const bytes = Uint8Array.from(
    (codeUnits as DartList).elements.map((unit) => Number(intArg(runtime, unit, 'codeUnits')) & 0xff)
  );
  try {
    return new TextDecoder('utf-8', { fatal: allowMalformed !== true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return runtime.throwError('FormatException', '', ['Unexpected extension byte']);
  }
});
define('_base64Encode', (runtime, _receiver, [bytes, urlSafe]) => {
  const data = Uint8Array.from(
    (bytes as DartList).elements.map((unit) => Number(intArg(runtime, unit, 'bytes')) & 0xff)
  );
  const text = Buffer.from(data).toString('base64');
  return urlSafe === true ? text.replaceAll('+', '-').replaceAll('/', '_') : text;
});
define('_base64Decode', (runtime, _receiver, [source]) => {
  const text = stringArg(runtime, source, 'source').replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z\d+/]*={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1) {
    runtime.throwError('FormatException', '', ['Invalid character', source, 0n]);
  }
  return newList(runtime, interfaceType(coreTypes.int), [...Buffer.from(text, 'base64')].map(BigInt), false);
});
