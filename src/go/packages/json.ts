// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { mapKeyOf } from '../equality';
import { newError } from '../errorValues';
import { formatFloat } from '../floatFormat';
import { decodeRune, encodeRune, RUNE_ERROR } from '../literals';
import { compareMapKeys } from '../mapOrder';
import { dynamicMethod } from '../methods';
import { definePackage, fn, nativeFunction } from '../native';
import { quote } from '../quote';
import {
  ANY,
  BASIC,
  ERROR_TYPE,
  isExported,
  lookupFieldOrMethod,
  sliceOf,
  type Type,
  typeString,
  underlying,
} from '../types';
import { Cell, Complex, GoArray, GoMap, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { zeroValueOf } from '../zero';
import { BOOL, BYTES, byteSlice, bytesOf, errorText, STRING } from './support';

/** A failure that ends Marshal or Unmarshal with its error, as encoding/json's errors do. */
class JsonFailure {
  constructor(readonly message: string) {}
}

const fail = (message: string): never => {
  throw new JsonFailure(message);
};

// Fields ----------------------------------------------------------------------------------------------------------------

interface JsonField {
  name: string;
  /** The indexes of the field through embedded structs. */
  path: number[];
  type: Type;
  omitEmpty: boolean;
  quoted: boolean;
  tagged: boolean;
}

/** reflect.StructTag.Get: the value of a key in a conventional tag. */
function tagValue(tag: string | undefined, key: string): string | undefined {
  if (!tag) return undefined;
  const pattern = /([^\s:"]+):"((?:[^"\\]|\\.)*)"/g;
  for (const match of tag.matchAll(pattern)) if (match[1] === key) return match[2].replaceAll(/\\(.)/g, '$1');
  return undefined;
}

const VALID_TAG = /^[\w!#$%&()*+\-./:;<=>?@[\]^{|}~ ]+$/u;

/** Go's typeFields: the fields a struct encodes, with embedded structs' fields promoted by Go's dominance rules. */
// code-gauge-allow functionCognitiveComplexity 30 -- Transcribes encoding/json's typeFields.
function jsonFields(type: Type): JsonField[] {
  const found: (JsonField & { depth: number; index: number })[] = [];
  let order = 0;
  const visit = (structType: Type, path: number[], depth: number, seen: Set<Type>): void => {
    const under = underlying(structType);
    if (under.kind !== 'struct' || seen.has(structType)) return;
    const visited = new Set(seen).add(structType);
    for (const [index, field] of under.fields.entries()) {
      const tag = tagValue(field.tag, 'json');
      if (tag === '-') continue;
      const [tagName = '', ...options] = (tag ?? '').split(',');
      let fieldType = field.type;
      if (field.embedded) {
        const target =
          underlying(fieldType).kind === 'pointer' ? (underlying(fieldType) as { element: Type }).element : fieldType;
        if (!isExported(field.name) && underlying(target).kind !== 'struct') continue;
        if (tagName === '' && underlying(target).kind === 'struct') {
          visit(target, [...path, index], depth + 1, visited);
          continue;
        }
      } else if (!isExported(field.name)) continue;
      const tagged = tagName !== '' && VALID_TAG.test(tagName);
      fieldType = field.type;
      found.push({
        name: tagged ? tagName : field.name,
        path: [...path, index],
        type: fieldType,
        omitEmpty: options.includes('omitempty'),
        quoted: options.includes('string'),
        tagged,
        depth,
        index: order++,
      });
    }
  };
  visit(type, [], 0, new Set());
  const byName = new Map<string, typeof found>();
  for (const field of found) byName.set(field.name, [...(byName.get(field.name) ?? []), field]);
  const result: typeof found = [];
  for (const candidates of byName.values()) {
    const depth = Math.min(...candidates.map((field) => field.depth));
    const shallow = candidates.filter((field) => field.depth === depth);
    const tagged = shallow.filter((field) => field.tagged);
    if (shallow.length === 1) result.push(shallow[0]);
    else if (tagged.length === 1) result.push(tagged[0]);
  }
  return result.toSorted((a, b) => a.index - b.index);
}

function fieldValue(struct: GoStruct, path: number[]): Value | typeof MISSING {
  let current: Value = struct;
  for (const index of path) {
    if (current instanceof Pointer) current = current.load();
    if (current === undefined) return MISSING;
    current = (current as GoStruct).fields[index];
  }
  return current;
}

const MISSING = Symbol('missing');

// Encoding ------------------------------------------------------------------------------------------------------------

const HEX = '0123456789abcdef';

/** encoding/json's appendString, which escapes HTML characters and the line separators too. */
function encodeString(bytes: string): string {
  let result = '"';
  for (let index = 0; index < bytes.length;) {
    const byte = bytes.charCodeAt(index);
    if (byte < 0x80) {
      const char = bytes[index];
      if (char === '\\' || char === '"') result += `\\${char}`;
      else if (char === '\b') result += String.raw`\b`;
      else if (char === '\f') result += String.raw`\f`;
      else if (char === '\n') result += String.raw`\n`;
      else if (char === '\r') result += String.raw`\r`;
      else if (char === '\t') result += String.raw`\t`;
      else if (byte < 0x20 || char === '<' || char === '>' || char === '&')
        result += `\\u00${HEX[byte >> 4]}${HEX[byte & 0xf]}`;
      else result += char;
      index++;
      continue;
    }
    const { rune, size } = decodeRune(bytes, index);
    if (rune === RUNE_ERROR && size === 1) result += String.raw`\ufffd`;
    else if (rune === 0x20_28 || rune === 0x20_29) result += `\\u202${HEX[rune & 0xf]}`;
    else result += bytes.slice(index, index + size);
    index += size;
  }
  return `${result}"`;
}

function encodeFloat(value: number, bits: 32 | 64): string {
  if (!Number.isFinite(value)) fail(`json: unsupported value: ${formatFloat(value, 'g', -1, bits)}`);
  const absolute = Math.abs(value);
  const exponent = absolute !== 0 && (absolute < 1e-6 || absolute >= 1e21);
  let text = formatFloat(value, exponent ? 'e' : 'f', -1, bits);
  if (exponent) text = text.replace(/e-0(\d)$/, 'e-$1');
  return text;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: string): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [0, 1, 2].map((offset) => bytes.charCodeAt(index + offset));
    const chunk = (a << 16) | ((b || 0) << 8) | (c || 0);
    result += BASE64[(chunk >> 18) & 63] + BASE64[(chunk >> 12) & 63];
    result += index + 1 < bytes.length ? BASE64[(chunk >> 6) & 63] : '=';
    result += index + 2 < bytes.length ? BASE64[chunk & 63] : '=';
  }
  return result;
}

function unbase64(text: string): string | undefined {
  const clean = text.replaceAll(/[\r\n]/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return undefined;
  let result = '';
  for (let index = 0; index < clean.length; index += 4) {
    const values = Array.from(clean.slice(index, index + 4), (char) => (char === '=' ? 0 : BASE64.indexOf(char)));
    const chunk = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    result += String.fromCharCode((chunk >> 16) & 255);
    if (clean[index + 2] !== '=') result += String.fromCharCode((chunk >> 8) & 255);
    if (clean[index + 3] !== '=') result += String.fromCharCode(chunk & 255);
  }
  return result;
}

function isEmpty(value: Value, type: Type): boolean {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      return (
        value === false ||
        value === 0n ||
        value === 0 ||
        value === '' ||
        (value instanceof Complex && value.re === 0 && value.im === 0)
      );
    }
    case 'slice': {
      return ((value as Slice | undefined)?.length ?? 0) === 0;
    }
    case 'map': {
      return ((value as GoMap | undefined)?.entries.size ?? 0) === 0;
    }
    case 'array': {
      return under.length === 0;
    }
    default: {
      return value === undefined;
    }
  }
}

/** Calls a value's MarshalJSON or MarshalText method, if its type has one. */
function marshalerOf(value: Value, type: Type): string | undefined {
  for (const name of ['MarshalJSON', 'MarshalText']) {
    const selection = lookupFieldOrMethod(type, name);
    if (selection.kind !== 'method') continue;
    if (selection.method.pointerReceiver && underlying(type).kind !== 'pointer') continue;
    if (underlying(type).kind === 'pointer' && value === undefined) return 'null';
    const call = dynamicMethod(type, name);
    if (!call) continue;
    const [result, error] = call(value, []) as [Value, Value];
    if (error !== undefined) fail(`json: error calling ${name} for type ${typeString(type)}: ${errorText(error)}`);
    const text = bytesOf(result);
    if (name === 'MarshalText') return encodeString(text);
    const compacted = compact(text);
    if (compacted === undefined) fail(`json: error calling MarshalJSON for type ${typeString(type)}: invalid JSON`);
    return compacted;
  }
  return undefined;
}

// code-gauge-allow functionCognitiveComplexity 40 -- One case per kind of type, as encoding/json's encoders.
function encode(value: Value, type: Type, seen: Set<unknown>): string {
  const custom = marshalerOf(value, type);
  if (custom !== undefined) return custom;
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      if (under.basic === 'bool') return String(value);
      if (under.basic === 'string') return encodeString(value as string);
      if (under.basic === 'float32' || under.basic === 'float64')
        return encodeFloat(value as number, under.basic === 'float32' ? 32 : 64);
      if (typeof value === 'bigint') return String(value);
      return fail(`json: unsupported type: ${typeString(type)}`);
    }
    case 'interface': {
      if (value === undefined) return 'null';
      const iface = value as Iface;
      return encode(iface.value, iface.type, seen);
    }
    case 'pointer': {
      if (value === undefined) return 'null';
      const pointer = value as Pointer;
      if (seen.has(pointer.base)) fail(`json: unsupported value: encountered a cycle via ${typeString(type)}`);
      seen.add(pointer.base);
      try {
        return encode(pointer.load(), under.element, seen);
      } finally {
        seen.delete(pointer.base);
      }
    }
    case 'slice': {
      if (value === undefined) return 'null';
      const slice = value as Slice;
      if (isBasicKind(under.element, 'uint8')) return `"${base64(bytesOf(slice))}"`;
      return `[${slice
        .values()
        .map((item) => encode(item, under.element, seen))
        .join(',')}]`;
    }
    case 'array': {
      return `[${(value as GoArray).elements.map((item) => encode(item, under.element, seen)).join(',')}]`;
    }
    case 'map': {
      if (value === undefined) return 'null';
      const keyKind = underlying(under.key);
      if (keyKind.kind !== 'basic' || !(keyKind.basic === 'string' || /int/.test(keyKind.basic)))
        fail(`json: unsupported type: ${typeString(type)}`);
      const entries = [...(value as GoMap).entries.values()].map((entry) => ({
        key: typeof entry.key === 'bigint' ? String(entry.key) : (entry.key as string),
        value: entry.value,
      }));
      entries.sort((a, b) => compareMapKeys(a.key, b.key, BASIC.string));
      return `{${entries.map((entry) => `${encodeString(entry.key)}:${encode(entry.value, under.value, seen)}`).join(',')}}`;
    }
    case 'struct': {
      const parts: string[] = [];
      for (const field of jsonFields(type)) {
        const fieldValueOf = fieldValue(value as GoStruct, field.path);
        if (fieldValueOf === MISSING) continue;
        if (field.omitEmpty && isEmpty(fieldValueOf, field.type)) continue;
        let encoded = encode(fieldValueOf, field.type, seen);
        if (field.quoted && underlying(field.type).kind === 'basic') encoded = encodeString(encoded);
        parts.push(`${encodeString(field.name)}:${encoded}`);
      }
      return `{${parts.join(',')}}`;
    }
    default: {
      return fail(`json: unsupported type: ${typeString(type)}`);
    }
  }
}

function isBasicKind(type: Type, kind: string): boolean {
  const under = underlying(type);
  return under.kind === 'basic' && under.basic === kind;
}

/** encoding/json's Indent: newlines and indentation after `{`, `[`, and `,`, which leaves empty `{}` and `[]`. */
function indent(compactText: string, prefix: string, indentText: string): string {
  let result = '';
  let depth = 0;
  let needIndent = false;
  for (let index = 0; index < compactText.length; index++) {
    const char = compactText[index];
    if (char === '"') {
      let end = index + 1;
      while (compactText[end] !== '"') end += compactText[end] === '\\' ? 2 : 1;
      if (needIndent) {
        result += `\n${prefix}${indentText.repeat(depth)}`;
        needIndent = false;
      }
      result += compactText.slice(index, end + 1);
      index = end;
      continue;
    }
    if (needIndent && char !== ']' && char !== '}') {
      result += `\n${prefix}${indentText.repeat(depth)}`;
      needIndent = false;
    }
    if (char === '{' || char === '[') {
      result += char;
      depth++;
      needIndent = true;
    } else if (char === '}' || char === ']') {
      depth--;
      if (needIndent) needIndent = false;
      else result += `\n${prefix}${indentText.repeat(depth)}`;
      result += char;
    } else if (char === ',') {
      result += char;
      needIndent = true;
    } else if (char === ':') result += ': ';
    else result += char;
  }
  return result;
}

// Decoding ------------------------------------------------------------------------------------------------------------

type JsonNode =
  | { kind: 'object'; entries: [string, JsonNode][] }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'string'; value: string }
  | { kind: 'number'; text: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

/** Go's quoteChar for scanner errors. */
function quoteChar(byte: string): string {
  if (byte === "'") return String.raw`'\''`;
  if (byte === '"') return `'"'`;
  const quoted = quote(byte);
  return `'${quoted.slice(1, -1)}'`;
}

/** A JSON parser with the errors of Go's scanner. */
class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  private error(context: string): never {
    if (this.index >= this.text.length) return fail('unexpected end of JSON input');
    return fail(`invalid character ${quoteChar(this.charAt())} ${context}`);
  }

  private charAt(): string {
    const { rune, size } = decodeRune(this.text, this.index);
    return size > 1 ? encodeRune(rune) : this.text[this.index];
  }

  private skipSpace(): void {
    while (this.index < this.text.length && ' \t\n\r'.includes(this.text[this.index])) this.index++;
  }

  parseDocument(): JsonNode {
    const value = this.value();
    this.skipSpace();
    if (this.index < this.text.length) this.error('after top-level value');
    return value;
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- One case per kind of JSON value.
  private value(): JsonNode {
    this.skipSpace();
    const char = this.text[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return { kind: 'string', value: this.string() };
    if (char === '-' || (char >= '0' && char <= '9')) return { kind: 'number', text: this.number() };
    for (const [word, node] of [
      ['true', { kind: 'bool', value: true }],
      ['false', { kind: 'bool', value: false }],
      ['null', { kind: 'null' }],
    ] as const) {
      if (char === word[0]) {
        this.index++;
        for (const expected of word.slice(1)) {
          if (this.text[this.index] !== expected) this.error(`in literal ${word} (expecting '${expected}')`);
          this.index++;
        }
        return node;
      }
    }
    return this.error('looking for beginning of value');
  }

  private object(): JsonNode {
    this.index++;
    const entries: [string, JsonNode][] = [];
    this.skipSpace();
    if (this.text[this.index] === '}') {
      this.index++;
      return { kind: 'object', entries };
    }
    for (;;) {
      this.skipSpace();
      if (this.text[this.index] !== '"') this.error('looking for beginning of object key string');
      const key = this.string();
      this.skipSpace();
      if (this.text[this.index] !== ':') this.error('after object key');
      this.index++;
      entries.push([key, this.value()]);
      this.skipSpace();
      if (this.text[this.index] === ',') {
        this.index++;
        continue;
      }
      if (this.text[this.index] === '}') {
        this.index++;
        return { kind: 'object', entries };
      }
      this.error('after object key:value pair');
    }
  }

  private array(): JsonNode {
    this.index++;
    const items: JsonNode[] = [];
    this.skipSpace();
    if (this.text[this.index] === ']') {
      this.index++;
      return { kind: 'array', items };
    }
    for (;;) {
      items.push(this.value());
      this.skipSpace();
      if (this.text[this.index] === ',') {
        this.index++;
        continue;
      }
      if (this.text[this.index] === ']') {
        this.index++;
        return { kind: 'array', items };
      }
      this.error('after array element');
    }
  }

  private number(): string {
    const start = this.index;
    if (this.text[this.index] === '-') this.index++;
    const digit = (): boolean => this.text[this.index] >= '0' && this.text[this.index] <= '9';
    if (this.text[this.index] === '0') this.index++;
    else if (digit()) while (digit()) this.index++;
    else this.error('in numeric literal');
    if (this.text[this.index] === '.') {
      this.index++;
      if (!digit()) this.error('after decimal point in numeric literal');
      while (digit()) this.index++;
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index++;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index++;
      if (!digit()) this.error('in exponent of numeric literal');
      while (digit()) this.index++;
    }
    return this.text.slice(start, this.index);
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- The escapes of JSON strings.
  private string(): string {
    this.index++;
    let result = '';
    for (;;) {
      if (this.index >= this.text.length) this.error('in string literal');
      const char = this.text[this.index];
      if (char === '"') {
        this.index++;
        return result;
      }
      if (char.charCodeAt(0) < 0x20) this.error('in string literal');
      if (char !== '\\') {
        result += char;
        this.index++;
        continue;
      }
      this.index++;
      const escape = this.text[this.index];
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
        this.index++;
        continue;
      }
      if (escape !== 'u') {
        if (this.index >= this.text.length) this.error('in string escape code');
        fail(`invalid escape sequence \`\\${this.charAt()}\` in string`);
      }
      this.index++;
      let code = 0;
      for (let digit = 0; digit < 4; digit++) {
        if (!/[0-9A-Fa-f]/.test(this.text[this.index] ?? ''))
          this.error(String.raw`in \u hexadecimal character escape`);
        code = code * 16 + Number.parseInt(this.text[this.index], 16);
        this.index++;
      }
      if (code >= 0xd8_00 && code < 0xdc_00 && this.text.startsWith(String.raw`\u`, this.index)) {
        const low = Number.parseInt(this.text.slice(this.index + 2, this.index + 6), 16);
        if (low >= 0xdc_00 && low < 0xe0_00) {
          code = 0x1_00_00 + ((code - 0xd8_00) << 10) + (low - 0xdc_00);
          this.index += 6;
        }
      }
      result += encodeRune(code >= 0xd8_00 && code < 0xe0_00 ? RUNE_ERROR : code);
    }
  }
}

/** The compact form of JSON text, or undefined when it is not valid. */
function compact(text: string): string | undefined {
  try {
    return encodeNode(new Parser(text).parseDocument());
  } catch (error) {
    if (error instanceof JsonFailure) return undefined;
    throw error;
  }
}

function encodeNode(node: JsonNode): string {
  switch (node.kind) {
    case 'object': {
      return `{${node.entries.map(([key, value]) => `${encodeString(key)}:${encodeNode(value)}`).join(',')}}`;
    }
    case 'array': {
      return `[${node.items.map(encodeNode).join(',')}]`;
    }
    case 'string': {
      return encodeString(node.value);
    }
    case 'number': {
      return node.text;
    }
    case 'bool': {
      return String(node.value);
    }
    case 'null': {
      return 'null';
    }
  }
}

/** Decodes into Go values, recording the first type mismatch and going on, as encoding/json's decodeState does. */
class Decoder {
  firstError: string | undefined;
  private readonly fieldStack: string[] = [];
  private structName = '';

  private mismatch(what: string, type: Type): void {
    if (this.firstError !== undefined) return;
    const target = typeString(type);
    this.firstError =
      this.fieldStack.length > 0
        ? `json: cannot unmarshal ${what} into Go struct field ${this.structName}.${this.fieldStack.join('.')} of type ${target}`
        : `json: cannot unmarshal ${what} into Go value of type ${target}`;
  }

  /** The value decoded for the node into a variable of the type that holds `current`. */
  // code-gauge-allow functionCognitiveComplexity 60 -- One case per kind of target, as encoding/json's decoder.
  decode(node: JsonNode, type: Type, current: Value): Value {
    const under = underlying(type);
    if (node.kind === 'null') {
      return ['interface', 'pointer', 'map', 'slice'].includes(under.kind) ? undefined : current;
    }
    if (under.kind === 'pointer') {
      const target = current instanceof Pointer ? current : new Pointer(new Cell(zeroValueOf(under.element)()), 'v');
      target.store(this.decode(node, under.element, target.load()));
      return target;
    }
    if (under.kind === 'interface') {
      if (under.methods.length > 0) {
        this.mismatch(nodeKind(node), type);
        return current;
      }
      return this.generic(node);
    }
    switch (node.kind) {
      case 'bool': {
        if (under.kind === 'basic' && under.basic === 'bool') return node.value;
        this.mismatch('bool', type);
        return current;
      }
      case 'string': {
        if (under.kind === 'basic' && under.basic === 'string') return node.value;
        if (under.kind === 'slice' && isBasicKind(under.element, 'uint8')) {
          const bytes = unbase64(node.value);
          if (bytes === undefined) {
            this.firstError ??= 'illegal base64 data at input byte 0';
            return current;
          }
          return byteSlice(bytes);
        }
        this.mismatch('string', type);
        return current;
      }
      case 'number': {
        return this.number(node.text, type, current);
      }
      case 'array': {
        if (under.kind === 'slice') {
          const items = node.items.map((item, index) => {
            const existing =
              current instanceof Slice && index < current.length ? current.get(index) : zeroValueOf(under.element)();
            return this.decode(item, under.element, existing);
          });
          return new Slice(items, 0, items.length, items.length);
        }
        if (under.kind === 'array') {
          const elements = [...(current as GoArray).elements];
          for (const [index, item] of node.items.entries()) {
            if (index < elements.length) elements[index] = this.decode(item, under.element, elements[index]);
          }
          for (let index = node.items.length; index < elements.length; index++)
            elements[index] = zeroValueOf(under.element)();
          return new GoArray(elements);
        }
        this.mismatch('array', type);
        return current;
      }
      case 'object': {
        if (under.kind === 'map') return this.map(node, type, under, current);
        if (under.kind === 'struct') return this.struct(node, type, current as GoStruct);
        this.mismatch('object', type);
        return current;
      }
    }
  }

  private number(text: string, type: Type, current: Value): Value {
    const under = underlying(type);
    if (under.kind !== 'basic') {
      this.mismatch('number', type);
      return current;
    }
    const kind = under.basic;
    if (kind === 'float64' || kind === 'float32') {
      const value = Number(text);
      if (!Number.isFinite(value) || (kind === 'float32' && !Number.isFinite(Math.fround(value)))) {
        this.mismatch(`number ${text}`, type);
        return current;
      }
      return kind === 'float32' ? Math.fround(value) : value;
    }
    if (/int/.test(kind)) {
      if (!/^-?\d+$/.test(text)) {
        this.mismatch(`number ${text}`, type);
        return current;
      }
      const value = BigInt(text);
      const bits = kind === 'int' || kind === 'uint' || kind === 'uintptr' ? 64 : Number(kind.replace(/^u?int/, ''));
      const unsigned = kind.startsWith('uint');
      const fits = unsigned
        ? value >= 0n && BigInt.asUintN(bits, value) === value
        : BigInt.asIntN(bits, value) === value;
      if (!fits) {
        this.mismatch(`number ${text}`, type);
        return current;
      }
      return value;
    }
    this.mismatch('number', type);
    return current;
  }

  private map(
    node: Extract<JsonNode, { kind: 'object' }>,
    type: Type,
    under: Extract<Type, { kind: 'map' }>,
    current: Value
  ): Value {
    const keyUnder = underlying(under.key);
    if (keyUnder.kind !== 'basic' || !(keyUnder.basic === 'string' || /int/.test(keyUnder.basic))) {
      this.mismatch('object', type);
      return current;
    }
    const map = current instanceof GoMap ? current : new GoMap(mapKeyOf(under.key));
    for (const [keyText, valueNode] of node.entries) {
      let key: Value = keyText;
      if (keyUnder.basic !== 'string') {
        if (!/^-?\d+$/.test(keyText)) {
          this.mismatch(`number ${keyText}`, under.key);
          continue;
        }
        key = BigInt(keyText);
      }
      const existing = map.entries.get(map.keyOf(key));
      this.fieldStack.push(keyText);
      let decoded: Value;
      try {
        decoded = this.decode(valueNode, under.value, existing ? existing.value : zeroValueOf(under.value)());
      } finally {
        this.fieldStack.pop();
      }
      map.entries.set(map.keyOf(key), { key, value: decoded });
    }
    return map;
  }

  private struct(node: Extract<JsonNode, { kind: 'object' }>, type: Type, current: GoStruct): Value {
    const struct = new GoStruct([...current.fields], current.native);
    const fields = jsonFields(type);
    const outerName = this.structName;
    if (this.fieldStack.length === 0) this.structName = type.kind === 'named' ? type.name : '';
    for (const [key, valueNode] of node.entries) {
      const field =
        fields.find((candidate) => candidate.name === key) ??
        fields.find((candidate) => candidate.name.toLowerCase() === key.toLowerCase());
      if (!field) continue;
      this.fieldStack.push(field.name);
      try {
        let container: GoStruct = struct;
        for (const index of field.path.slice(0, -1)) {
          let inner = container.fields[index];
          if (inner === undefined) {
            const embedded = underlying(this.fieldType(container, index, type));
            inner = new Pointer(new Cell(zeroValueOf((embedded as { element: Type }).element)()), 'v');
            container.fields[index] = inner;
          }
          container = (inner instanceof Pointer ? inner.load() : inner) as GoStruct;
        }
        const last = field.path.at(-1) as number;
        const decodedNode =
          field.quoted && valueNode.kind === 'string' ? new Parser(valueNode.value).parseDocument() : valueNode;
        container.fields[last] = this.decode(decodedNode, field.type, container.fields[last]);
      } finally {
        this.fieldStack.pop();
      }
    }
    this.structName = outerName;
    return struct;
  }

  private fieldType(container: GoStruct, index: number, type: Type): Type {
    void container;
    return (underlying(type) as { fields: { type: Type }[] }).fields[index].type;
  }

  /** A value of any decoded as Go does: maps of any, slices of any, float64, string, bool, or nil. */
  generic(node: JsonNode): Value {
    switch (node.kind) {
      case 'object': {
        const map = new GoMap(mapKeyOf(BASIC.string));
        for (const [key, value] of node.entries) map.entries.set(map.keyOf(key), { key, value: this.generic(value) });
        return new Iface(MAP_OF_ANY, map);
      }
      case 'array': {
        const items = node.items.map((item) => this.generic(item));
        return new Iface(SLICE_OF_ANY, new Slice(items, 0, items.length, items.length));
      }
      case 'string': {
        return new Iface(BASIC.string, node.value);
      }
      case 'number': {
        return new Iface(BASIC.float64, Number(node.text));
      }
      case 'bool': {
        return new Iface(BASIC.bool, node.value);
      }
      case 'null': {
        return undefined;
      }
    }
  }
}

const MAP_OF_ANY: Type = { kind: 'map', key: BASIC.string, value: ANY };
const SLICE_OF_ANY: Type = sliceOf(ANY);

function nodeKind(node: JsonNode): string {
  return node.kind === 'bool' ? 'bool' : node.kind;
}

function unmarshal(data: string, target: Value): Value {
  const iface = target as Iface | undefined;
  if (!iface) return newError('json: Unmarshal(nil)');
  if (underlying(iface.type).kind !== 'pointer')
    return newError(`json: Unmarshal(non-pointer ${typeString(iface.type)})`);
  if (iface.value === undefined) return newError(`json: Unmarshal(nil ${typeString(iface.type)})`);
  let node: JsonNode;
  try {
    node = new Parser(data).parseDocument();
  } catch (error) {
    if (error instanceof JsonFailure) return newError(error.message);
    throw error;
  }
  const pointer = iface.value as Pointer;
  const element = (underlying(iface.type) as { element: Type }).element;
  const decoder = new Decoder();
  pointer.store(decoder.decode(node, element, pointer.load()));
  return decoder.firstError === undefined ? undefined : newError(decoder.firstError);
}

function marshal(value: Value): [Value, Value] {
  try {
    const iface = value as Iface | undefined;
    const text = iface ? encode(iface.value, iface.type, new Set()) : 'null';
    return [byteSlice(text), undefined];
  } catch (error) {
    if (error instanceof JsonFailure) return [undefined, newError(error.message)];
    throw error;
  }
}

const members: Record<string, Entity> = {
  Marshal: nativeFunction('Marshal', fn([ANY], [BYTES, ERROR_TYPE]), ([value]) => marshal(value)),
  MarshalIndent: nativeFunction(
    'MarshalIndent',
    fn([ANY, STRING, STRING], [BYTES, ERROR_TYPE]),
    ([value, prefix, indentText]) => {
      const [bytes, error] = marshal(value);
      if (error !== undefined) return [undefined, error];
      return [byteSlice(indent(bytesOf(bytes), prefix as string, indentText as string)), undefined];
    }
  ),
  Unmarshal: nativeFunction('Unmarshal', fn([BYTES, ANY], [ERROR_TYPE]), ([data, target]) =>
    unmarshal(bytesOf(data), target)
  ),
  Valid: nativeFunction('Valid', fn([BYTES], [BOOL]), ([data]) => compact(bytesOf(data)) !== undefined),
};

export const JSON_PACKAGE = definePackage('encoding/json', members, [
  'NewEncoder',
  'NewDecoder',
  'Encoder',
  'Decoder',
  'Indent',
  'Compact',
  'HTMLEscape',
  'RawMessage',
  'Number',
  'Marshaler',
  'Unmarshaler',
  'MarshalerError',
  'SyntaxError',
  'UnmarshalTypeError',
  'InvalidUnmarshalError',
  'UnsupportedTypeError',
  'UnsupportedValueError',
  'Delim',
  'Token',
]);
