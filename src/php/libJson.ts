// code-gauge-allow-file fileNcss 489 -- Keeps PHP's encoder and parser with their shared flag and error definitions.
// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { codePointBytes, enc, utf8Length } from './bytes';
import { callMethod, consumeInvokedResult } from './callables';
import {
  canAccessProp,
  createObject,
  declForKey,
  nativePropertySlot,
  objectPropertyKeys,
  propNameOf,
  readProp,
  snapshotDynamicProperties,
} from './classes';
import * as conversionsModule from './conversions';
import { formatFloatRepr } from './conversions';
import { type CleanupException, isCleanupException, newThrowable, throwError, withCleanupExceptions } from './errors';
import { nextChar } from './htmlEntities';
import { defineConstant, defineFunction } from './native';
import { ExitSignal, PhpThrow, rt } from './runtime';
import { PhpArray, type PhpClass, PhpObject, type PropDecl, Ref, UNDEFINED_RESULT, type Value } from './values';

const FLAGS: [string, bigint][] = [
  ['JSON_HEX_TAG', 1n],
  ['JSON_HEX_AMP', 2n],
  ['JSON_HEX_APOS', 4n],
  ['JSON_HEX_QUOT', 8n],
  ['JSON_FORCE_OBJECT', 16n],
  ['JSON_NUMERIC_CHECK', 32n],
  ['JSON_UNESCAPED_SLASHES', 64n],
  ['JSON_PRETTY_PRINT', 128n],
  ['JSON_UNESCAPED_UNICODE', 256n],
  ['JSON_PARTIAL_OUTPUT_ON_ERROR', 512n],
  ['JSON_PRESERVE_ZERO_FRACTION', 1024n],
  ['JSON_UNESCAPED_LINE_TERMINATORS', 2048n],
  ['JSON_OBJECT_AS_ARRAY', 1n],
  ['JSON_BIGINT_AS_STRING', 2n],
  ['JSON_INVALID_UTF8_IGNORE', 1_048_576n],
  ['JSON_INVALID_UTF8_SUBSTITUTE', 2_097_152n],
  ['JSON_THROW_ON_ERROR', 4_194_304n],
  ['JSON_ERROR_NONE', 0n],
  ['JSON_ERROR_DEPTH', 1n],
  ['JSON_ERROR_STATE_MISMATCH', 2n],
  ['JSON_ERROR_CTRL_CHAR', 3n],
  ['JSON_ERROR_SYNTAX', 4n],
  ['JSON_ERROR_UTF8', 5n],
  ['JSON_ERROR_RECURSION', 6n],
  ['JSON_ERROR_INF_OR_NAN', 7n],
  ['JSON_ERROR_UNSUPPORTED_TYPE', 8n],
  ['JSON_ERROR_INVALID_PROPERTY_NAME', 9n],
  ['JSON_ERROR_UTF16', 10n],
  ['JSON_ERROR_NON_BACKED_ENUM', 11n],
];
for (const [name, value] of FLAGS) defineConstant(name, value);

const MESSAGES: Record<number, string> = {
  0: 'No error',
  1: 'Maximum stack depth exceeded',
  2: 'State mismatch (invalid or malformed JSON)',
  3: 'Control character error, possibly incorrectly encoded',
  4: 'Syntax error',
  5: 'Malformed UTF-8 characters, possibly incorrectly encoded',
  6: 'Recursion detected',
  7: 'Inf and NaN cannot be JSON encoded',
  8: 'Type is not supported',
  9: 'The decoded property name is invalid',
  10: 'Single unpaired UTF-16 surrogate in unicode escape',
  11: 'Non-backed enums have no default serialization',
};
const PARTIAL_OUTPUT_ON_ERROR = 512n;
const THROW_ON_ERROR = 4_194_304n;

class JsonError {
  constructor(readonly code: number) {}
}

const has = (flags: bigint, flag: bigint): boolean => (flags & flag) !== 0n;

defineFunction('json_encode(mixed $value, int $flags = 0, int $depth = 512): string|false', ({ args }) => {
  const flags = (args[1] as bigint | undefined) ?? 0n;
  return encodeJson(args[0], flags, Number((args[2] as bigint | undefined) ?? 512n));
});

