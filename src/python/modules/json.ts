import { pyRepr } from '../conversions';
import { builtin } from '../define';
import { runLibrarySource } from '../librarySource';
import { registerHiddenAttributes, registerModule, registerUnsupportedAttributes } from '../modules';
import { floatRepr, intToString, toIndex } from '../numbers';
import { callValue, getAttribute, isTruthy, toArray } from '../objects';
import { intEnumValue } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { iterStr } from '../strings';
import {
  exceptionClassNamed,
  floatClass,
  intClass,
  newDict,
  newException,
  newList,
  newTuple,
  None,
  typeError,
  typeName,
  valueError,
} from '../types';
import { PyDict, PyError, type PyInstance, PyList, type PyObject, PyTuple, type PyValue } from '../values';
import { JSON_SOURCE } from './jsonSource';

interface DumpOptions {
  indent?: string;
  itemSeparator: string;
  keySeparator: string;
  sortKeys: boolean;
  ensureAscii: boolean;
  defaultFn: PyValue;
  checkCircular: boolean;
  skipKeys: boolean;
  allowNan: boolean;
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

function floatText(value: number, options: DumpOptions): string {
  if (Number.isFinite(value)) return floatRepr(value);
  if (!options.allowNan) {
    throw valueError(`Out of range float values are not JSON compliant: ${pyRepr(value)}`);
  }
  if (Number.isNaN(value)) return 'NaN';
  return value > 0 ? 'Infinity' : '-Infinity';
}

function encode(value: PyValue, options: DumpOptions, level: number, stack: Set<PyObject>): string {
  currentRuntime().spend();
  if (value === None) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'bigint') return intToString(value);
  if (typeof value === 'number') return floatText(value, options);
  if (typeof value === 'string') return quote(value, options.ensureAscii);
  if (value instanceof PyList || value instanceof PyTuple) return encodeArray(value, options, level, stack);
  if (value instanceof PyDict) return encodeObject(value, options, level, stack);
  const integer = intEnumValue(value);
  if (typeof integer === 'bigint') return intToString(integer);
  enterContainer(value as PyObject, stack, options);
  const result = encode(callValue(options.defaultFn, [value]), options, level, stack);
  stack.delete(value as PyObject);
  return result;
}

function encodeArray(value: PyList | PyTuple, options: DumpOptions, level: number, stack: Set<PyObject>): string {
  if (value.items.length === 0) return '[]';
  enterContainer(value, stack, options);
  const items = value.items.map((item) => newline(options, level + 1) + encode(item, options, level + 1, stack));
  stack.delete(value);
  return `[${items.join(options.itemSeparator)}${newline(options, level)}]`;
}

function encodeObject(value: PyDict, options: DumpOptions, level: number, stack: Set<PyObject>): string {
  if (value.store.size === 0) return '{}';
  enterContainer(value, stack, options);
  let entries: (readonly [PyValue, PyValue])[] = value.store
    .ordered()
    .map((entry) => [entry.key, entry.value] as const);
  // As the encoders of CPython, the items themselves are sorted, keys and then values, before the keys are converted.
  if (options.sortKeys) {
    entries = toArray(
      callValue(currentRuntime().builtins.get('sorted') as PyValue, [newList(entries.map((entry) => newTuple(entry)))])
    ).map((item) => (item as PyTuple).items as [PyValue, PyValue]);
  }
  const parts: string[] = [];
  for (const [key, item] of entries) {
    const text = keyText(key, options);
    if (text === undefined) continue;
    parts.push(
      `${newline(options, level + 1)}${quote(text, options.ensureAscii)}${options.keySeparator}${encode(item, options, level + 1, stack)}`
    );
  }
  stack.delete(value);
  if (parts.length === 0) return '{}';
  return `{${parts.join(options.itemSeparator)}${newline(options, level)}}`;
}

function enterContainer(value: PyObject, stack: Set<PyObject>, options: DumpOptions): void {
  if (!options.checkCircular) return;
  if (stack.has(value)) throw valueError('Circular reference detected');
  stack.add(value);
}

function newline(options: DumpOptions, depth: number): string {
  return options.indent === undefined ? '' : `\n${options.indent.repeat(depth)}`;
}

/** The text of a dict key, or undefined for a key that `skipkeys` skips. */
function keyText(key: PyValue, options: DumpOptions): string | undefined {
  if (typeof key === 'string') return key;
  if (typeof key === 'number') return floatText(key, options);
  if (key === true) return 'true';
  if (key === false) return 'false';
  if (key === None) return 'null';
  const integer = intEnumValue(key);
  if (typeof integer === 'bigint') return intToString(integer);
  if (options.skipKeys) return undefined;
  throw typeError(`keys must be str, int, float, bool or None, not ${typeName(key)}`);
}

