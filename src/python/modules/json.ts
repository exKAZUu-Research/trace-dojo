import { LIMITS } from '../../interpreter/limits';
import { pyRepr } from '../conversions';
import { builtin } from '../define';
import { builtinMemberValue } from '../enums';
import { registerModule, registerUnsupportedAttributes } from '../modules';
import { floatRepr, intToString, parseIntText, toIndex } from '../numbers';
import { callValue, getAttribute, isTruthy, toArray } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { runModuleSource } from '../sourceModules';
import { repeatText } from '../stringBuilder';
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
  pyError,
  stringValue,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../types';
import { PyDict, PyError, type PyInstance, PyList, type PyObject, PyTuple, type PyValue } from '../values';
import { JSON_MODULE_SOURCE, JSON_SOURCE } from './jsonSource';

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
    // oxlint-disable-next-line unicorn/prefer-code-point -- JSON escapes the two surrogates of an astral character separately.
    result += `\\u${char.charCodeAt(unit).toString(16).padStart(4, '0')}`;
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

/** What one call of the encoder has done so far. */
interface EncodeState {
  /** The containers being encoded, among which a repeated one is a circular reference. */
  containers: Set<PyObject>;
  /** The pieces of the output in order, and their total length. */
  parts: string[];
  length: number;
}

/**
 * Appends a piece of the output. Every piece passes through here, so the length checked against the string limit is
 * the length of the output itself, and an output beyond the limit ends before the rest is made.
 */
function write(state: EncodeState, text: string): void {
  state.length += text.length;
  if (state.length > LIMITS.maxStringLength) throw pyError('MemoryError');
  state.parts.push(text);
}

function encode(member: PyValue, options: DumpOptions, level: number, state: EncodeState): void {
  currentRuntime().spend();
  const value = builtinMemberValue(unbox(member));
  if (value instanceof PyList || value instanceof PyTuple) return encodeArray(value, options, level, state);
  if (value instanceof PyDict) return encodeObject(value, options, level, state);
  const text = scalarText(value, options, state);
  if (text !== undefined) return write(state, text);
  enterContainer(value as PyObject, state, options);
  encode(callValue(options.defaultFn, [value]), options, level, state);
  state.containers.delete(value as PyObject);
}

/** The text of a value that is not a container, or undefined for one the `default` function must convert. */
function scalarText(value: PyValue, options: DumpOptions, state: EncodeState): string | undefined {
  if (typeof value === 'string') return quoted(value, options.ensureAscii, state);
  if (value === None) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return floatText(value, options);
  return typeof value === 'bigint' ? intToString(value) : undefined;
}

/** Quotes a string, refusing one that cannot fit before doing the work of escaping it. */
function quoted(text: string, ensureAscii: boolean, state: EncodeState): string {
  if (state.length + text.length + 2 > LIMITS.maxStringLength) throw pyError('MemoryError');
  currentRuntime().buildString(text.length);
  return quote(text, ensureAscii);
}

function encodeArray(value: PyList | PyTuple, options: DumpOptions, level: number, state: EncodeState): void {
  if (value.items.length === 0) return write(state, '[]');
  enterContainer(value, state, options);
  write(state, '[');
  for (const [index, item] of value.items.entries()) {
    if (index > 0) write(state, options.itemSeparator);
    writeNewline(options, level + 1, state);
    encode(item, options, level + 1, state);
  }
  state.containers.delete(value);
  writeNewline(options, level, state);
  write(state, ']');
}

function encodeObject(value: PyDict, options: DumpOptions, level: number, state: EncodeState): void {
  enterContainer(value, state, options);
  let isEmpty = true;
  for (const [key, item] of objectEntries(value, options)) {
    const text = keyText(key, options);
    if (text === undefined) continue;
    write(state, isEmpty ? '{' : options.itemSeparator);
    isEmpty = false;
    writeNewline(options, level + 1, state);
    write(state, quoted(text, options.ensureAscii, state));
    write(state, options.keySeparator);
    encode(item, options, level + 1, state);
  }
  state.containers.delete(value);
  if (isEmpty) return write(state, '{}');
  writeNewline(options, level, state);
  write(state, '}');
}

function objectEntries(value: PyDict, options: DumpOptions): (readonly [PyValue, PyValue])[] {
  const entries = value.store.ordered().map((entry) => [entry.key, entry.value] as const);
  if (!options.sortKeys) return entries;
  // As the encoders of CPython, the items themselves are sorted, keys and then values, before the keys are converted.
  return toArray(
    callValue(currentRuntime().builtins.get('sorted') as PyValue, [newList(entries.map((entry) => newTuple(entry)))])
  ).map((item) => (item as PyTuple).items as [PyValue, PyValue]);
}

function enterContainer(value: PyObject, state: EncodeState, options: DumpOptions): void {
  if (!options.checkCircular) return;
  if (state.containers.has(value)) throw valueError('Circular reference detected');
  state.containers.add(value);
}

function writeNewline(options: DumpOptions, depth: number, state: EncodeState): void {
  if (options.indent !== undefined) write(state, `\n${repeatText(options.indent, depth)}`);
}