function encodeJson(value: Value, flags: bigint, depth: number): string | false {
  const runtime = rt();
  const partial = has(flags, PARTIAL_OUTPUT_ON_ERROR);
  let result: string | false = false;
  withCleanupExceptions(
    runtime,
    (capture) => {
      const encoder = new JsonEncoder(flags, depth, capture);
      const text = encoder.document(value);
      const code = encoder.error;
      if (!has(flags, THROW_ON_ERROR) || partial) runtime.lastJsonError = code;
      else if (code !== 0 && !encoder.exiting)
        throw new PhpThrow(newThrowable('JsonException', MESSAGES[code], BigInt(code)));
      if (code === 0 || partial) result = text as string;
    },
    'latest'
  );
  return result;
}

/** Transcribes ext/json/json_encoder.c: an error sets `error`, and without JSON_PARTIAL_OUTPUT_ON_ERROR aborts the encoding where PHP returns FAILURE. */
class JsonEncoder {
  error = 0;
  private readonly active = new Set<object>();
  private interruption: 'exit' | 'exception' | undefined;

  constructor(
    private readonly flags: bigint,
    private readonly maxDepth: number,
    private readonly capture: (error: CleanupException) => void
  ) {}

  document(value: Value): string | undefined {
    try {
      return this.encode(value, 0);
    } catch (error) {
      if (!(error instanceof JsonError)) this.interrupt(error);
    }
  }

  get exiting(): boolean {
    return this.interruption === 'exit';
  }

  private interrupt(error: unknown): void {
    if (!isCleanupException(error)) throw error;
    this.interruption = error instanceof ExitSignal ? 'exit' : 'exception';
    this.capture(error);
  }

