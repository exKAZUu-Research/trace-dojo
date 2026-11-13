import { LIMITS } from '../interpreter/limits';
import type { RealmBuilder } from './realm';
import { constructorNameOf } from './realmCollections';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  isCallable,
  isObject,
  JsArray,
  type JsFunction,
  JsObject,
  type Key,
  type NativeCall,
  type Value,
} from './values';

export function defineJsonBuiltins(builder: RealmBuilder): void {
  const json = builder.namespace('JSON');
  builder.constant(json, WELL_KNOWN_SYMBOLS.toStringTag, 'JSON');
  builder.method(json, 'stringify', 3, (call) =>
    withStackLimit(call.runtime, () =>
      jsonStringify(call.runtime, call.args[0], call.args[1], call.args[2], call.callRow)
    )
  );
  builder.method(json, 'parse', 2, (call) => withStackLimit(call.runtime, () => jsonParse(call)));
}

/**
 * Runs a builtin that recurses on the host into nested data, turning a host stack overflow into the RangeError the
 * program can catch, as Node.js throws it.
 */
export function withStackLimit<T>(runtime: Runtime, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      return runtime.throwError('RangeError', 'Maximum call stack size exceeded');
    }
    throw error;
  }
}

// JSON.stringify ------------------------------------------------------------------------------------------------------

interface Serializer {
  runtime: Runtime;
  callRow: number | undefined;
  replacer: JsFunction | undefined;
  propertyList: string[] | undefined;
  gap: string;
  indent: string;
  /** The objects being serialized, each with the key its holder reached it by, for the cycle check and its message. */
  stack: { object: JsObject; key: Key; inArray: boolean }[];
}

/** The spec's JSON.stringify, returning undefined when the value has no JSON text. */
export function jsonStringify(
  runtime: Runtime,
  value: Value,
  replacerValue: Value,
  space: Value,
  callRow: number | undefined
): string | undefined {
  const serializer: Serializer = {
    runtime,
    callRow,
    replacer: isCallable(replacerValue) ? replacerValue : undefined,
    propertyList: replacerValue instanceof JsArray ? propertyListOf(runtime, replacerValue) : undefined,
    gap: gapOf(space),
    indent: '',
    stack: [],
  };
  const wrapper = runtime.newObject();
  runtime.createDataProperty(wrapper, '', value);
  return runtime.hold(wrapper, () => serializeProperty(serializer, '', wrapper, false));
}

function propertyListOf(runtime: Runtime, replacer: JsArray): string[] {
  // A Set keeps the first occurrence of each key in order, without searching the keys kept so far.
  const keys = new Set<string>();
  runtime.scan(replacer.elements.length);
  for (const element of replacer.elements) {
    if (typeof element === 'string' || typeof element === 'number') keys.add(String(element));
  }
  return [...keys];
}

function gapOf(space: Value): string {
  if (typeof space === 'number') return ' '.repeat(Math.max(0, Math.min(10, Math.trunc(space) || 0)));
  if (typeof space === 'string') return space.slice(0, 10);
  return '';
}

/** The spec's SerializeJSONProperty. */
function serializeProperty(
  serializer: Serializer,
  key: string,
  holder: JsObject,
  inArray: boolean
): string | undefined {
  const { runtime } = serializer;
  runtime.spend();
  const value = valueToSerialize(serializer, key, holder);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return quoteJson(runtime, value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'bigint') return runtime.throwError('TypeError', 'Do not know how to serialize a BigInt');
  if (!isObject(value) || isCallable(value)) return undefined;
  const object = value;
  return runtime.hold(object, () => {
    enter(serializer, object, key, inArray);
    const text = object instanceof JsArray ? serializeArray(serializer, object) : serializeObject(serializer, object);
    serializer.stack.pop();
    return text;
  });
}

/** What SerializeJSONProperty writes for a property: its `toJSON` and the replacer applied, and a boxed value unboxed. */
function valueToSerialize(serializer: Serializer, key: string, holder: JsObject): Value {
  const { runtime, callRow } = serializer;
  let value = runtime.get(holder, key);
  if (isObject(value) || typeof value === 'bigint') {
    const toJson = runtime.get(value, 'toJSON');
    if (isCallable(toJson)) value = runtime.call(toJson, value, [key], callRow);
  }
  if (serializer.replacer) value = runtime.call(serializer.replacer, holder, [key, value], callRow);
  if (!(value instanceof JsObject) || value.primitive === undefined || typeof value.primitive === 'symbol')
    return value;
  if (typeof value.primitive === 'number') return runtime.toNumber(value);
  return typeof value.primitive === 'string' ? runtime.toString(value) : value.primitive;
}

