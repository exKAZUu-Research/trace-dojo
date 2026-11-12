import { LIMITS } from '../interpreter/limits';
import type { RealmBuilder } from './realm';
import { CollectionState, constructorNameOf } from './realmCollections';
import { WELL_KNOWN_SYMBOLS } from './realmIterators';
import type { Runtime } from './runtime';
import {
  HOLE,
  isAccessor,
  isCallable,
  isObject,
  JsArray,
  JsFunction,
  type JsObject,
  JsThrow,
  type Key,
  type NativeCall,
  type Value,
} from './values';

export function defineJsonBuiltins(builder: RealmBuilder): void {
  const json = builder.namespace('JSON');
  builder.constant(json, WELL_KNOWN_SYMBOLS.toStringTag, 'JSON');
  builder.method(json, 'stringify', 3, (call) =>
    jsonStringify(call.runtime, call.args[0], call.args[1], call.args[2], call.callRow)
  );
  builder.method(json, 'parse', 2, jsonParse);
  builder.global(
    'structuredClone',
    builder.function('structuredClone', 1, ({ runtime, args }) => structuredClone(runtime, args[0], new Map()))
  );
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
  const list: string[] = [];
  runtime.scan(replacer.elements.length);
  for (const element of replacer.elements) {
    if (typeof element !== 'string' && typeof element !== 'number') continue;
    const key = String(element);
    if (!list.includes(key)) list.push(key);
  }
  return list;
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
  const { runtime, callRow } = serializer;
  runtime.spend();
  let value = runtime.get(holder, key);
  if (isObject(value)) {
    const toJson = runtime.get(value, 'toJSON');
    if (isCallable(toJson)) value = runtime.call(toJson, value, [key], callRow);
  }
  if (serializer.replacer) value = runtime.call(serializer.replacer, holder, [key, value], callRow);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return quoteJson(runtime, value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (!isObject(value) || isCallable(value)) return undefined;
  const object = value;
  return runtime.hold(object, () => {
    enter(serializer, object, key, inArray);
    const text = object instanceof JsArray ? serializeArray(serializer, object) : serializeObject(serializer, object);
    serializer.stack.pop();
    return text;
  });
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
  for (let index = 0; index < array.elements.length; index++) {
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

/** A JSON text parser whose SyntaxError messages are V8's. */
class JsonParser {
  private position = 0;

  constructor(
    private readonly runtime: Runtime,
    private readonly text: string
  ) {}

  parse(): Value {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position < this.text.length) this.fail('Unexpected non-whitespace character after JSON', '');
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
        this.runtime.createDataProperty(object, key, this.parseValue(depth + 1));
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
        const element = this.parseValue(depth + 1);
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
  const value = new JsonParser(runtime, text).parse();
  const reviver = args[1];
  if (!isCallable(reviver)) return value;
  const root = runtime.newObject();
  runtime.createDataProperty(root, '', value);
  return runtime.hold(root, () => internalize(runtime, root, '', reviver, callRow));
}

/** The spec's InternalizeJSONProperty, which passes each value to the reviver from the leaves up. */
function internalize(
  runtime: Runtime,
  holder: JsObject,
  key: string,
  reviver: JsFunction,
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
        const revived = internalize(runtime, value, childKey, reviver, callRow);
        if (revived === undefined) runtime.deleteProperty(value, childKey);
        else runtime.createDataProperty(value, childKey, revived);
      }
    });
  }
  return runtime.call(reviver, holder, [key, value], callRow);
}

// structuredClone -----------------------------------------------------------------------------------------------------

/** The structured clone of plain data: primitives, arrays, plain objects, Maps, Sets, and errors. */
// code-gauge-allow functionCognitiveComplexity 27 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
// code-gauge-allow functionNcss 35 -- Transcribes the specification's algorithm step by step, whose branches mirror its steps.
function structuredClone(runtime: Runtime, value: Value, memory: Map<JsObject, JsObject>): Value {
  runtime.spend();
  if (typeof value === 'symbol') return cloneError(runtime, value.toString());
  if (!isObject(value)) return value;
  const cloned = memory.get(value);
  if (cloned) return cloned;
  if (value instanceof JsFunction || value.turtle || value.promise || value.generator || value.hostIterator) {
    return cloneError(
      runtime,
      value instanceof JsFunction && value.behavior.kind !== 'native' ? value.behavior.node.source : '#<Object>'
    );
  }
  if (value.collection?.isWeak) return cloneError(runtime, `#<${value.collection.kind}>`);
  if (value instanceof JsArray) return cloneArray(runtime, value, memory);
  const { collection } = value;
  const copy = runtime.newObject(collection || value.isError ? value.proto : runtime.realm.objectPrototype);
  memory.set(value, copy);
  return runtime.hold(copy, () => {
    if (collection) {
      const state = new CollectionState(collection.kind);
      copy.collection = state;
      for (const entry of collection.liveEntries(runtime)) {
        const key = structuredClone(runtime, entry.key, memory);
        state.set(
          runtime,
          key,
          runtime.hold(key, () => structuredClone(runtime, entry.value, memory))
        );
      }
    } else if (value.isError) {
      copy.isError = true;
      for (const key of ['message', 'cause']) {
        const property = value.properties.get(key);
        if (property && !isAccessor(property)) {
          copy.properties.set(key, { ...property, value: structuredClone(runtime, property.value, memory) });
        }
      }
    } else {
      copyOwnProperties(runtime, value, copy, memory);
    }
    return copy;
  });
}

function cloneArray(runtime: Runtime, source: JsArray, memory: Map<JsObject, JsObject>): JsArray {
  const array = runtime.newArray([]);
  memory.set(source, array);
  return runtime.hold(array, () => {
    for (const element of source.elements) {
      runtime.allocate(1);
      array.elements.push(element === HOLE ? HOLE : structuredClone(runtime, element, memory));
    }
    copyOwnProperties(runtime, source, array, memory);
    return array;
  });
}

/** Copies the own enumerable string-keyed properties, which for an array are those besides its elements. */
function copyOwnProperties(
  runtime: Runtime,
  source: JsObject,
  target: JsObject,
  memory: Map<JsObject, JsObject>
): void {
  const keys =
    source instanceof JsArray
      ? [...source.properties.keys()].filter((key) => typeof key === 'string')
      : runtime.ownKeys(source);
  for (const key of keys) {
    if (!runtime.getOwnProperty(source, key)?.enumerable) continue;
    runtime.createDataProperty(target, key, structuredClone(runtime, runtime.get(source, key), memory));
  }
}

function cloneError(runtime: Runtime, description: string): never {
  const error = runtime.newError('Error', `${description} could not be cloned.`);
  error.properties.set('name', { value: 'DataCloneError', writable: true, enumerable: false, configurable: true });
  throw new JsThrow(error);
}