  // code-gauge-allow functionCognitiveComplexity 22 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private encode(value: Value, level: number): string {
    rt().spend();
    if (value === null) return 'null';
    if (value === UNDEFINED_RESULT) return this.fail(8);
    switch (typeof value) {
      case 'boolean': {
        return value ? 'true' : 'false';
      }
      case 'bigint': {
        return value.toString();
      }
      case 'number': {
        if (Number.isFinite(value)) return this.encodeFloat(value);
        // PHP keeps encoding after this error, so a later error decides the error code.
        this.error = 7;
        return '0';
      }
      case 'string': {
        const numeric = has(this.flags, 32n) ? conversionsModule.numericValue(value) : undefined;
        if (numeric !== undefined && (typeof numeric === 'bigint' || Number.isFinite(numeric)))
          return this.encode(numeric, level);
        return this.encodeString(value, this.flags);
      }
    }
    if (value instanceof PhpObject) {
      if (value.isResource) return this.fail(8);
      if (value.cls.kind === 'enum') return this.fail(11);
    }
    const serializable = rt().classes.get('jsonserializable') as PhpClass;
    if (value instanceof PhpArray || !value.cls.isSubclassOf(serializable)) return this.encodeContainer(value, level);
    return this.encodeSerializable(value, level);
  }

  private encodeSerializable(value: PhpObject, level: number): string {
    if (this.active.has(value)) return this.fail(6);
    if (this.interruption) return this.serializerFailure();
    this.active.add(value);
    try {
      const encoded = this.encodeUserResult(
        () => callMethod(value, 'jsonSerialize', []),
        (result) => {
          try {
            if (result !== value) return this.encode(result, level);
            this.active.delete(value);
            return this.encodeContainer(value, level);
          } finally {
            this.active.delete(value);
          }
        }
      );
      return encoded ?? this.serializerFailure();
    } finally {
      this.active.delete(value);
    }
  }

  private serializerFailure(): string {
    if (has(this.flags, PARTIAL_OUTPUT_ON_ERROR)) return 'null';
    throw new JsonError(this.error);
  }

  private encodeUserResult(call: () => Value, encode: (value: Value) => string): string | undefined {
    let encoded: string | JsonError | undefined;
    try {
      consumeInvokedResult(
        call,
        (value) => {
          try {
            encoded = encode(value);
          } catch (error) {
            if (!(error instanceof JsonError)) throw error;
            encoded = error;
          }
        },
        { releaseOnExit: true, releaseMode: 'complete' }
      );
    } catch (error) {
      this.interrupt(error);
    }
    if (encoded instanceof JsonError) throw encoded;
    return encoded;
  }

  private encodeFloat(value: number): string {
    const text = formatFloatRepr(value, 'e');
    if (has(this.flags, 1024n) && Number.isInteger(value) && !/[.e]/.test(text)) return `${text}.0`;
    return text;
  }

  private encodeContainer(value: PhpArray | PhpObject, level: number): string {
    if (this.active.has(value)) {
      this.error = 6;
      if (has(this.flags, PARTIAL_OUTPUT_ON_ERROR)) return 'null';
      throw new JsonError(6);
    }
    this.active.add(value);
    let text: string;
    try {
      text = value instanceof PhpArray ? this.encodeArray(value, level) : this.encodeObject(value, level);
    } catch (error) {
      if (!(error instanceof JsonError) || !has(this.flags, PARTIAL_OUTPUT_ON_ERROR)) throw error;
      return 'null';
    } finally {
      this.active.delete(value);
    }
    if (level + 1 > this.maxDepth) {
      this.error = 1;
      if (!has(this.flags, PARTIAL_OUTPUT_ON_ERROR)) throw new JsonError(1);
    }
    return text;
  }

  private encodeArray(value: PhpArray, level: number): string {
    const list = value.isList() && !has(this.flags, 16n);
    return wrap(this.arrayMembers(value, level, list), list ? '[' : '{', list ? ']' : '}', this.flags, level);
  }

  private *arrayMembers(value: PhpArray, level: number, list: boolean): Generator<string> {
    const snapshot = [...value.map];
    for (const [key, slot] of snapshot) {
      const item = slot instanceof Ref ? slot.v : slot;
      yield list ? this.encode(item, level + 1) : this.member(String(key), item, level);
    }
  }

  private encodeObject(object: PhpObject, level: number): string {
    return wrap(this.objectMembers(object, level), '{', '}', this.flags, level);
  }

  private *objectMembers(object: PhpObject, level: number): Generator<string> {
    const table = (object.internal as { properties?: () => PhpArray } | undefined)?.properties?.();
    if (table) {
      for (const [key, item] of table.entries()) {
        if (typeof key === 'string' && key.startsWith('\0')) continue;
        yield this.member(String(key), item, level);
      }
      return;
    }
    yield* this.declaredAndDynamicMembers(object, level);
  }

  private *declaredAndDynamicMembers(object: PhpObject, level: number): Generator<string> {
    const keys = objectPropertyKeys(object);
    const dynamic = snapshotDynamicProperties(object);
    const runtime = rt();
    const dynamicRoot = runtime.held.length;
    runtime.held.push(dynamic);
    try {
      for (const key of keys) {
        const decl = declForKey(object.cls, key);
        if (decl && !canAccessProp(decl, undefined)) continue;
        if (decl?.hooks?.get) {
          yield this.hookedMember(object, decl, level);
          continue;
        }
        const slot = decl ? nativePropertySlot(object, key, decl) : dynamic.map.get(key);
        if (slot === undefined) continue;
        yield this.member(propNameOf(key), slot instanceof Ref ? slot.v : slot, level);
      }
    } finally {
      runtime.held.splice(dynamicRoot, 1);
      runtime.release([dynamic]);
    }
  }

  private hookedMember(object: PhpObject, decl: PropDecl, level: number): string {
    if (this.interruption) throw new JsonError(this.error);
    const member = this.encodeUserResult(
      () => readProp(object, decl.name, decl.cls, 'native'),
      (item) => this.member(decl.name, item, level)
    );
    if (member === undefined) throw new JsonError(this.error);
    return member;
  }

  private member(key: string, item: Value, level: number): string {
    let name = this.encodeString(key, this.flags & ~32n);
    if (name === 'null') name = '""';
    const value = this.encode(item, level + 1);
    rt().ensureStringFits(name.length + value.length + (has(this.flags, 128n) ? 2 : 1));
    return `${name}:${has(this.flags, 128n) ? ' ' : ''}${value}`;
  }

  private fail(code: number): string {
    this.error = code;
    if (has(this.flags, PARTIAL_OUTPUT_ON_ERROR)) return 'null';
    throw new JsonError(code);
  }

  private encodeString(text: string, flags: bigint): string {
    let result = '"';
    let index = 0;
    while (index < text.length) {
      if (text.charCodeAt(index) < 0x80) {
        const escaped = escapeAscii(text[index++], flags);
        rt().ensureStringFits(result.length + escaped.length + 1);
        result += escaped;
        continue;
      }
      const [length, point] = nextChar(text, index);
      const encoded =
        point === undefined ? invalidByte(flags) : encodeCharacter(text.slice(index, index + length), flags);
      if (encoded === undefined) return this.fail(5);
      rt().ensureStringFits(result.length + encoded.length + 1);
      result += encoded;
      index += length;
    }
    return `${result}"`;
  }
}

