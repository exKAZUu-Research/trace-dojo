// oxlint-disable unicorn/no-null -- PHP's null is a value of the language, which JavaScript's null represents.
// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { codePointBytes, utf8Length } from './bytes';
import { canAccessProp, createObject, declForKey, propNameOf } from './classes';
import * as conversionsModule from './conversions';
import { formatFloatRepr } from './conversions';
import { newThrowable, throwError } from './errors';
import { callMethod } from './interp';
import { defineConstant, defineFunction } from './native';
import { PhpThrow, rt } from './runtime';
import { PhpArray, type PhpClass, type PhpObject, Ref, UNINIT, type Value } from './values';

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
};

class JsonError {
  constructor(readonly code: number) {}
}

const has = (flags: bigint, flag: bigint): boolean => (flags & flag) !== 0n;

defineFunction('json_encode(mixed $value, int $flags = 0, int $depth = 512): string|false', ({ args }) => {
  const flags = (args[1] as bigint | undefined) ?? 0n;
  const depth = Number((args[2] as bigint | undefined) ?? 512n);
  const runtime = rt();
  try {
    const text = encode(args[0], flags, 0, depth, new Set());
    runtime.lastJsonError = 0;
    return text;
  } catch (error) {
    if (!(error instanceof JsonError)) throw error;
    if (has(flags, 4_194_304n))
      throw new PhpThrow(newThrowable('JsonException', MESSAGES[error.code], BigInt(error.code)));
    runtime.lastJsonError = error.code;
    return false;
  }
});

// code-gauge-allow functionCognitiveComplexity 35 -- Transcribes php_json_encode_zval per value type.
function encode(value: Value, flags: bigint, level: number, maxDepth: number, active: Set<object>): string {
  rt().spend();
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': {
      return value ? 'true' : 'false';
    }
    case 'bigint': {
      return value.toString();
    }
    case 'number': {
      if (!Number.isFinite(value)) throw new JsonError(7);
      const text = formatFloatRepr(value, 'e');
      if (has(flags, 1024n) && Number.isInteger(value) && !/[.e]/.test(text)) return `${text}.0`;
      return text;
    }
    case 'string': {
      if (has(flags, 32n)) {
        const numeric = conversionsModule.numericValue(value);
        if (numeric !== undefined) return encode(numeric, flags, level, maxDepth, active);
      }
      return encodeString(value, flags);
    }
  }
  if (level >= maxDepth) throw new JsonError(1);
  if (value instanceof PhpArray) {
    if (active.has(value)) throw new JsonError(6);
    active.add(value);
    try {
      const asList = value.isList() && !has(flags, 16n);
      const entries = [...value.entries()];
      return wrap(
        asList
          ? entries.map(([, item]) => encode(item, flags, level + 1, maxDepth, active))
          : entries.map(
              ([key, item]) =>
                `${encodeString(String(key), flags)}:${has(flags, 128n) ? ' ' : ''}${encode(item, flags, level + 1, maxDepth, active)}`
            ),
        asList ? '[' : '{',
        asList ? ']' : '}',
        flags,
        level
      );
    } finally {
      active.delete(value);
    }
  }
  const object = value as PhpObject;
  const serializable = rt().classes.get('jsonserializable') as PhpClass;
  if (object.cls.isSubclassOf(serializable)) {
    if (active.has(object)) throw new JsonError(6);
    active.add(object);
    try {
      return encode(callMethod(object, 'jsonSerialize', []), flags, level, maxDepth, active);
    } finally {
      active.delete(object);
    }
  }
  if (active.has(object)) throw new JsonError(6);
  active.add(object);
  try {
    const parts: string[] = [];
    for (const [key, slot] of object.props) {
      if (slot === UNINIT) continue;
      const decl = declForKey(object.cls, key);
      if (decl && !canAccessProp(decl, undefined)) continue;
      const item = slot instanceof Ref ? slot.v : slot;
      parts.push(
        `${encodeString(propNameOf(key), flags)}:${has(flags, 128n) ? ' ' : ''}${encode(item, flags, level + 1, maxDepth, active)}`
      );
    }
    return wrap(parts, '{', '}', flags, level);
  } finally {
    active.delete(object);
  }
}

function wrap(parts: string[], open: string, close: string, flags: bigint, level: number): string {
  if (parts.length === 0) return open + close;
  if (!has(flags, 128n)) return `${open}${parts.join(',')}${close}`;
  const inner = '    '.repeat(level + 1);
  return `${open}\n${parts.map((part) => inner + part).join(',\n')}\n${'    '.repeat(level)}${close}`;
}

// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes php_json_escape_string.
function encodeString(text: string, flags: bigint): string {
  let result = '"';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0x80) {
      const length = utf8Length(text, index);
      if (length === 1) {
        if (has(flags, 1_048_576n)) {
          index++;
          continue;
        }
        if (has(flags, 2_097_152n)) {
          result += has(flags, 256n) ? 'ï¿½' : String.raw`\ufffd`;
          index++;
          continue;
        }
        throw new JsonError(5);
      }
      const bytes = text.slice(index, index + length);
      const point = decodePoint(bytes);
      index += length;
      if (has(flags, 256n) && !((point === 0x20_28 || point === 0x20_29) && !has(flags, 2048n))) {
        result += bytes;
        continue;
      }
      if (point >= 0x1_00_00) {
        const offset = point - 0x1_00_00;
        result += `\\u${(0xd8_00 + (offset >> 10)).toString(16)}\\u${(0xdc_00 + (offset & 0x3_ff)).toString(16)}`;
      } else result += `\\u${point.toString(16).padStart(4, '0')}`;
      continue;
    }
    const char = text[index++];
    switch (char) {
      case '"': {
        result += has(flags, 8n) ? String.raw`\u0022` : String.raw`\"`;
        break;
      }
      case '\\': {
        result += String.raw`\\`;
        break;
      }
      case '/': {
        result += has(flags, 64n) ? '/' : String.raw`\/`;
        break;
      }
      case '\b': {
        result += String.raw`\b`;
        break;
      }
      case '\f': {
        result += String.raw`\f`;
        break;
      }
      case '\n': {
        result += String.raw`\n`;
        break;
      }
      case '\r': {
        result += String.raw`\r`;
        break;
      }
      case '\t': {
        result += String.raw`\t`;
        break;
      }
      case '<': {
        result += has(flags, 1n) ? String.raw`\u003C` : '<';
        break;
      }
      case '>': {
        result += has(flags, 1n) ? String.raw`\u003E` : '>';
        break;
      }
      case '&': {
        result += has(flags, 2n) ? String.raw`\u0026` : '&';
        break;
      }
      case "'": {
        result += has(flags, 4n) ? String.raw`\u0027` : "'";
        break;
      }
      default: {
        result += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
      }
    }
  }
  return `${result}"`;
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
    let flags = (args[3] as bigint | undefined) ?? 0n;
    const associative = args[1] === true || (args[1] !== false && has(flags, 1n));
    const depth = Number((args[2] as bigint | undefined) ?? 512n);
    if (depth <= 0) throwError('ValueError', 'json_decode(): Argument #3 ($depth) must be greater than 0');
    const runtime = rt();
    try {
      if (text === '') throw new JsonError(4);
      const parser = new JsonParser(text, associative, depth, flags);
      const value = parser.parseDocument();
      runtime.lastJsonError = 0;
      return value;
    } catch (error) {
      if (!(error instanceof JsonError)) throw error;
      if (has(flags, 4_194_304n))
        throw new PhpThrow(newThrowable('JsonException', MESSAGES[error.code], BigInt(error.code)));
      runtime.lastJsonError = error.code;
      flags = 0n;
      return null;
    }
  }
);
defineFunction('json_last_error(): int', () => BigInt(rt().lastJsonError));
defineFunction('json_last_error_msg(): string', () => MESSAGES[rt().lastJsonError]);
defineFunction('json_validate(string $json, int $depth = 512, int $flags = 0): bool', ({ args }) => {
  try {
    if (args[0] === '') throw new JsonError(4);
    new JsonParser(args[0] as string, true, Number((args[1] as bigint | undefined) ?? 512n), 0n).parseDocument();
    rt().lastJsonError = 0;
    return true;
  } catch (error) {
    if (!(error instanceof JsonError)) throw error;
    rt().lastJsonError = error.code;
    return false;
  }
});

class JsonParser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly associative: boolean,
    private readonly maxDepth: number,
    private readonly flags: bigint
  ) {}

  parseDocument(): Value {
    const value = this.value(0);
    this.skipSpace();
    if (this.index < this.text.length) throw new JsonError(4);
    return value;
  }

  private skipSpace(): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index])) this.index++;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per JSON value kind.
  private value(depth: number): Value {
    rt().spend();
    this.skipSpace();
    const char = this.text[this.index];
    if (char === '{' || char === '[') {
      if (depth >= this.maxDepth) throw new JsonError(1);
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

  private object(depth: number): Value {
    this.index++;
    const array = new PhpArray();
    let object: PhpObject | undefined;
    // PHP's parser creates an object once it has parsed the first member's value.
    const createIfNeeded = (): void => {
      if (!this.associative && !object) object = createObject(rt().classes.get('stdclass') as PhpClass);
    };
    this.skipSpace();
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
      if (this.text[this.index] !== ':') throw new JsonError(4);
      this.index++;
      const value = this.value(depth);
      createIfNeeded();
      if (object) object.props.set(key, value);
      else array.set(conversionsModule.normalizeKeyString(key), value);
      this.skipSpace();
      const next = this.text[this.index++];
      if (next === '}') break;
      if (next !== ',') throw new JsonError(4);
    }
    return object ?? array;
  }

  private array(depth: number): PhpArray {
    this.index++;
    const array = new PhpArray();
    this.skipSpace();
    if (this.text[this.index] === ']') {
      this.index++;
      return array;
    }
    for (;;) {
      array.append(this.value(depth));
      this.skipSpace();
      const next = this.text[this.index++];
      if (next === ']') break;
      if (next !== ',') throw new JsonError(4);
    }
    return array;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Decodes JSON string escapes into UTF-8 bytes.
  private string(): string {
    this.index++;
    let result = '';
    for (;;) {
      if (this.index >= this.text.length) throw new JsonError(4);
      const char = this.text[this.index++];
      if (char === '"') return result;
      const code = char.charCodeAt(0);
      if (code < 0x20) throw new JsonError(3);
      if (code >= 0x80) {
        const length = utf8Length(this.text, this.index - 1);
        if (length === 1) throw new JsonError(5);
        result += this.text.slice(this.index - 1, this.index - 1 + length);
        this.index += length - 1;
        continue;
      }
      if (char !== '\\') {
        result += char;
        continue;
      }
      const escape = this.text[this.index++];
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
        continue;
      }
      if (escape !== 'u') throw new JsonError(4);
      let point = this.hex4();
      if (point >= 0xd8_00 && point <= 0xdb_ff && this.text.startsWith(String.raw`\u`, this.index)) {
        this.index += 2;
        const low = this.hex4();
        if (low >= 0xdc_00 && low <= 0xdf_ff) point = 0x1_00_00 + ((point - 0xd8_00) << 10) + (low - 0xdc_00);
        else throw new JsonError(4);
      } else if (point >= 0xd8_00 && point <= 0xdf_ff) throw new JsonError(4);
      result += codePointBytes(point);
    }
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
