import { PyBytes } from '../bytesValues';
import { decodeBytes } from '../codecs';
import { pyRepr } from '../conversions';
import { builtin } from '../define';
import { registerModule } from '../modules';
import { checkArgs } from '../nativeArgs';
import { floatRepr, intToString } from '../numbers';
import { callValue, getAttribute, isTruthy, toArray } from '../objects';
import { lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { iterStr } from '../strings';
import {
  exceptionClassNamed,
  nativeFunction,
  newDict,
  newException,
  newList,
  None,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../types';
import { type Kwargs, type PyClass, PyDict, PyError, PyList, type PyObject, PyTuple, type PyValue } from '../values';
import { builtinClassWithBase } from './moduleClasses';

export const jsonDecodeErrorClass: PyClass = builtinClassWithBase(
  'JSONDecodeError',
  exceptionClassNamed('ValueError'),
  'json.decoder'
);

interface DumpOptions {
  indent?: string;
  itemSeparator: string;
  keySeparator: string;
  sortKeys: boolean;
  ensureAscii: boolean;
  defaultFn?: PyValue;
}

function quote(text: string, ensureAscii: boolean): string {
  let result = '"';
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const escaped = JSON_ESCAPES[char];
    if (escaped !== undefined) result += escaped;
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) result += unicodeEscape(char);
    else result += char;
  }
  return `${result}"`;
}

const JSON_ESCAPES: Record<string, string> = {
  '"': String.raw`\"`,
  '\\': String.raw`\\`,
  '\n': String.raw`\n`,
  '\r': String.raw`\r`,
  '\t': String.raw`\t`,
  '\b': String.raw`\b`,
  '\f': String.raw`\f`,
};

/** Escapes a character as `\uXXXX`, one per UTF-16 code unit. */
function unicodeEscape(char: string): string {
  let result = '';
  for (let unit = 0; unit < char.length; unit++)
    result += `\\u${((char.codePointAt(unit) as number) & 0xff_ff).toString(16).padStart(4, '0')}`;
  return result;
}

function floatText(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  return floatRepr(value);
}

function encode(item: PyValue, options: DumpOptions, level: number, stack: Set<PyObject>): string {
  currentRuntime().spend();
  const value = unbox(item);
  if (value === None) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'bigint') return intToString(value);
  if (typeof value === 'number') return floatText(value);
  if (typeof value === 'string') return quote(value, options.ensureAscii);
  if (value instanceof PyList || value instanceof PyTuple) return encodeArray(value, options, level, stack);
  if (value instanceof PyDict) return encodeObject(value, options, level, stack);
  if (options.defaultFn !== undefined && options.defaultFn !== None) {
    return encode(callValue(options.defaultFn, [value]), options, level, stack);
  }
  throw typeError(`Object of type ${typeName(value)} is not JSON serializable`);
}

function encodeArray(value: PyList | PyTuple, options: DumpOptions, level: number, stack: Set<PyObject>): string {
  if (value.items.length === 0) return '[]';
  enterContainer(value, stack);
  const items = value.items.map((item) => newline(options, level + 1) + encode(item, options, level + 1, stack));
  stack.delete(value);
  return `[${items.join(options.itemSeparator)}${newline(options, level)}]`;
}

function encodeObject(value: PyDict, options: DumpOptions, level: number, stack: Set<PyObject>): string {
  if (value.store.size === 0) return '{}';
  enterContainer(value, stack);
  let entries = value.store.ordered().map((entry) => [keyText(entry.key), entry.value] as const);
  if (options.sortKeys) entries = entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = entries.map(
    ([key, item]) =>
      `${newline(options, level + 1)}${quote(key, options.ensureAscii)}${options.keySeparator}${encode(item, options, level + 1, stack)}`
  );
  stack.delete(value);
  return `{${parts.join(options.itemSeparator)}${newline(options, level)}}`;
}

function enterContainer(value: PyObject, stack: Set<PyObject>): void {
  if (stack.has(value)) throw valueError('Circular reference detected');
  stack.add(value);
}

function newline(options: DumpOptions, depth: number): string {
  return options.indent === undefined ? '' : `\n${options.indent.repeat(depth)}`;
}