/** The escapes that a flag switches: the flag, the text with the flag, and the text without it. */
const FLAGGED_ESCAPES: Record<string, [bigint, string, string]> = {
  '"': [8n, String.raw`\u0022`, String.raw`\"`],
  '/': [64n, '/', String.raw`\/`],
  '<': [1n, String.raw`\u003C`, '<'],
  '>': [1n, String.raw`\u003E`, '>'],
  '&': [2n, String.raw`\u0026`, '&'],
  "'": [4n, String.raw`\u0027`, "'"],
};

const FIXED_ESCAPES: Record<string, string> = {
  '\\': String.raw`\\`,
  '\b': String.raw`\b`,
  '\f': String.raw`\f`,
  '\n': String.raw`\n`,
  '\r': String.raw`\r`,
  '\t': String.raw`\t`,
};

function escapeAscii(char: string, flags: bigint): string {
  const flagged = FLAGGED_ESCAPES[char] as [bigint, string, string] | undefined;
  if (flagged) return has(flags, flagged[0]) ? flagged[1] : flagged[2];
  const fixed = FIXED_ESCAPES[char] as string | undefined;
  if (fixed !== undefined) return fixed;
  const code = char.charCodeAt(0);
  return code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
}

/** What an invalid UTF-8 byte becomes, or undefined when it is an error. */
function invalidByte(flags: bigint): string | undefined {
  if (has(flags, 1_048_576n)) return '';
  if (has(flags, 2_097_152n)) return has(flags, 256n) ? '\u00EF\u00BF\u00BD' : String.raw`\ufffd`;
  return undefined;
}

function encodeCharacter(bytes: string, flags: bigint): string {
  const point = decodePoint(bytes);
  if (has(flags, 256n) && (has(flags, 2048n) || (point !== 0x20_28 && point !== 0x20_29))) return bytes;
  if (point < 0x1_00_00) return `\\u${point.toString(16).padStart(4, '0')}`;
  const offset = point - 0x1_00_00;
  return `\\u${(0xd8_00 + (offset >> 10)).toString(16)}\\u${(0xdc_00 + (offset & 0x3_ff)).toString(16)}`;
}

function wrap(parts: Iterable<string>, open: string, close: string, flags: bigint, level: number): string {
  const pretty = has(flags, 128n);
  rt().ensureStringFits(pretty ? 4 * (level + 1) + 4 : 2);
  const inner = pretty ? '    '.repeat(level + 1) : '';
  const ending = pretty ? `\n${'    '.repeat(level)}${close}` : close;
  let text = open;
  let count = 0;
  for (const part of parts) {
    const separator = count++ === 0 ? (pretty ? '\n' : '') : pretty ? ',\n' : ',';
    rt().ensureStringFits(text.length + separator.length + inner.length + part.length + ending.length);
    text += separator + inner + part;
  }
  return text + (count === 0 ? close : ending);
}

function decodePoint(bytes: string): number {
  const lead = bytes.charCodeAt(0);
  if (bytes.length === 2) return ((lead & 0x1f) << 6) | (bytes.charCodeAt(1) & 0x3f);
  if (bytes.length === 3)
    return ((lead & 0x0f) << 12) | ((bytes.charCodeAt(1) & 0x3f) << 6) | (bytes.charCodeAt(2) & 0x3f);
  return (
    ((lead & 0x07) << 18) |
    ((bytes.charCodeAt(1) & 0x3f) << 12) |
    ((bytes.charCodeAt(2) & 0x3f) << 6) |
    (bytes.charCodeAt(3) & 0x3f)
  );
}

// Decoding -----------------------------------------------------------------------------------------------------------