// Decoding ----------------------------------------------------------------------------------------------------------

interface DecodeHooks {
  objectHook: PyValue;
  objectPairsHook: PyValue;
  parseFloat: PyValue;
  parseInt: PyValue;
  parseConstant: PyValue;
  strict: boolean;
  /** json.JSONDecodeError, which the module's Python defines. */
  error: PyValue;
}

class Decoder {
  private index: number;
  private readonly chars: string[];

  constructor(
    private readonly text: string,
    private readonly hooks: DecodeHooks,
    start: number
  ) {
    this.chars = iterStr(text);
    this.index = start;
  }

  get position(): number {
    return this.index;
  }

  error(message: string, position = this.index): Error {
    const exception = callValue(this.hooks.error, [message, this.text, BigInt(position)]);
    return new PyError(exception as PyInstance);
  }

  skipSpace(): void {
    while (this.index < this.chars.length && ' \t\n\r'.includes(this.chars[this.index])) this.index++;
  }

  /** Decodes the value at the index, raising StopIteration as the C scanner does when no value starts there. */
  scanOnce(): PyValue {
    if (this.index >= this.chars.length || !this.startsValue()) {
      throw new PyError(newException(exceptionClassNamed('StopIteration'), [BigInt(this.index)]));
    }
    return this.value();
  }

  private startsValue(): boolean {
    const char = this.chars[this.index];
    if ('{["-0123456789'.includes(char)) return true;
    return ['null', 'true', 'false', 'NaN', 'Infinity'].some(
      (word) => this.chars.slice(this.index, this.index + word.length).join('') === word
    );
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
    ] as const) {
      if (this.chars.slice(this.index, this.index + word.length).join('') === word) {
        this.index += word.length;
        return value;
      }
    }
    for (const word of ['NaN', 'Infinity', '-Infinity']) {
      if (this.chars.slice(this.index, this.index + word.length).join('') === word) {
        this.index += word.length;
        return callValue(this.hooks.parseConstant, [word]);
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(
      this.chars.slice(this.index, this.index + 400).join('')
    );
    if (!match) throw this.error('Expecting value');
    this.index += match[0].length;
    if (match[1] === undefined && match[2] === undefined) {
      return this.hooks.parseInt === intClass ? BigInt(match[0]) : callValue(this.hooks.parseInt, [match[0]]);
    }
    return this.hooks.parseFloat === floatClass ? Number(match[0]) : callValue(this.hooks.parseFloat, [match[0]]);
  }

  // code-gauge-allow functionNcss 31 -- Follows the JSON object grammar and its error messages.
  object(): PyValue {
    this.index++;
    const pairs: [string, PyValue][] = [];
    this.skipSpace();
    if (this.chars[this.index] === '}') {
      this.index++;
      return this.finishObject(pairs);
    }
    for (;;) {
      this.skipSpace();
      if (this.chars[this.index] !== '"') throw this.error('Expecting property name enclosed in double quotes');
      const key = this.string();
      this.skipSpace();
      if (this.chars[this.index] !== ':') throw this.error("Expecting ':' delimiter");
      this.index++;
      this.skipSpace();
      pairs.push([key, this.value()]);
      this.skipSpace();
      const char = this.chars[this.index];
      if (char === '}') {
        this.index++;
        return this.finishObject(pairs);
      }
      if (char !== ',') throw this.error("Expecting ',' delimiter");
      const comma = this.index;
      this.index++;
      this.skipSpace();
      if (this.chars[this.index] === '}') throw this.error('Illegal trailing comma before end of object', comma);
    }
  }

  /** The value of a decoded object: the pairs hook's, the object hook's, or the dict. */
  private finishObject(pairs: [string, PyValue][]): PyValue {
    if (this.hooks.objectPairsHook !== None) {
      return callValue(this.hooks.objectPairsHook, [newList(pairs.map((pair) => newTuple(pair)))]);
    }
    const dict = newDict(pairs);
    return this.hooks.objectHook === None ? dict : callValue(this.hooks.objectHook, [dict]);
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
      const comma = this.index;
      this.index++;
      this.skipSpace();
      if (this.chars[this.index] === ']') throw this.error('Illegal trailing comma before end of array', comma);
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
      if (this.hooks.strict && (char.codePointAt(0) as number) < 0x20) {
        throw this.error('Invalid control character at', this.index - 1);
      }
      result += char;
    }
  }
}