function keyText(item: PyValue): string {
  const key = unbox(item);
  if (typeof key === 'string') return key;
  if (key === true) return 'true';
  if (key === false) return 'false';
  if (key === None) return 'null';
  if (typeof key === 'bigint') return intToString(key);
  if (typeof key === 'number') return floatText(key);
  throw typeError(`keys must be str, int, float, bool or None, not ${typeName(key)}`);
}

function dumps(args: PyValue[], kwargs: Kwargs): PyValue {
  const text = encode(args[0], dumpOptions(args, kwargs), 0, new Set());
  currentRuntime().buildString(text.length);
  return text;
}

function dumpOptions(args: PyValue[], kwargs: Kwargs): DumpOptions {
  checkArgs(
    {
      qualified: 'dumps',
      min: 1,
      max: 1,
      style: 'takes',
      keywords: [
        'skipkeys',
        'ensure_ascii',
        'check_circular',
        'allow_nan',
        'cls',
        'indent',
        'separators',
        'default',
        'sort_keys',
      ],
    },
    args,
    kwargs
  );
  const indentValue = kwargs?.get('indent') ?? None;
  const indent =
    indentValue === None
      ? undefined
      : typeof indentValue === 'string'
        ? indentValue
        : ' '.repeat(Math.max(0, Number(indentValue)));
  const separators = kwargs?.get('separators') ?? None;
  let [itemSeparator, keySeparator] = indent === undefined ? [', ', ': '] : [',', ': '];
  if (separators !== None) [itemSeparator, keySeparator] = toArray(separators) as [string, string];
  return {
    indent,
    itemSeparator,
    keySeparator,
    sortKeys: isTruthy(kwargs?.get('sort_keys') ?? false),
    ensureAscii: isTruthy(kwargs?.get('ensure_ascii') ?? true),
    defaultFn: kwargs?.get('default'),
  };
}

// The pieces json.dump writes ---------------------------------------------------------------------------------------

/**
 * The pieces that CPython's `json.encoder._make_iterencode` yields, which `json.dump` writes one by one: a scalar
 * item joins the separator before it, and a container's brackets and separators come on their own.
 */
function* encodePieces(item: PyValue, options: DumpOptions, level: number, stack: Set<PyObject>): Generator<string> {
  const value = unbox(item);
  const scalar = scalarText(value, options);
  if (scalar !== undefined) {
    yield scalar;
  } else if (value instanceof PyList || value instanceof PyTuple) {
    yield* arrayPieces(value, options, level, stack);
  } else if (value instanceof PyDict) {
    yield* objectPieces(value, options, level, stack);
  } else if (options.defaultFn !== undefined && options.defaultFn !== None) {
    enterContainer(value as PyObject, stack);
    yield* encodePieces(callValue(options.defaultFn, [value]), options, level, stack);
    stack.delete(value as PyObject);
  } else {
    throw typeError(`Object of type ${typeName(value)} is not JSON serializable`);
  }
}

function scalarText(value: PyValue, options: DumpOptions): string | undefined {
  currentRuntime().spend();
  if (value === None) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'bigint') return intToString(value);
  if (typeof value === 'number') return floatText(value);
  if (typeof value === 'string') return quote(value, options.ensureAscii);
  return undefined;
}

function* arrayPieces(
  value: PyList | PyTuple,
  options: DumpOptions,
  level: number,
  stack: Set<PyObject>
): Generator<string> {
  if (value.items.length === 0) {
    yield '[]';
    return;
  }
  enterContainer(value, stack);
  let buffer = `[${newline(options, level + 1)}`;
  for (const [index, item] of value.items.entries()) {
    if (index > 0) buffer = options.itemSeparator + newline(options, level + 1);
    const scalar = scalarText(unbox(item), options);
    if (scalar === undefined) {
      yield buffer;
      yield* encodePieces(item, options, level + 1, stack);
    } else {
      yield buffer + scalar;
    }
  }
  if (options.indent !== undefined) yield newline(options, level);
  yield ']';
  stack.delete(value);
}

