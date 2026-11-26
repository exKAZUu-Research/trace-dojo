// code-gauge-allow-file fileNcss -- dart:convert's JSON, UTF-8, and Base64 codecs, each transcribed from the SDK.
import { LIMITS } from '../../interpreter/limits';
import { formatDouble } from '../format';
import { HashStore } from '../hashStore';
import { DartThrow, type Runtime } from '../runtime';
import { coreTypes, DYNAMIC, interfaceType } from '../types';
import { DartList, DartObject, DartPackedList, type Value } from '../values';
import { appendJsonQuoted, StringParts } from './boundedStringParts';
import { forEachEntry, newMap } from './nativeCollections';
import {
  define,
  defineConstructor,
  index,
  intArg,
  listElement,
  listLength,
  newList,
  registerPackedList,
  stringArg,
  throwUnavailable,
} from './nativeSupport';

function isMap(value: Value): value is DartObject {
  return value instanceof DartObject && value.native instanceof HashStore && value.native.isMap;
}

function encodeJson(runtime: Runtime, value: Value, toEncodable: Value, indent: string | undefined): string {
  return new JsonStringifier(runtime, toEncodable, indent).encode(value);
}

const JSON_OUTPUT_LIMIT = Symbol('JSON output limit');

/** Writes JSON as Dart's _JsonStringifier does: one case per kind of value, and toEncodable or toJson for the rest. */
class JsonStringifier {
  private readonly visiting: Value[] = [];
  private readonly output = new StringParts();
  private outputLength = 0;

  constructor(
    private readonly runtime: Runtime,
    private readonly toEncodable: Value,
    private readonly indent: string | undefined
  ) {}

  encode(value: Value): string {
    const roots = (): Iterable<Value> => this.visiting;
    this.runtime.roots.add(roots);
    try {
      this.write(value, 0);
      return this.output.text();
    } catch (error) {
      if (error === JSON_OUTPUT_LIMIT) this.runtime.throwError('OutOfMemoryError', '', []);
      throw error;
    } finally {
      this.runtime.roots.delete(roots);
    }
  }

  private write(current: Value, depth: number): void {
    const { runtime } = this;
    runtime.spend();
    if (this.writeJsonValue(current, depth)) return;
    if (this.visiting.includes(current)) runtime.throwError('JsonCyclicError', '', [current]);
    this.visiting.push(current);
    try {
      if (!this.writeJsonValue(this.convert(current), depth)) this.throwUnsupported(current);
    } catch (error) {
      if (error instanceof DartThrow) this.throwUnsupported(current, error.value);
      throw error;
    } finally {
      this.visiting.pop();
    }
  }

  private throwUnsupported(current: Value, cause?: Value): never {
    return this.runtime.throwError('JsonUnsupportedObjectError', '', [current], {
      cause,
      partialResult: this.output.text(),
    });
  }

  private writeJsonValue(current: Value, depth: number): boolean {
    if (current === undefined) return this.append('null');
    if (typeof current === 'boolean') return this.append(current ? 'true' : 'false');
    if (typeof current === 'bigint') return this.append(current.toString());
    if (typeof current === 'number') return Number.isFinite(current) && this.append(formatDouble(current));
    if (typeof current === 'string') return this.writeString(current);
    if (this.visiting.includes(current)) this.runtime.throwError('JsonCyclicError', '', [current]);
    if (current instanceof DartList || this.isA(current, 'List')) {
      this.writeList(current, depth);
      return true;
    }
    if (isMap(current) || this.isA(current, 'Map')) return this.writeMap(current, depth);
    return false;
  }