defineFunction(
  'json_decode(string $json, ?bool $associative = null, int $depth = 512, int $flags = 0): mixed',
  ({ args }) => {
    const text = args[0] as string;
    const flags = (args[3] as bigint | undefined) ?? 0n;
    const associative = args[1] === true || (args[1] !== false && has(flags, 1n));
    const depth = Number((args[2] as bigint | undefined) ?? 512n);
    const throws = has(flags, THROW_ON_ERROR);
    const runtime = rt();
    if (!throws) runtime.lastJsonError = 0;
    try {
      if (text === '') throw new JsonError(4);
      validateDepth(depth, 'json_decode', 3);
      return new JsonParser(text, associative, depth, flags).parseDocument();
    } catch (error) {
      if (!(error instanceof JsonError)) throw error;
      if (throws) throw new PhpThrow(newThrowable('JsonException', MESSAGES[error.code], BigInt(error.code)));
      runtime.lastJsonError = error.code;
      return null;
    }
  }
);
defineFunction('json_last_error(): int', () => BigInt(rt().lastJsonError));
defineFunction('json_last_error_msg(): string', () => MESSAGES[rt().lastJsonError]);
defineFunction('json_validate(string $json, int $depth = 512, int $flags = 0): bool', ({ args }) => {
  const depth = Number((args[1] as bigint | undefined) ?? 512n);
  try {
    const flags = (args[2] as bigint | undefined) ?? 0n;
    if ((flags & ~1_048_576n) !== 0n)
      throwError(
        'ValueError',
        'json_validate(): Argument #3 ($flags) must be a valid flag (allowed flags: JSON_INVALID_UTF8_IGNORE)'
      );
    if (args[0] === '') throw new JsonError(4);
    rt().lastJsonError = 0;
    validateDepth(depth, 'json_validate', 2);
    new JsonParser(args[0] as string, true, depth, flags).parseDocument();
    return true;
  } catch (error) {
    if (!(error instanceof JsonError)) throw error;
    rt().lastJsonError = error.code;
    return false;
  }
});

function validateDepth(depth: number, name: string, position: number): void {
  const argument = `${name}(): Argument #${position} ($depth)`;
  if (depth <= 0) throwError('ValueError', `${argument} must be greater than 0`);
  if (depth > 2_147_483_647) throwError('ValueError', `${argument} must be less than 2147483647`);
}

/** The characters of JSON's escapes other than `\\u`, by the letter after the backslash. */
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

class JsonParser {
  private index = 0;
  private temporariesStart = 0;
  private readonly containers: (PhpArray | PhpObject)[] = [];

  constructor(
    private readonly text: string,
    private readonly associative: boolean,
    private readonly maxDepth: number,
    private readonly flags: bigint
  ) {}

  parseDocument(): Value {
    const runtime = rt();
    this.temporariesStart = runtime.frame.temporaries.length;
    runtime.nativeHeld.push(this.containers);
    try {
      const value = this.value(0);
      this.skipSpace();
      if (this.index < this.text.length) this.unexpectedToken();
      return value;
    } finally {
      runtime.nativeHeld.pop();
    }
  }

  private releaseStoredTemporaries(): void {
    const runtime = rt();
    runtime.dropTemporaries(runtime.frame, this.temporariesStart);
    runtime.flushReleases();
  }