function* objectPieces(value: PyDict, options: DumpOptions, level: number, stack: Set<PyObject>): Generator<string> {
  if (value.store.size === 0) {
    yield '{}';
    return;
  }
  enterContainer(value, stack);
  yield `{`;
  if (options.indent !== undefined) yield newline(options, level + 1);
  let entries = value.store.ordered().map((entry) => [entry.key, entry.value] as const);
  if (options.sortKeys) {
    entries = entries.toSorted(([a], [b]) => (lessThan(a, b) ? -1 : lessThan(b, a) ? 1 : 0));
  }
  for (const [index, [key, item]] of entries.entries()) {
    const text = keyText(key);
    if (index > 0) yield options.itemSeparator + newline(options, level + 1);
    yield quote(text, options.ensureAscii);
    yield options.keySeparator;
    yield* encodePieces(item, options, level + 1, stack);
  }
  if (options.indent !== undefined) yield newline(options, level);
  yield '}';
  stack.delete(value);
}

// Decoding ----------------------------------------------------------------------------------------------------------

class Decoder {
  private index = 0;
  private readonly chars: string[];

  constructor(private readonly text: string) {
    this.chars = iterStr(text);
  }

  error(message: string, position = this.index): PyError {
    const before = this.chars.slice(0, position);
    const line = before.filter((char) => char === '\n').length + 1;
    const lastNewline = before.lastIndexOf('\n');
    const column = position - lastNewline;
    const exception = newException(jsonDecodeErrorClass, [
      `${message}: line ${line} column ${column} (char ${position})`,
    ]);
    return new PyError(exception);
  }

  skipSpace(): void {
    while (this.index < this.chars.length && ' \t\n\r'.includes(this.chars[this.index])) this.index++;
  }

  decode(): PyValue {
    this.skipSpace();
    const value = this.value();
    this.skipSpace();
    if (this.index < this.chars.length) throw this.error('Extra data');
    return value;
  }