  private writeString(text: string): true {
    this.runtime.spend(Math.ceil(text.length / 1024));
    // oxlint-disable-next-line eslint/no-control-regex -- JSON escapes control characters.
    if (!/["\\\u0000-\u001F\uD800-\uDFFF]/u.test(text)) {
      this.checkCapacity(text.length + 2);
      return this.append('"' + text + '"');
    }
    appendJsonQuoted(text, (part) => this.append(part));
    return true;
  }

  private append(text: string): true {
    this.checkCapacity(text.length);
    this.runtime.spendString(text.length);
    this.outputLength += text.length;
    this.output.append(text);
    return true;
  }

  private checkCapacity(additionalLength: number): void {
    if (this.outputLength + additionalLength > LIMITS.maxStringLength) throw JSON_OUTPUT_LIMIT;
  }

  private lineBreak(depth: number): void {
    if (this.indent === undefined) return;
    const count = this.indent.length * depth;
    this.checkCapacity(count + 1);
    this.append('\n');
    this.append(this.indent.repeat(depth));
  }

  private isA(value: Value, className: 'List' | 'Map'): boolean {
    const cls = this.runtime.links.classNamed(className);
    const type = interfaceType(
      cls,
      cls.typeParams.map(() => DYNAMIC)
    );
    return value instanceof DartObject && this.runtime.links.isValueOf(this.runtime, value, type);
  }

  private writeList(list: Value, depth: number): void {
    const { runtime } = this;
    const frame = runtime.currentFrame;
    const mark = frame?.temporaries.length ?? 0;
    frame?.temporaries.push(list);
    this.visiting.push(list);
    try {
      const empty =
        this.indent === undefined
          ? runtime.getProperty(list, 'isNotEmpty', undefined) !== true
          : runtime.getProperty(list, 'isEmpty', undefined) === true;
      if (empty) {
        this.append('[]');
        return;
      }
      this.append('[');
      this.lineBreak(depth + 1);
      this.write(listElement(runtime, list, 0n), depth + 1);
      for (let index = 1n; index < listLength(runtime, list); index++) {
        this.append(',');
        this.lineBreak(depth + 1);
        this.write(listElement(runtime, list, index), depth + 1);
      }
      this.lineBreak(depth);
      this.append(']');
    } finally {
      this.visiting.pop();
      if (frame) frame.temporaries.length = mark;
    }
  }

  private writeMap(map: Value, depth: number): boolean {
    const { runtime } = this;
    const frame = runtime.currentFrame;
    const mark = frame?.temporaries.length ?? 0;
    frame?.temporaries.push(map);
    try {
      if (runtime.getProperty(map, 'isEmpty', undefined) === true) return this.append('{}');
      runtime.getProperty(map, 'length', undefined);
      const entries: [Value, Value][] = [];
      forEachEntry(runtime, map, (key, value) => {
        runtime.allocate(2);
        entries.push([key, value]);
        frame?.temporaries.push(key, value);
      });
      if (entries.some(([key]) => typeof key !== 'string')) return false;
      return this.writeMapEntries(map, entries, depth);
    } finally {
      if (frame) frame.temporaries.length = mark;
    }
  }

  private writeMapEntries(map: Value, entries: [Value, Value][], depth: number): true {
    this.visiting.push(map);
    try {
      this.append('{');
      for (const [index, [key, value]] of entries.entries()) {
        if (index > 0) this.append(',');
        this.lineBreak(depth + 1);
        this.writeString(key as string);
        this.append(this.indent === undefined ? ':' : ': ');
        this.write(value, depth + 1);
      }
      this.lineBreak(depth);
      return this.append('}');
    } finally {
      this.visiting.pop();
    }
  }

  /** The encodable value of another object, from toEncodable or the object's toJson. */
  private convert(current: Value): Value {
    const { runtime } = this;
    return this.toEncodable === undefined
      ? runtime.invoke(current, 'toJson', { positional: [], named: undefined, invocation: 'dynamic' }, [], undefined)
      : runtime.callValue(this.toEncodable, { positional: [current], named: undefined }, [], runtime.userCallRow);
  }
}

define('_jsonEncode', (runtime, _receiver, [value, toEncodable, indent]) =>
  encodeJson(runtime, value, toEncodable, indent === undefined ? undefined : stringArg(runtime, indent, 'indent'))
);

// oxlint-disable-next-line eslint/no-control-regex -- JSON requires control characters to be escaped.
const ORDINARY_JSON_STRING = /[^"\\\u0000-\u001F]{1,1024}/y;
const JSON_STRING_ESCAPES: Readonly<Record<string, string | undefined>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** A JSON parser that keeps Dart's distinction of ints and doubles and reports Dart's FormatException messages. */
class JsonParser {
  position = 0;

  constructor(
    private readonly runtime: Runtime,
    private readonly text: string,
    private readonly reviver: Value
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
    return this.revive(undefined, value);
  }

  // code-gauge-allow duplicateLines -- Each function handles its own construct; the shared shape reads better than a helper with flags.
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

  object(): Value {
    this.position++;
    const map = newMap(this.runtime, interfaceType(coreTypes.string), DYNAMIC);
    const store = map.native as HashStore;
    return this.readContainer(map, '}', () => {
      if (this.position >= this.text.length) this.fail('Unexpected end of input');
      if (this.text[this.position] !== '"') this.fail('Unexpected character');
      const key = this.string();
      this.skipSpace();
      if (this.position >= this.text.length) this.fail('Unexpected end of input');
      if (this.text[this.position] !== ':') this.fail('Unexpected character');
      this.position++;
      this.skipSpace();
      const value = this.value();
      return () => store.set(key, this.revive(key, value));
    });
  }

  array(): Value {
    this.position++;
    const list = newList(this.runtime, DYNAMIC, []);
    return this.readContainer(list, ']', () => {
      const value = this.value();
      return () => {
        const element = this.revive(BigInt(list.elements.length), value);
        this.runtime.allocate(1);
        list.elements.push(element);
      };
    });
  }

  private readContainer(container: DartObject, close: string, read: () => () => void): Value {
    return this.runtime.withCallRoots(container, { positional: [], named: undefined }, () => {
      this.skipSpace();
      if (this.text[this.position] === close) {
        this.position++;
        return container;
      }
      for (;;) {
        this.skipSpace();
        const commit = read();
        this.skipSpace();
        if (this.position >= this.text.length) this.fail('Unexpected end of input');
        const delimiter = this.text[this.position++];
        if (delimiter !== close && delimiter !== ',') this.fail('Unexpected character', this.position - 1);
        commit();
        if (delimiter === close) return container;
      }
    });
  }

  private revive(key: Value, value: Value): Value {
    if (this.reviver === undefined) return value;
    const args = { positional: [key, value], named: undefined };
    return this.runtime.withCallRoots(this.reviver, args, () =>
      this.runtime.callValue(this.reviver, args, [], this.runtime.userCallRow)
    );
  }

  string(): string {
    this.position++;
    const result = new StringParts();
    while (this.position < this.text.length) {
      this.runtime.spend();
      ORDINARY_JSON_STRING.lastIndex = this.position;
      const run = ORDINARY_JSON_STRING.exec(this.text);
      if (run) {
        this.runtime.spendString(run[0].length);
        result.append(run[0]);
        this.position = ORDINARY_JSON_STRING.lastIndex;
        continue;
      }
      const char = this.text[this.position++];
      if (char === '"') return result.text();
      if (char !== '\\') this.fail('Control character in string', this.position - 1);
      result.append(this.stringEscape());
    }
    return this.fail('Unterminated string', this.text.length);
  }

  private stringEscape(): string {
    if (this.position >= this.text.length) this.fail('Unterminated string', this.text.length);
    const escape = this.text[this.position++];
    const simple = JSON_STRING_ESCAPES[escape];
    if (simple !== undefined) return simple;
    if (escape !== 'u') this.fail('Unrecognized string escape', this.position);
    const hex = this.text.slice(this.position, this.position + 4);
    if (!/^[\da-fA-F]*$/.test(hex)) this.fail('Invalid unicode escape', this.position - 1);
    if (hex.length < 4) this.fail('Unterminated string', this.text.length);
    this.position += 4;
    return String.fromCodePoint(Number.parseInt(hex, 16));
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

define('_jsonDecode', (runtime, _receiver, [source, reviver]) =>
  new JsonParser(runtime, stringArg(runtime, source, 'source'), reviver).parse()
);

// UTF-8 and Base64

registerPackedList('_Uint8List');
defineConstructor('_Uint8List.new', (runtime, _instance, args) => {
  const size = intArg(runtime, args.positional[0], 'length');
  if (size < 0n) runtime.throwError('RangeError', 'range', [size, 0n, undefined, 'length']);
  runtime.allocate(Number(size) + 1);
  return new DartPackedList(runtime.links.classNamed('_Uint8List'), new Uint8Array(Number(size)));
});
define('_Uint8List.[]=', (runtime, receiver, [position, value]) => {
  const list = receiver as DartPackedList;
  const at = intArg(runtime, position, 'index');
  if (at < 0n || at >= BigInt(list.length)) {
    runtime.throwError('IndexError', '', [at, list, 'index', undefined, BigInt(list.length)]);
  }
  (list.contents as Uint8Array)[index(at)] = Number(BigInt.asUintN(8, intArg(runtime, value, 'value')));
  return;
});

define('_Uint8List.sublist', (runtime, receiver, [start, end]) => {
  const list = receiver as DartPackedList;
  const [from, to] = conversionRange(runtime, BigInt(list.length), start, end);
  runtime.allocate(to - from + 1);
  const view = (list.contents as Uint8Array).subarray(from, to);
  return new DartPackedList(list.cls, Uint8Array.from(view));
});

define('_utf8Encode', (runtime, _receiver, [input, start = 0n, end]) => {
  const source = stringArg(runtime, input, 'input');
  const [from, to] = conversionRange(runtime, BigInt(source.length), start, end);
  const text = source.slice(from, to);
  runtime.spend(Math.ceil(text.length / 64));
  let size = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    size += code < 0x80 ? 1 : code < 0x8_00 ? 2 : code < 0x1_00_00 ? 3 : 4;
  }
  runtime.allocate(size + 1);
  return new DartPackedList(runtime.links.classNamed('_Uint8List'), new TextEncoder().encode(text));
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

/** The state of a Dart `_Utf8Decoder`, kept in its fields, which `flush` and `expectsContinuation` read in Dart. */
interface DecoderState {
  allowMalformed: boolean;
  state: number;
  charOrIndex: number;
  bomIndex: number;
}

const DECODER_FIELDS = ['allowMalformed', '_state', '_charOrIndex', '_bomIndex'] as const;

function decoderSlots(decoder: DartObject): number[] {
  return DECODER_FIELDS.map((name) => {
    const field = decoder.cls.fields.find((member) => member.name === name);
    if (!field) throw new Error(`_Utf8Decoder has no field ${name}.`);
    return field.slot;
  });
}

function readDecoder(decoder: DartObject, slots: number[]): DecoderState {
  const [allowMalformed, state, charOrIndex, bomIndex] = slots.map((slot) => decoder.fields[slot]);
  return {
    allowMalformed: allowMalformed === true,
    state: Number(state),
    charOrIndex: Number(charOrIndex),
    bomIndex: Number(bomIndex),
  };
}

function writeDecoder(decoder: DartObject, slots: number[], { state, charOrIndex, bomIndex }: DecoderState): void {
  decoder.fields[slots[1] as number] = BigInt(state);
  decoder.fields[slots[2] as number] = BigInt(charOrIndex);
  decoder.fields[slots[3] as number] = BigInt(bomIndex);
}

const isErrorState = (state: number): boolean => (state & 1) !== 0;

/**
 * Decodes bytes from the decoder's state as the SDK's `_Utf8Decoder.decodeGeneral` does (utf.dart), leaving the
 * state after them, or the error state and the error's index when it does not allow malformed input.
 */
function decodeGeneral(decoder: DecoderState, bytes: Uint8Array, start: number, end: number, single: boolean): string {
  let { state, charOrIndex: char } = decoder;
  const units: number[] = [];
  for (let index = start; index < end;) {
    const byte = bytes[index++] as number;
    const type = UTF8_TYPES.charCodeAt(byte) & 0x1f;
    char = state <= AB ? byte & (0xf0_fe >> type) : (byte & 0x3f) | (char << 6);
    state = UTF8_TRANSITIONS[state + type] as number;
    if (state === IA) {
      units.push(char);
      continue;
    }
    if (!isErrorState(state)) continue;
    if (!decoder.allowMalformed) {
      Object.assign(decoder, { state, charOrIndex: index - 1 });
      return '';
    }
    index -= replaceMalformed(state, units);
    state = IA;
  }
  if (single && state > AB) {
    if (!decoder.allowMalformed) {
      Object.assign(decoder, { state: E7, charOrIndex: end });
      return '';
    }
    units.push(0xff_fd);
  }
  Object.assign(decoder, { state, charOrIndex: char });
  return fromCodePoints(units);
}

/** The text of code points, built a bounded number at a time, as a call takes only so many arguments. */
function fromCodePoints(units: readonly number[]): string {
  let text = '';
  for (let start = 0; start < units.length; start += 0x20_00) {
    text += String.fromCodePoint(...units.slice(start, start + 0x20_00));
  }
  return text;
}

/**
 * Writes the replacement of malformed input that ended in an error state, giving how many bytes to read again: a byte
 * that cannot start a sequence is replaced; an unfinished sequence before a byte that can start one is replaced and
 * that byte read again; one before a byte that cannot is replaced with the byte.
 */
function replaceMalformed(state: number, units: number[]): number {
  units.push(0xff_fd);
  if (state === E1) return 1;
  if (state !== E3 && state !== E2) units.push(0xff_fd);
  return 0;
}

/** The bytes the VM's decoder reads, a value that is not a byte being replaced with 0xFF, which is invalid. */
function decoderBytes(runtime: Runtime, codeUnits: Value, start: Value, end: Value): [Uint8Array, number] {
  const length = listLength(runtime, codeUnits);
  const to = end === undefined || end === null ? length : (end as bigint);
  if ((start as bigint) < 0n || (start as bigint) > length) {
    runtime.throwError('RangeError', 'range', [start, 0n, length, 'start']);
  }
  if (to < (start as bigint) || to > length) runtime.throwError('RangeError', 'range', [to, start, length, 'end']);
  const bytes = readByteList(
    runtime,
    codeUnits,
    'codeUnits',
    (value) => (value >= 0n && value <= 0xffn ? Number(value) : 0xff),
    [start, to]
  );
  return [bytes, Number(start)];
}

function failDecoding(runtime: Runtime, codeUnits: Value, state: DecoderState, errorOffset: number): never {
  return runtime.throwError('FormatException', '', [
    UTF8_ERRORS[state.state] as string,
    codeUnits,
    BigInt(errorOffset + state.charOrIndex),
  ]);
}

/**
 * The VM's patch of _Utf8Decoder (convert_patch.dart): a single conversion skips a BOM and fails an unfinished
 * sequence at the end; a chunked one skips a BOM split across chunks and keeps an unfinished sequence for the next.
 */
function convertUtf8(
  runtime: Runtime,
  receiver: Value,
  [codeUnits, start, maybeEnd]: Value[],
  single: boolean
): string {
  const decoder = receiver as DartObject;
  const slots = decoderSlots(decoder);
  const state = readDecoder(decoder, slots);
  const [bytes, errorOffset] = decoderBytes(runtime, codeUnits, start, maybeEnd);
  const from = single ? skipBomSingle(bytes) : skipBomChunked(state, bytes);
  if (from === bytes.length) {
    writeDecoder(decoder, slots, state);
    return '';
  }
  chargeCodecString(runtime, bytes.length);
  const fast = { ...state, allowMalformed: false };
  const result = decodeGeneral(fast, bytes, from, bytes.length, false);
  if (single ? fast.state === IA : !isErrorState(fast.state)) {
    writeDecoder(decoder, slots, fast);
    return result;
  }
  if (!state.allowMalformed) {
    if (single && !isErrorState(fast.state)) Object.assign(fast, { state: E7, charOrIndex: bytes.length });
    // A chunked decoder is ready for more input after an error.
    writeDecoder(decoder, slots, single ? fast : { ...fast, state: IA });
    return failDecoding(runtime, codeUnits, fast, errorOffset);
  }
  // Start over on the slow path, which replaces malformed input.
  const slow = single ? { ...state, state: IA } : { ...state };
  const replaced = decodeGeneral(slow, bytes, from, bytes.length, single);
  writeDecoder(decoder, slots, slow);
  return replaced;
}

define('_Utf8Decoder.convertSingle', (runtime, receiver, args) => convertUtf8(runtime, receiver, args, true));
define('_Utf8Decoder.convertChunked', (runtime, receiver, args) => convertUtf8(runtime, receiver, args, false));

function skipBomSingle(bytes: Uint8Array): number {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
}

/** Skips a BOM that may be split across chunks, as the VM's `skipBomChunked` does, giving where decoding starts. */
function skipBomChunked(state: DecoderState, bytes: Uint8Array): number {
  if (state.bomIndex === -1) return 0;
  const bom = [0xef, 0xbb, 0xbf];
  let index = 0;
  while (state.bomIndex < 3) {
    if (index === bytes.length) return 0;
    if (bytes[index++] !== bom[state.bomIndex++]) {
      state.bomIndex = -1;
      return 0;
    }
  }
  state.bomIndex = -1;
  state.state = IA;
  return index;
}
/* oxlint-enable unicorn/prefer-code-point */

define('_base64Encode', (runtime, _receiver, [bytes, urlSafe]) => {
  if (runtime.getProperty(bytes, 'isEmpty', undefined) === true) return '';
  let hasInvalid = false;
  const data = readByteList(runtime, bytes, 'bytes', (value) => {
    if (value < 0n || value > 0xffn) hasInvalid = true;
    return Number(value & 0xffn);
  });
  if (hasInvalid) invalidBase64Byte(runtime, bytes, data.length);
  chargeCodecString(runtime, Math.ceil(data.length / 3) * 4);
  let binary = '';
  for (let start = 0; start < data.length; start += 0x20_00) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- Each byte becomes one code unit for btoa.
    binary += String.fromCharCode(...data.subarray(start, start + 0x20_00));
  }
  const text = btoa(binary);
  return urlSafe === true ? text.replaceAll('+', '-').replaceAll('/', '_') : text;
});

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The text of bytes a run writes to a standard stream in parts: the bytes of a character the parts split wait in
 * `pending` for the rest of it, as one decoder holds them for a file sink; the rest is decoded as textOfWrittenBytes
 * decodes it.
 */
export function textOfWrittenPart(runtime: Runtime, pending: number[], bytes: Value): string {
  const read = readByteList(runtime, bytes, 'buffer', (value) =>
    value >= 0n && value <= 0xffn ? Number(value) : 0xff
  );
  const all = pending.length > 0 ? Uint8Array.of(...pending, ...read) : read;
  const cut = all.length - unfinishedTail(all);
  pending.splice(0, pending.length, ...all.subarray(cut));
  try {
    return STRICT_UTF8.decode(all.subarray(0, cut));
  } catch {
    return throwUnavailable(runtime, 'UTF-8 でないバイト列の書き込み');
  }
}

/** How many bytes at the end begin a character that needs more of them. */
function unfinishedTail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? back : 0;
  }
  return 0;
}

/**
 * The text of bytes a run writes to a standard stream, which holds text: bytes that are not UTF-8 are rejected, as
 * dart:io's _textOfBytes rejects them. A byte order mark stays, as the VM writes the bytes as they are.
 */
export function textOfWrittenBytes(runtime: Runtime, bytes: Value): string {
  const read = readByteList(runtime, bytes, 'buffer', (value) =>
    value >= 0n && value <= 0xffn ? Number(value) : 0xff
  );
  try {
    return STRICT_UTF8.decode(read);
  } catch {
    return throwUnavailable(runtime, 'UTF-8 でないバイト列の書き込み');
  }
}

function readByteList(
  runtime: Runtime,
  list: Value,
  parameter: string,
  convert: (value: bigint) => number,
  range?: readonly [Value, Value]
): Uint8Array {
  const length = listLength(runtime, list);
  if (length < 0n) runtime.throwError('RangeError', 'range', [length, 0n, undefined, 'length']);
  const [start, end] = range ? conversionRange(runtime, length, ...range) : [0, Number(length)];
  runtime.spend(1 + end - start);
  const bytes = new Uint8Array(end - start);
  for (let position = 0; position < bytes.length; position++) {
    bytes[position] = convert(intArg(runtime, listElement(runtime, list, BigInt(start + position)), parameter));
  }
  return bytes;
}

function invalidBase64Byte(runtime: Runtime, bytes: Value, length: number): never {
  let position = 0n;
  for (; position < BigInt(length); position++) {
    const value = intArg(runtime, listElement(runtime, bytes, position), 'bytes');
    runtime.spend();
    if (value < 0n || value > 0xffn) break;
  }
  const offending = intArg(runtime, listElement(runtime, bytes, position), 'bytes');
  runtime.throwError('ArgumentError', 'value', [
    bytes,
    `Not a byte value at index ${position}: 0x${offending.toString(16)}`,
  ]);
}
define('_base64Decode', (runtime, _receiver, [source, start, end]) => {
  const input = stringArg(runtime, source, 'source');
  const [from, to] = conversionRange(runtime, BigInt(input.length), start, end);
  const fail = (message: string, offset: number): never =>
    runtime.throwError('FormatException', '', [message, input, BigInt(from + offset)]);
  runtime.spend(1 + (to - from) / 64);
  const encodedLength = validatedBase64Length(input.slice(from, to), fail);
  runtime.allocate(Math.floor((encodedLength * 3) / 4) + 1);
  const binary = atob(
    input
      .slice(from, from + encodedLength)
      .replaceAll('-', '+')
      .replaceAll('_', '/')
  );
  // oxlint-disable-next-line unicorn/prefer-code-point -- atob returns each byte as one code unit.
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new DartPackedList(runtime.links.classNamed('_Uint8List'), bytes);
});

define('_base64Normalize', (runtime, _receiver, [source, start, end]) => {
  const input = stringArg(runtime, source, 'source');
  const [from, to] = conversionRange(runtime, BigInt(input.length), start, end);
  return normalizeBase64(runtime, input, from, to);
});

function conversionRange(runtime: Runtime, length: bigint, start: Value, end: Value): [number, number] {
  const from = intArg(runtime, start, 'start');
  const to = end === undefined ? length : intArg(runtime, end, 'end');
  if (from < 0n || from > length) runtime.throwError('RangeError', 'range', [from, 0n, length, 'start']);
  if (to < from || to > length) runtime.throwError('RangeError', 'range', [to, from, length, 'end']);
  return [Number(from), Number(to)];
}

function chargeCodecString(runtime: Runtime, length: number): void {
  if (length > LIMITS.maxStringLength) runtime.throwError('OutOfMemoryError', '', []);
  runtime.spendString(length);
}

// code-gauge-allow functionCognitiveComplexity -- Preserve the SDK order of Base64 normalization and validation.
// code-gauge-allow functionNcss -- The selected range and original offsets belong to the same scan.
function normalizeBase64(runtime: Runtime, input: string, start: number, end: number): string {
  const fail = (message: string, offset: number): never =>
    runtime.throwError('FormatException', '', [message, input, BigInt(offset)]);
  runtime.spend(1 + (end - start) / 64);
  const normalized = new StringParts();
  let length = 0;
  let padOffset = end;
  let firstPad = -1;
  let padding = 0;
  for (let i = start; i < end; i++) {
    const offset = i;
    let char = input[i];
    if (char === '%') {
      const hex = input.slice(i + 1, Math.min(i + 3, end));
      if (!/^[\da-f]{2}$/i.test(hex)) fail('Invalid base64 data', offset);
      char = String.fromCodePoint(Number.parseInt(hex, 16));
      i += 2;
    }
    if (char === '=') {
      if (firstPad < 0) {
        padOffset = offset;
        firstPad = length;
      }
      padding++;
      normalized.append(char);
    } else {
      const value = BASE64_VALUES[char.codePointAt(0) ?? 128] ?? -2;
      if (value < 0) fail('Invalid base64 data', offset);
      normalized.append(BASE64_ALPHABET[value]);
    }
    length++;
  }
  if (firstPad >= 0) {
    if (length % 4 !== 0) fail(`Invalid base64 padding, padded length must be multiple of four, is ${length}`, end);
    if (firstPad + padding !== length) fail("Invalid base64 padding, '=' not at the end", padOffset);
    if (padding > 2) fail("Invalid base64 padding, more than two '=' characters", padOffset);
  } else {
    if (length % 4 === 1) fail('Invalid base64 encoding length ', end);
  }
  const addedPadding = firstPad < 0 ? (4 - (length % 4)) % 4 : 0;
  chargeCodecString(runtime, input.length - (end - start) + length + addedPadding);
  return input.slice(0, start) + normalized.text() + '='.repeat(addedPadding) + input.slice(end);
}

/** The inverse of the Base64 alphabets, both the standard and the URL-safe one: -1 for padding, -2 for others. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES: readonly number[] = Array.from({ length: 128 }, (_, code) => {
  const char = String.fromCodePoint(code);
  if (char === '=' || char === '%') return -1;
  if (char === '-' || char === '+') return 62;
  if (char === '_' || char === '/') return 63;
  const index = BASE64_ALPHABET.indexOf(char);
  return index === -1 ? -2 : index;
});

/** The complete valid data before padding, validating even the discarded bits in the last sextet. */
// code-gauge-allow functionCognitiveComplexity -- Validate the final quantum and source-aware padding in one scan.
function validatedBase64Length(input: string, fail: (message: string, offset: number) => never): number {
  let last = 0;
  let count = 0;
  // As the SDK's decodeChunk, a code unit is looked up by its low seven bits, and one beyond ASCII is reported
  // only when no character before the end, or before padding, is invalid by that lookup.
  let firstNonAscii = -1;
  for (let position = 0; position < input.length; position++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- Base64 reads UTF-16 code units.
    const code = input.charCodeAt(position);
    if (code > 127 && firstNonAscii < 0) firstNonAscii = position;
    const value = BASE64_VALUES[code & 0x7f] as number;
    if (value >= 0) {
      last = value;
      count = (count + 1) & 3;
      continue;
    }
    if (value !== -1 || count <= 1) fail('Invalid character', position);
    if (firstNonAscii >= 0) break;
    if ((last & (count === 3 ? 0x03 : 0x0f)) !== 0) fail('Invalid encoding before padding', position);
    const expected = (3 - count) * 3 + (input[position] === '%' ? 2 : 0);
    const remaining = checkBase64Padding(input, position + 1, expected, fail);
    if (remaining > 0) fail('Missing padding character', input.length);
    return position;
  }
  if (firstNonAscii >= 0) fail('Invalid character', firstNonAscii);
  if (count > 0) fail('Invalid length, must be multiple of four', input.length);
  return input.length;
}

/** Checks the padding after the first `=` or `%3D`, returning how many padding characters are still missing. */
// code-gauge-allow functionNcss -- A transcription of the SDK's _Base64Decoder._checkPadding, case by case.
// code-gauge-allow functionCognitiveComplexity -- A transcription of the SDK's _Base64Decoder._checkPadding, case by case.
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