registerUnsupportedAttributes('json', {
  __author__: 'json.__author__（作者の情報）',
  codecs: 'モジュール codecs',
  decoder: 'モジュール json.decoder',
  encoder: 'モジュール json.encoder',
  scanner: 'モジュール json.scanner',
  detect_encoding: 'json.detect_encoding()（bytes 型）',
});

registerHiddenAttributes('json', [
  'INFINITY',
  'NaN',
  'NegInf',
  'PosInf',
  'encode_basestring',
  'encode_basestring_ascii',
]);

registerModule('json', (runtime) => {
  const namespace = new Map<string, PyValue>();
  const encodeAscii = builtin('encode_basestring_ascii', 'one', 1, 1, ([text]) => quote(text as string, true));
  const encodeText = builtin('encode_basestring', 'one', 1, 1, ([text]) => quote(text as string, false));
  for (const [name, value] of [
    ['encode_basestring_ascii', encodeAscii],
    ['encode_basestring', encodeText],
    [
      '_skip_whitespace',
      builtin('_skip_whitespace', 'expected', 2, 2, ([text, index]) => skipWhitespace(text as string, index)),
    ],
    ['_make_scanner', builtin('_make_scanner', 'one', 1, 1, ([decoder]) => makeScanner(decoder, namespace))],
    ['_c_make_encoder', builtin('_c_make_encoder', 'expected', 9, 9, (args) => makeEncoder(args, encodeAscii))],
    ['dump', unsupportedBuiltin(runtime, 'dump', 'ファイルへの書き込み（json.dump）')],
    ['load', unsupportedBuiltin(runtime, 'load', 'ファイルからの読み込み（json.load）')],
  ] as const) {
    namespace.set(name, value);
  }
  return runLibrarySource('json', JSON_SOURCE, namespace);
});

function unsupportedBuiltin(runtime: { unsupported(feature: string): Error }, name: string, feature: string): PyValue {
  return builtin(
    name,
    'expected',
    0,
    Number.POSITIVE_INFINITY,
    () => {
      throw runtime.unsupported(feature);
    },
    { keywords: [] }
  );
}

function skipWhitespace(text: string, indexValue: PyValue): bigint {
  const chars = iterStr(text);
  let index = Number(indexValue);
  while (index < chars.length && ' \t\n\r'.includes(chars[index])) index++;
  return BigInt(index);
}

/** `c_make_encoder`: an encoder of a whole object at once, which gives its text as the one chunk of a tuple. */
function makeEncoder(args: PyValue[], encodeAscii: PyValue): PyValue {
  const [markers, defaultFn, encoder, indent, keySeparator, itemSeparator, sortKeys, skipKeys, allowNan] = args;
  const options: DumpOptions = {
    indent: indent === None ? undefined : (indent as string),
    keySeparator: keySeparator as string,
    itemSeparator: itemSeparator as string,
    sortKeys: isTruthy(sortKeys),
    skipKeys: isTruthy(skipKeys),
    allowNan: isTruthy(allowNan),
    ensureAscii: encoder === encodeAscii,
    checkCircular: markers !== None,
    defaultFn,
  };
  return builtin('_iterencode', 'expected', 2, 2, ([value]) => {
    const text = encode(value, options, 0, new Set());
    currentRuntime().buildString(text.length);
    return newTuple([text]);
  });
}

/** `scanner.make_scanner(decoder)`: decodes one value at an index, raising StopIteration where none starts. */
function makeScanner(decoder: PyValue, namespace: Map<string, PyValue>): PyValue {
  return builtin('scan_once', 'expected', 2, 2, ([text, index]) => {
    if (typeof text !== 'string') throw typeError(`first argument must be a string, not ${typeName(text)}`);
    const hooks: DecodeHooks = {
      objectHook: getAttribute(decoder, 'object_hook'),
      objectPairsHook: getAttribute(decoder, 'object_pairs_hook'),
      parseFloat: getAttribute(decoder, 'parse_float'),
      parseInt: getAttribute(decoder, 'parse_int'),
      parseConstant: getAttribute(decoder, 'parse_constant'),
      strict: isTruthy(getAttribute(decoder, 'strict')),
      error: namespace.get('JSONDecodeError') as PyValue,
    };
    const scanner = new Decoder(text, hooks, Number(toIndex(index)));
    const value = scanner.scanOnce();
    return newTuple([value, BigInt(scanner.position)]);
  });
}

export { pyRepr };