function quoteJson(runtime: Runtime, text: string): string {
  runtime.buildString(text.length + 2);
  return JSON.stringify(text);
}

/** Pushes an object about to be serialized, throwing V8's TypeError when it is already being serialized. */
function enter(serializer: Serializer, object: JsObject, key: Key, inArray: boolean): void {
  const { runtime, stack } = serializer;
  const start = stack.findIndex((entry) => entry.object === object);
  if (start !== -1) runtime.throwError('TypeError', circularMessage(runtime, stack.slice(start), key, inArray));
  if (stack.length >= LIMITS.maxCallDepth) runtime.throwError('RangeError', 'Maximum call stack size exceeded');
  stack.push({ object, key, inArray });
}

function keyText(key: Key, isIndex: boolean): string {
  return isIndex ? `index ${String(key)}` : `property '${String(key)}'`;
}

/** V8's message for a cycle, which names the first two and the last of the steps that lead back. */
function circularMessage(runtime: Runtime, cycle: Serializer['stack'], closingKey: Key, inArray: boolean): string {
  const line = (entry: Serializer['stack'][number]): string =>
    `\n    |     ${keyText(entry.key, entry.inArray)} -> object with constructor '${constructorNameOf(runtime, entry.object)}'`;
  const steps = cycle.slice(1);
  const lines =
    steps.length > 3
      ? [line(steps[0]), line(steps[1]), '\n    |     ...', line(steps.at(-1) as (typeof steps)[number])]
      : steps.map((entry) => line(entry));
  return (
    'Converting circular structure to JSON' +
    `\n    --> starting at object with constructor '${constructorNameOf(runtime, cycle[0].object)}'` +
    lines.join('') +
    `\n    --- ${keyText(closingKey, inArray)} closes the circle`
  );
}

function serializeObject(serializer: Serializer, object: JsObject): string {
  const { runtime } = serializer;
  const stepback = serializer.indent;
  serializer.indent += serializer.gap;
  const keys = serializer.propertyList ?? runtime.ownEnumerableKeys(object);
  const parts: string[] = [];
  let length = 0;
  for (const key of keys) {
    const text = serializeProperty(serializer, key, object, false);
    if (text === undefined) continue;
    const part = `${quoteJson(runtime, key)}:${serializer.gap ? ' ' : ''}${text}`;
    length += part.length + serializer.indent.length + 2;
    runtime.extendString(length, part.length);
    parts.push(part);
  }
  const text = joinParts(serializer, parts, stepback, '{', '}');
  serializer.indent = stepback;
  return text;
}

function serializeArray(serializer: Serializer, array: JsArray): string {
  const { runtime } = serializer;
  const stepback = serializer.indent;
  serializer.indent += serializer.gap;
  const parts: string[] = [];
  let length = 0;
  const elementCount = array.elements.length;
  for (let index = 0; index < elementCount; index++) {
    const part = serializeProperty(serializer, String(index), array, true) ?? 'null';
    length += part.length + serializer.indent.length + 2;
    runtime.extendString(length, part.length);
    parts.push(part);
  }
  const text = joinParts(serializer, parts, stepback, '[', ']');
  serializer.indent = stepback;
  return text;
}

function joinParts(serializer: Serializer, parts: string[], stepback: string, open: string, close: string): string {
  if (parts.length === 0) return `${open}${close}`;
  if (!serializer.gap) return `${open}${parts.join(',')}${close}`;
  const separator = `,\n${serializer.indent}`;
  return `${open}\n${serializer.indent}${parts.join(separator)}\n${stepback}${close}`;
}

// JSON.parse ----------------------------------------------------------------------------------------------------------

const MAX_CONTEXT_CHARACTERS = 10;

/** The text of each primitive a JSON text gives, by the object that holds it and its key, for a reviver's context. */
type PrimitiveSources = Map<JsObject, Map<string, { value: Value; source: string }>>;

/** A JSON text parser whose SyntaxError messages are V8's. */
class JsonParser {
  private position = 0;

  constructor(
    private readonly runtime: Runtime,
    private readonly text: string,
    private readonly sources?: PrimitiveSources
  ) {}

  /** Parses the text into the property `''` of `root`. */
  parse(root: JsObject): void {
    this.runtime.createDataProperty(root, '', this.parseChild(root, '', 0));
    this.skipWhitespace();
    if (this.position < this.text.length) this.fail('Unexpected non-whitespace character after JSON', '');
  }