  private skipSpace(): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index])) this.index++;
  }

  private unexpectedToken(): never {
    if (this.text[this.index] === '"') this.string();
    throw new JsonError(4);
  }

  private value(depth: number): Value {
    rt().spend();
    this.skipSpace();
    const char = this.text[this.index];
    if (char === '{' || char === '[') {
      if (depth + 1 >= this.maxDepth) throw new JsonError(1);
      return char === '{' ? this.object(depth + 1) : this.array(depth + 1);
    }
    if (char === '"') return this.string();
    if (char === '-' || (char >= '0' && char <= '9')) return this.number();
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(word, this.index)) {
        this.index += word.length;
        return value;
      }
    }
    throw new JsonError(4);
  }

  // code-gauge-allow functionNcss 45 -- Keeps JSON member parsing, duplicate writes and cleanup in source order.
  // code-gauge-allow functionCognitiveComplexity 17 -- Keeps the ordered PHP cases together; splitting them would only move the same dispatch into helpers.
  private object(depth: number): Value {
    this.index++;
    const array = new PhpArray();
    this.containers.push(array);
    try {
      let object: PhpObject | undefined;
      // PHP's parser creates an object once it has parsed the first member's value.
      const createIfNeeded = (): void => {
        if (!this.associative && !object) {
          object = createObject(rt().classes.get('stdclass') as PhpClass);
          this.containers[this.containers.length - 1] = object;
        }
      };
      this.skipSpace();
      if (this.text[this.index] === ']') throw new JsonError(2);
      if (this.text[this.index] === '}') {
        this.index++;
        createIfNeeded();
        return object ?? array;
      }
      for (;;) {
        this.skipSpace();
        if (this.text[this.index] !== '"') throw new JsonError(4);
        const key = this.string();
        this.skipSpace();
        if (this.text[this.index] !== ':') this.unexpectedToken();
        this.index++;
        const value = this.value(depth);
        const runtime = rt();
        runtime.held.push(value);
        try {
          createIfNeeded();
          storeMember(object ?? array, key, value);
        } finally {
          runtime.held.pop();
        }
        this.releaseStoredTemporaries();
        this.skipSpace();
        const next = this.text[this.index];
        if (next !== '}' && next !== ']' && next !== ',') this.unexpectedToken();
        this.index++;
        if (next === '}') break;
        if (next === ']') throw new JsonError(2);
      }
      return object ?? array;
    } finally {
      rt().release([this.containers.pop()]);
    }
  }

  private array(depth: number): PhpArray {
    this.index++;
    const array = new PhpArray();
    this.containers.push(array);
    try {
      this.skipSpace();
      if (this.text[this.index] === '}') throw new JsonError(2);
      if (this.text[this.index] === ']') {
        this.index++;
        return array;
      }
      for (;;) {
        array.append(this.value(depth));
        this.releaseStoredTemporaries();
        this.skipSpace();
        const next = this.text[this.index];
        if (next !== ']' && next !== '}' && next !== ',') this.unexpectedToken();
        this.index++;
        if (next === ']') break;
        if (next === '}') throw new JsonError(2);
      }
      return array;
    } finally {
      rt().release([this.containers.pop()]);
    }
  }

  private string(): string {
    this.index++;
    let result = '';
    for (;;) {
      if (this.index >= this.text.length) throw new JsonError(3);
      const char = this.text[this.index++];
      if (char === '"') return result;
      const chunk = this.stringCharacter(char);
      rt().ensureStringFits(result.length + chunk.length);
      result += chunk;
    }
  }

  private stringCharacter(char: string): string {
    const code = char.charCodeAt(0);
    if (code < 0x20) throw new JsonError(3);
    if (code >= 0x80) {
      const length = utf8Length(this.text, this.index - 1);
      if (length === 1) {
        if ((this.flags & 2_097_152n) !== 0n) return enc('�');
        if ((this.flags & 1_048_576n) !== 0n) return '';
        throw new JsonError(5);
      }
      const chunk = this.text.slice(this.index - 1, this.index - 1 + length);
      this.index += length - 1;
      return chunk;
    }
    if (char !== '\\') return char;
    const escape = this.text[this.index++];
    if (escape === 'u') return codePointBytes(this.unicodeEscape());
    if (Object.hasOwn(SIMPLE_ESCAPES, escape)) return SIMPLE_ESCAPES[escape];
    throw new JsonError(4);
  }

  private unicodeEscape(): number {
    const point = this.hex4();
    if (point < 0xd8_00 || point > 0xdf_ff) return point;
    const low = /^\\u([Dd][C-Fc-f][\dA-Fa-f]{2})/.exec(this.text.slice(this.index, this.index + 6));
    if (point > 0xdb_ff || !low) throw new JsonError(10);
    this.index += 6;
    return 0x1_00_00 + ((point - 0xd8_00) << 10) + (Number.parseInt(low[1], 16) - 0xdc_00);
  }

  private hex4(): number {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[\dA-Fa-f]{4}$/.test(digits)) throw new JsonError(4);
    this.index += 4;
    return Number.parseInt(digits, 16);
  }

  private number(): Value {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) throw new JsonError(4);
    this.index += match[0].length;
    if (match[2] === undefined && match[3] === undefined) {
      const value = BigInt(match[0]);
      if (value > 9_223_372_036_854_775_807n || value < -9_223_372_036_854_775_808n) {
        return has(this.flags, 2n) ? match[0] : Number(match[0]);
      }
      return value;
    }
    return Number(match[0]);
  }
}

/** Stores a decoded member, where PHP rejects a property name starting with NUL as it marks a mangled name. */
function storeMember(target: PhpArray | PhpObject, key: string, value: Value): void {
  if (target instanceof PhpArray) {
    target.set(conversionsModule.normalizeKeyString(key), value);
    return;
  }
  if (key.startsWith('\0')) throw new JsonError(9);
  target.props.set(key, value);
}