/** The text of a dict key, or undefined for a key that `skipkeys` skips. */
function keyText(member: PyValue, options: DumpOptions): string | undefined {
  const key = builtinMemberValue(unbox(member));
  if (typeof key === 'string') return key;
  if (typeof key === 'number') return floatText(key, options);
  if (key === true) return 'true';
  if (key === false) return 'false';
  if (key === None) return 'null';
  if (typeof key === 'bigint') return intToString(key);
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

  // code-gauge-allow functionCognitiveComplexity 17 -- One case per kind of JSON value.
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
    let end = this.index;
    while (end < this.chars.length && '+-.0123456789Ee'.includes(this.chars[end])) end++;
    currentRuntime().scan(end - this.index);
    const match = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/.exec(this.chars.slice(this.index, end).join(''));
    if (!match) throw this.error('Expecting value');
    this.index += match[0].length;
    if (match[1] === undefined && match[2] === undefined) {
      return this.hooks.parseInt === intClass
        ? (parseIntText(match[0], 10) as bigint)
        : callValue(this.hooks.parseInt, [match[0]]);
    }
    return this.hooks.parseFloat === floatClass ? Number(match[0]) : callValue(this.hooks.parseFloat, [match[0]]);
  }

  // code-gauge-allow duplicateLines 24 -- The JSON object grammar mirrors the array grammar, as CPython's scanner does.
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

  // code-gauge-allow duplicateLines 23 -- The JSON array grammar mirrors the object grammar, as CPython's scanner does.
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

  // code-gauge-allow functionCognitiveComplexity 19 -- Follows JSON string escapes.
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
});

/** The names the Python part defines for itself, which CPython keeps in json.decoder and json.encoder. */
const PRIVATE_NAMES = new Set(['INFINITY', 'NaN', 'NegInf', 'PosInf', 'encode_basestring', 'encode_basestring_ascii']);

registerModule('json', (runtime, moduleNamespace) => {
  // Encoder and decoder classes retain their implementation globals; public functions use the module's globals.
  const namespace = new Map<string, PyValue>([['__name__', 'json']]);
  const encodeAscii = jsonStringEncoder(true);
  const encodeText = jsonStringEncoder(false);
  for (const [name, value] of [
    ['encode_basestring_ascii', encodeAscii],
    ['encode_basestring', encodeText],
    [
      '_skip_whitespace',
      builtin('_skip_whitespace', 'expected', 2, 2, ([text, index]) => skipWhitespace(textArgument(text), index)),
    ],
    ['_make_scanner', builtin('_make_scanner', 'one', 1, 1, ([decoder]) => makeScanner(decoder, namespace))],
    ['_c_make_encoder', builtin('_c_make_encoder', 'expected', 9, 9, (args) => makeEncoder(args, encodeAscii))],
  ] as const) {
    namespace.set(name, value);
  }
  runModuleSource(runtime, namespace, JSON_SOURCE);
  for (const [name, value] of namespace) {
    if (!PRIVATE_NAMES.has(name) && (!name.startsWith('_') || name.startsWith('_default_'))) {
      moduleNamespace.set(name, value);
    }
  }
  for (const name of ['__version__', '__all__']) moduleNamespace.set(name, namespace.get(name) as PyValue);
  runModuleSource(runtime, moduleNamespace, JSON_MODULE_SOURCE);
  // A decoder imports json.decoder, whose code imports names from the json module, which hold them only from here on.
  const decoder = callValue(
    namespace.get('JSONDecoder') as PyValue,
    [],
    new Map([
      ['object_hook', None],
      ['object_pairs_hook', None],
    ])
  );
  moduleNamespace.set('_default_decoder', decoder);
  return new Map();
});

export function jsonStringEncoder(ensureAscii: boolean): PyValue {
  return builtin(ensureAscii ? 'encode_basestring_ascii' : 'encode_basestring', 'one', 1, 1, ([text]) =>
    quoteAlone(textArgument(text), ensureAscii)
  );
}

function quoteAlone(text: string, ensureAscii: boolean): string {
  currentRuntime().buildString(text.length);
  const quoted = quote(text, ensureAscii);
  currentRuntime().buildString(quoted.length);
  return quoted;
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
    indent: indent === None ? undefined : (unbox(indent) as string),
    keySeparator: unbox(keySeparator) as string,
    itemSeparator: unbox(itemSeparator) as string,
    sortKeys: isTruthy(sortKeys),
    skipKeys: isTruthy(skipKeys),
    allowNan: isTruthy(allowNan),
    ensureAscii: encoder === encodeAscii,
    checkCircular: markers !== None,
    defaultFn,
  };
  return builtin('_iterencode', 'expected', 2, 2, ([value]) => {
    const state: EncodeState = { containers: new Set(), parts: [], length: 0 };
    encode(value, options, 0, state);
    const text = state.parts.join('');
    currentRuntime().buildString(text.length);
    return newTuple([text]);
  });
}

/** `scanner.make_scanner(decoder)`: decodes one value at an index, raising StopIteration where none starts. */
function makeScanner(decoder: PyValue, namespace: Map<string, PyValue>): PyValue {
  return builtin('scan_once', 'expected', 2, 2, ([text, index]) => {
    const source = textArgument(text);
    const hooks: DecodeHooks = {
      objectHook: getAttribute(decoder, 'object_hook'),
      objectPairsHook: getAttribute(decoder, 'object_pairs_hook'),
      parseFloat: getAttribute(decoder, 'parse_float'),
      parseInt: getAttribute(decoder, 'parse_int'),
      parseConstant: getAttribute(decoder, 'parse_constant'),
      strict: isTruthy(getAttribute(decoder, 'strict')),
      error: namespace.get('JSONDecodeError') as PyValue,
    };
    const scanner = new Decoder(source, hooks, Number(toIndex(index)));
    const value = scanner.scanOnce();
    return newTuple([value, BigInt(scanner.position)]);
  });
}

function textArgument(value: PyValue): string {
  const text = stringValue(value);
  if (text === undefined) throw typeError(`first argument must be a string, not ${typeName(value)}`);
  return text;
}

export { pyRepr };