  value(): PyValue {
    currentRuntime().spend();
    const char = this.chars[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    for (const [word, value] of [
      ['null', None],
      ['true', true],
      ['false', false],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ] as const) {
      if (this.chars.slice(this.index, this.index + word.length).join('') === word) {
        this.index += word.length;
        return value;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(
      this.chars.slice(this.index, this.index + 400).join('')
    );
    if (!match) throw this.error('Expecting value');
    this.index += match[0].length;
    if (match[1] === undefined && match[2] === undefined) return BigInt(match[0]);
    return Number(match[0]);
  }

  // code-gauge-allow functionNcss 31 -- Follows the JSON object grammar and its error messages.
  object(): PyValue {
    const start = this.index;
    this.index++;
    const dict = newDict();
    this.skipSpace();
    if (this.chars[this.index] === '}') {
      this.index++;
      return dict;
    }
    for (;;) {
      this.skipSpace();
      if (this.chars[this.index] !== '"') throw this.error('Expecting property name enclosed in double quotes');
      const key = this.string();
      this.skipSpace();
      if (this.chars[this.index] !== ':') throw this.error("Expecting ':' delimiter");
      this.index++;
      this.skipSpace();
      dict.store.set(key, this.value());
      this.skipSpace();
      const char = this.chars[this.index];
      if (char === '}') {
        this.index++;
        return dict;
      }
      if (char !== ',') throw this.error("Expecting ',' delimiter");
      this.index++;
      this.skipSpace();
      if (this.chars[this.index] === '}') throw this.error('Illegal trailing comma before end of object');
      void start;
    }
  }

  array(): PyValue {
    this.index++;
    const items: PyValue[] = [];
    this.skipSpace();
    if (this.chars[this.index] === ']') {
      this.index++;
      return newList(items);
    }
    for (;;) {
      this.skipSpace();
      items.push(this.value());
      this.skipSpace();
      const char = this.chars[this.index];
      if (char === ']') {
        this.index++;
        return newList(items);
      }
      if (char !== ',') throw this.error("Expecting ',' delimiter");
      this.index++;
      this.skipSpace();
      if (this.chars[this.index] === ']') throw this.error('Illegal trailing comma before end of array');
    }
  }

  // code-gauge-allow functionCognitiveComplexity 18 -- Follows JSON string escapes.
  string(): string {
    const start = this.index;
    this.index++;
    let result = '';
    for (;;) {
      if (this.index >= this.chars.length) throw this.error('Unterminated string starting at', start);
      const char = this.chars[this.index++];
      if (char === '"') return result;
      if (char === '\\') {
        const escape = this.chars[this.index++];
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
        if (escape in simple) result += simple[escape];
        else if (escape === 'u') {
          const hex = this.chars.slice(this.index, this.index + 4).join('');
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.error(String.raw`Invalid \uXXXX escape`, this.index - 1);
          this.index += 4;
          result += String.fromCodePoint(Number.parseInt(hex, 16));
        } else throw this.error(String.raw`Invalid \escape`, this.index - 2);
        continue;
      }
      if ((char.codePointAt(0) as number) < 0x20) throw this.error('Invalid control character at', this.index - 1);
      result += char;
    }
  }
}

function loads(args: PyValue[], kwargs: Kwargs): PyValue {
  checkArgs({ qualified: 'loads', min: 1, max: 1, style: 'takes', keywords: [] }, args, kwargs);
  const data = args[0] instanceof PyBytes ? args[0].data : undefined;
  const text = data ? decodeBytes(data, detectEncoding(data), 'surrogatepass') : args[0];
  if (typeof text !== 'string')
    throw typeError(`the JSON object must be str, bytes or bytearray, not ${typeName(text)}`);
  return new Decoder(text).decode();
}

/** `json.dump(obj, fp, **kw)`: writes the JSON text to a stream such as io.StringIO, piece by piece as CPython does. */
function dump(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length > 2) throw typeError(`dump() takes 2 positional arguments but ${args.length} were given`);
  if (args.length < 2) {
    throw typeError(
      args.length === 0
        ? "dump() missing 2 required positional arguments: 'obj' and 'fp'"
        : "dump() missing 1 required positional argument: 'fp'"
    );
  }
  const options = dumpOptions([args[0]], kwargs);
  const write = getAttribute(args[1], 'write');
  for (const piece of encodePieces(args[0], options, 0, new Set())) callValue(write, [piece]);
  return None;
}

/** `json.load(fp, **kw)`: `loads` of what the stream's `read()` returns. */
function load(args: PyValue[], kwargs: Kwargs): PyValue {
  if (args.length > 1) throw typeError(`load() takes 1 positional argument but ${args.length} were given`);
  if (args.length === 0) throw typeError("load() missing 1 required positional argument: 'fp'");
  return loads([callValue(getAttribute(args[0], 'read'), [])], kwargs);
}

/** `json.detect_encoding`: the encoding of JSON bytes, from a BOM or from where the first characters' zeros are. */
function detectEncoding(data: Uint8Array): string {
  const startsWith = (...bytes: number[]): boolean => bytes.every((byte, index) => data[index] === byte);
  if (startsWith(0x00, 0x00, 0xfe, 0xff) || startsWith(0xff, 0xfe, 0x00, 0x00)) return 'utf-32';
  if (startsWith(0xfe, 0xff) || startsWith(0xff, 0xfe)) return 'utf-16';
  if (startsWith(0xef, 0xbb, 0xbf)) return 'utf-8-sig';
  if (data.length >= 4) {
    if (!data[0]) return data[1] ? 'utf-16-be' : 'utf-32-be';
    if (!data[1]) return data[2] || data[3] ? 'utf-16-le' : 'utf-32-le';
  } else if (data.length === 2) {
    if (!data[0]) return 'utf-16-be';
    if (!data[1]) return 'utf-16-le';
  }
  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- The name of Python's codec, as json gives it.
  return 'utf-8';
}

registerModule(
  'json',
  () =>
    new Map<string, PyValue>([
      [
        'dumps',
        builtin('dumps', 'takes', 1, 1, dumps, {
          keywords: [
            'skipkeys',
            'ensure_ascii',
            'check_circular',
            'allow_nan',
            'cls',
            'indent',
            'separators',
            'default',
            'sort_keys',
          ],
        }),
      ],
      ['loads', builtin('loads', 'takes', 1, 1, loads, { keywords: [] })],
      ['dump', nativeFunction('dump', dump)],
      ['load', nativeFunction('load', load)],
      ['JSONDecodeError', jsonDecodeErrorClass],
    ])
);

export { pyRepr };