  private parseChild(holder: JsObject, key: string, depth: number): Value {
    this.skipWhitespace();
    const start = this.position;
    const value = this.parseValue(depth);
    if (!this.sources) return value;
    let holderSources = this.sources.get(holder);
    if (!holderSources) {
      holderSources = new Map();
      this.sources.set(holder, holderSources);
    }
    // A later duplicate key replaces the source of an earlier one, and an object or array has none.
    if (isObject(value)) holderSources.delete(key);
    else holderSources.set(key, { value, source: this.text.slice(start, this.position) });
    return value;
  }

  private parseValue(depth: number): Value {
    if (depth > LIMITS.maxCallDepth) this.runtime.throwError('RangeError', 'Maximum call stack size exceeded');
    this.runtime.spend();
    this.skipWhitespace();
    const character = this.text[this.position];
    if (character === '{') return this.parseObject(depth);
    if (character === '[') return this.parseArray(depth);
    if (character === '"') return this.parseString();
    if (character === '-' || (character >= '0' && character <= '9')) return this.parseNumber();
    for (const [literal, value] of [
      ['true', true],
      ['false', false],
      // oxlint-disable-next-line unicorn/no-null -- The JSON literal null is JavaScript's null.
      ['null', null],
    ] as const) {
      if (character === literal[0]) return this.parseLiteral(literal, value);
    }
    return this.unexpected();
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- Follows V8's JSON parser, whose error messages each branch reproduces.
  private parseObject(depth: number): JsObject {
    const object = this.runtime.newObject();
    return this.runtime.hold(object, () => {
      this.position++;
      this.skipWhitespace();
      if (this.text[this.position] === '}') {
        this.position++;
        return object;
      }
      for (let first = true; ; first = false) {
        this.skipWhitespace();
        if (this.text[this.position] !== '"') {
          this.fail(first ? "Expected property name or '}'" : 'Expected double-quoted property name');
        }
        const key = this.parseString();
        this.skipWhitespace();
        if (this.text[this.position] !== ':') this.fail("Expected ':' after property name");
        this.position++;
        this.runtime.createDataProperty(object, key, this.parseChild(object, key, depth + 1));
        this.skipWhitespace();
        const next = this.text[this.position];
        if (next === '}') {
          this.position++;
          return object;
        }
        if (next !== ',') this.fail("Expected ',' or '}' after property value");
        this.position++;
      }
    });
  }

  private parseArray(depth: number): JsArray {
    const array = this.runtime.newArray([]);
    return this.runtime.hold(array, () => {
      this.position++;
      this.skipWhitespace();
      if (this.text[this.position] === ']') {
        this.position++;
        return array;
      }
      for (;;) {
        const element = this.parseChild(array, String(array.elements.length), depth + 1);
        this.runtime.allocate(1);
        array.elements.push(element);
        this.skipWhitespace();
        const next = this.text[this.position];
        if (next === ']') {
          this.position++;
          return array;
        }
        if (next !== ',') this.fail("Expected ',' or ']' after array element");
        this.position++;
      }
    });
  }

  private parseString(): string {
    const { text } = this;
    const start = ++this.position;
    let result = '';
    let copied = start;
    for (;;) {
      if (this.position >= text.length) this.fail('Unterminated string');
      const character = text[this.position];
      if (character === '"') break;
      if (character < ' ') this.fail('Bad control character in string literal');
      if (character !== '\\') {
        this.position++;
        continue;
      }
      result += text.slice(copied, this.position);
      this.position++;
      result += this.parseEscape();
      copied = this.position;
    }
    result += text.slice(copied, this.position);
    this.position++;
    this.runtime.scan(this.position - start);
    return result;
  }

  private parseEscape(): string {
    const character = this.text[this.position];
    if (character === undefined) return this.unexpected();
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
    if (Object.hasOwn(simple, character)) {
      this.position++;
      return simple[character];
    }
    if (character !== 'u') this.fail('Bad escaped character');
    this.position++;
    for (let index = 0; index < 4; index++) {
      if (!/^[\dA-Fa-f]$/.test(this.text[this.position] ?? '')) this.fail('Bad Unicode escape');
      this.position++;
    }
    // oxlint-disable-next-line unicorn/prefer-code-point -- A \u escape is one UTF-16 code unit, which may be half a pair.
    return String.fromCharCode(Number.parseInt(this.text.slice(this.position - 4, this.position), 16));
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- Follows V8's JSON parser, whose error messages each branch reproduces.
  // code-gauge-allow functionNcss 31 -- Follows V8's JSON parser, whose error messages each branch reproduces.
  private parseNumber(): number {
    const { text } = this;
    const start = this.position;
    const isDigit = (): boolean => /^\d$/.test(text[this.position] ?? '');
    if (text[this.position] === '-') {
      this.position++;
      if (!isDigit()) this.fail('No number after minus sign');
    }
    if (text[this.position] === '0') {
      this.position++;
      if (isDigit()) this.fail('Unexpected number');
    } else {
      while (isDigit()) this.position++;
    }
    if (text[this.position] === '.') {
      this.position++;
      if (!isDigit()) this.fail('Unterminated fractional number');
      while (isDigit()) this.position++;
    }
    if (text[this.position] === 'e' || text[this.position] === 'E') {
      this.position++;
      if (text[this.position] === '+' || text[this.position] === '-') this.position++;
      if (!isDigit()) this.fail('Exponent part is missing a number');
      while (isDigit()) this.position++;
    }
    this.runtime.scan(this.position - start);
    return Number(text.slice(start, this.position));
  }

  private parseLiteral(literal: string, value: Value): Value {
    for (const expected of literal) {
      if (this.text[this.position] !== expected) return this.unexpected();
      this.position++;
    }
    return value;
  }

  private skipWhitespace(): void {
    while (' \t\n\r'.includes(this.text[this.position] ?? 'x')) this.position++;
  }

  /** Throws one of V8's messages that end with the position, line, and column. */
  private fail(message: string, where = ' in JSON'): never {
    const { line, column } = this.location();
    return this.runtime.throwError(
      'SyntaxError',
      `${message}${where} at position ${this.position} (line ${line} column ${column})`
    );
  }

  /** Throws V8's message for a character that cannot start or continue the JSON text where it is. */
  private unexpected(): never {
    const { text, position } = this;
    if (position >= text.length) return this.runtime.throwError('SyntaxError', 'Unexpected end of JSON input');
    if (['[object Object]', 'undefined', 'Infinity', 'NaN'].includes(text)) {
      return this.runtime.throwError('SyntaxError', `"${text}" is not valid JSON`);
    }
    const token = text[position];
    let context = `"${text}"`;
    if (text.length >= MAX_CONTEXT_CHARACTERS * 2 + 1) {
      const start = Math.max(position - MAX_CONTEXT_CHARACTERS, 0);
      const end = Math.min(position + MAX_CONTEXT_CHARACTERS, text.length);
      context = `${start > 0 ? '...' : ''}"${text.slice(start, end)}"${end < text.length ? '...' : ''}`;
    }
    return this.runtime.throwError('SyntaxError', `Unexpected token '${token}', ${context} is not valid JSON`);
  }

  private location(): { line: number; column: number } {
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < this.position; index++) {
      const character = this.text[index];
      if (character === '\r' && this.text[index + 1] === '\n' && index + 1 < this.position) index++;
      if (character === '\r' || character === '\n') {
        line++;
        lineStart = index + 1;
      }
    }
    return { line, column: this.position - lineStart + 1 };
  }
}

function jsonParse({ runtime, args, callRow }: NativeCall): Value {
  const text = runtime.toString(args[0]);
  runtime.scan(text.length);
  const reviver = args[1];
  const sources: PrimitiveSources | undefined = isCallable(reviver) ? new Map() : undefined;
  const root = runtime.newObject();
  return runtime.hold(root, () => {
    new JsonParser(runtime, text, sources).parse(root);
    if (!isCallable(reviver)) return runtime.get(root, '');
    return internalize(runtime, root, '', reviver, sources as PrimitiveSources, callRow);
  });
}

/** The spec's InternalizeJSONProperty, which passes each value to the reviver from the leaves up. */
function internalize(
  runtime: Runtime,
  holder: JsObject,
  key: string,
  reviver: JsFunction,
  sources: PrimitiveSources,
  callRow: number | undefined
): Value {
  runtime.spend();
  const value = runtime.get(holder, key);
  if (isObject(value)) {
    runtime.hold(value, () => {
      const keys =
        value instanceof JsArray
          ? Array.from({ length: value.elements.length }, (_, index) => String(index))
          : runtime.ownEnumerableKeys(value);
      for (const childKey of keys) {
        const revived = internalize(runtime, value, childKey, reviver, sources, callRow);
        if (revived === undefined) runtime.deleteProperty(value, childKey);
        else runtime.createDataProperty(value, childKey, revived);
      }
    });
  }
  const context = runtime.newObject();
  const parsed = isObject(value) ? undefined : sources.get(holder)?.get(key);
  if (parsed && Object.is(parsed.value, value)) runtime.createDataProperty(context, 'source', parsed.source);
  return runtime.call(reviver, holder, [key, value, context], callRow);
}
