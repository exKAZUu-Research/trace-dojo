// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import { formatFloat } from '../floatFormat';
import { decodeRune, RUNE_ERROR } from '../literals';
import { ERROR_TYPE, isExported, missingMethod, type Type, typeString, underlying } from '../types';
import { type GoArray, type GoMap, type GoStruct, Iface, type Pointer, type Slice, type Value } from '../values';
import { BYTES, bytesOf, callMethod, errorText, spendFor } from './support';

/**
 * The parts of encoding/json's Marshal (Go 1.27.3, encode.go) that slog's JSONHandler uses for values of kind Any,
 * with HTML escaping off. Struct tags do not exist in this environment, so fields go by their names.
 */
export class JsonError extends Error {}

const MARSHALER = {
  kind: 'interface' as const,
  methods: [
    { name: 'MarshalJSON', type: { kind: 'func' as const, params: [], results: [BYTES, ERROR_TYPE], variadic: false } },
  ],
};
const TEXT_MARSHALER = {
  kind: 'interface' as const,
  methods: [
    { name: 'MarshalText', type: { kind: 'func' as const, params: [], results: [BYTES, ERROR_TYPE], variadic: false } },
  ],
};

const MAX_DEPTH = 1000;

/** Whether `type` provides MarshalJSON, as json.Marshaler. */
export function isJsonMarshaler(type: Type): boolean {
  return missingMethod(type, MARSHALER) === undefined;
}

/** `json.Marshal(value)` of an interface value, throwing JsonError with Go's message when Go returns an error. */
export function marshalJson(value: Value): string {
  return encode(value as Iface | undefined, 0);
}

function encode(iface: Iface | undefined, depth: number): string {
  if (iface === undefined) return 'null';
  return encodeTyped(iface.type, iface.value, depth);
}

// code-gauge-allow functionCognitiveComplexity 30 -- One case per kind, as encoding/json's newTypeEncoder chooses.
// code-gauge-allow functionNcss 31 -- Same.
function encodeTyped(type: Type, value: Value, depth: number): string {
  if (depth > MAX_DEPTH) throw new JsonError(`json: unsupported value: encountered a cycle via ${typeString(type)}`);
  spendFor(1);
  const under = underlying(type);
  if (under.kind !== 'pointer' || value !== undefined) {
    if (isJsonMarshaler(type)) return callMarshalJson(type, value);
    if (missingMethod(type, TEXT_MARSHALER) === undefined) return quoteJson(callMarshalText(type, value));
  }
  switch (under.kind) {
    case 'basic': {
      return encodeBasic(under.basic, value, type);
    }
    case 'pointer': {
      return value === undefined ? 'null' : encodeTyped(under.element, (value as Pointer).load(), depth + 1);
    }
    case 'interface': {
      return encode(value as Iface | undefined, depth + 1);
    }
    case 'slice': {
      if (value === undefined) return 'null';
      if (isByte(under.element)) return `"${base64(bytesOf(value))}"`;
      return encodeList(under.element, (value as Slice).values(), depth);
    }
    case 'array': {
      return encodeList(under.element, (value as GoArray).elements, depth);
    }
    case 'map': {
      return value === undefined ? 'null' : encodeMap(type, under.key, under.value, value as GoMap, depth);
    }
    case 'struct': {
      return encodeStruct(type, value as GoStruct, depth);
    }
    default: {
      throw new JsonError(`json: unsupported type: ${typeString(type)}`);
    }
  }
}

function encodeBasic(kind: string, value: Value, type: Type): string {
  if (kind === 'bool') return value ? 'true' : 'false';
  if (kind === 'string') return quoteJson(value as string);
  if (kind === 'float64' || kind === 'float32') return encodeFloat(value as number, kind === 'float32' ? 32 : 64);
  if (typeof value === 'bigint') return value.toString();
  throw new JsonError(`json: unsupported type: ${typeString(type)}`);
}

function isByte(type: Type): boolean {
  const under = underlying(type);
  return under.kind === 'basic' && under.basic === 'uint8';
}

/** encoding/json's floatEncoder. */
export function encodeFloat(f: number, bits: 32 | 64): string {
  if (!Number.isFinite(f)) {
    throw new JsonError(`json: unsupported value: ${Number.isNaN(f) ? 'NaN' : f > 0 ? '+Inf' : '-Inf'}`);
  }
  const abs = Math.abs(f);
  const tiny = bits === 64 ? abs < 1e-6 : Math.fround(abs) < Math.fround(1e-6);
  const huge = bits === 64 ? abs >= 1e21 : Math.fround(abs) >= Math.fround(1e21);
  let text = formatFloat(f, abs !== 0 && (tiny || huge) ? 'e' : 'f', -1, bits);
  const n = text.length;
  if (n >= 4 && text[n - 4] === 'e' && text[n - 3] === '-' && text[n - 2] === '0')
    text = text.slice(0, n - 2) + text[n - 1];
  return text;
}

function encodeList(element: Type, values: Value[], depth: number): string {
  return `[${values.map((item) => encodeTyped(element, item, depth + 1)).join(',')}]`;
}

function encodeMap(mapType: Type, keyType: Type, valueType: Type, map: GoMap, depth: number): string {
  const entries: [string, string][] = [];
  for (const { key, value } of map.entries.values()) {
    entries.push([mapKey(mapType, keyType, key), encodeTyped(valueType, value, depth + 1)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, value]) => `${quoteJson(key)}:${value}`).join(',')}}`;
}

function mapKey(mapType: Type, keyType: Type, key: Value): string {
  const under = underlying(keyType);
  if (under.kind === 'basic' && under.basic === 'string') return key as string;
  if (missingMethod(keyType, TEXT_MARSHALER) === undefined) return callMarshalText(keyType, key);
  if (under.kind === 'basic' && typeof key === 'bigint') return key.toString();
  throw new JsonError(`json: unsupported type: ${typeString(mapType)}`);
}

interface FieldValue {
  name: string;
  depth: number;
  type: Type;
  value: Value;
}

/** The fields a struct encodes, with embedded structs' fields promoted and the shallowest of each name winning. */
function structFields(type: Type, struct: GoStruct, depth: number, out: FieldValue[]): void {
  const under = underlying(type);
  if (under.kind !== 'struct') return;
  for (const [index, field] of under.fields.entries()) {
    const value = struct.fields[index];
    if (field.embedded && embeddedFields(field.type, value, depth, out)) continue;
    if (isExported(field.name)) out.push({ name: field.name, depth, type: field.type, value });
  }
}

/** Adds the fields of an embedded struct or non-nil pointer to one, telling whether the field is such an embedding. */
function embeddedFields(type: Type, value: Value, depth: number, out: FieldValue[]): boolean {
  const under = underlying(type);
  const target = under.kind === 'pointer' ? under.element : type;
  if (underlying(target).kind !== 'struct') return false;
  if (under.kind !== 'pointer') structFields(target, value as GoStruct, depth + 1, out);
  else if (value !== undefined) structFields(target, (value as Pointer).load() as GoStruct, depth + 1, out);
  return true;
}

function encodeStruct(type: Type, struct: GoStruct, depth: number): string {
  const fields: FieldValue[] = [];
  structFields(type, struct, 0, fields);
  const parts: string[] = [];
  for (const field of fields) {
    const rivals = fields.filter((other) => other.name === field.name);
    const shallowest = Math.min(...rivals.map((other) => other.depth));
    if (field.depth !== shallowest || rivals.filter((other) => other.depth === shallowest).length > 1) continue;
    parts.push(`${quoteJson(field.name)}:${encodeTyped(field.type, field.value, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

function callMarshalJson(type: Type, value: Value): string {
  return compact(callMarshaler(type, value, 'MarshalJSON'));
}

function callMarshalText(type: Type, value: Value): string {
  return callMarshaler(type, value, 'MarshalText');
}

function callMarshaler(type: Type, value: Value, name: string): string {
  const [bytes, error] = callMethod(new Iface(type, value), name) as [Value, Value];
  if (error !== undefined) {
    throw new JsonError(`json: error calling ${name} for type ${typeString(type)}: ${errorText(error)}`);
  }
  return bytesOf(bytes);
}

/** Removes the insignificant white space of a Marshaler's output, as encoding/json compacts it. */
function compact(text: string): string {
  let result = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      result += char;
      if (char === '\\') result += text[++index] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      result += char;
    } else if (!' \t\n\r'.includes(char)) {
      result += char;
    }
  }
  return result;
}

const HEX = '0123456789abcdef';
/** U+FFFD as UTF-8 bytes. */
export const REPLACEMENT_CHARACTER = String.fromCharCode(0xef, 0xbf, 0xbd);

/** encoding/json's appendString without HTML escaping: invalid UTF-8 becomes U+FFFD. */
export function quoteJson(s: string): string {
  let result = '"';
  for (let at = 0; at < s.length;) {
    const byte = s.charCodeAt(at);
    if (byte < 0x80) {
      at++;
      result += byte >= 0x20 && byte !== 0x22 && byte !== 0x5c ? s[at - 1] : escapeAscii(byte);
      continue;
    }
    const { rune, size } = decodeRune(s, at);
    if (rune === RUNE_ERROR && size === 1) result += REPLACEMENT_CHARACTER;
    else if (rune === 0x20_28 || rune === 0x20_29) result += `\\u202${HEX[rune & 0xf]}`;
    else result += s.slice(at, at + size);
    at += size;
  }
  return `${result}"`;
}

function escapeAscii(byte: number): string {
  switch (byte) {
    case 0x22: {
      return String.raw`\"`;
    }
    case 0x5c: {
      return String.raw`\\`;
    }
    case 0x08: {
      return String.raw`\b`;
    }
    case 0x0c: {
      return String.raw`\f`;
    }
    case 0x0a: {
      return String.raw`\n`;
    }
    case 0x0d: {
      return String.raw`\r`;
    }
    case 0x09: {
      return String.raw`\t`;
    }
    default: {
      return `\\u00${HEX[byte >> 4]}${HEX[byte & 0xf]}`;
    }
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(bytes: string): string {
  spendFor(bytes.length);
  let result = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes.charCodeAt(at);
    const b = at + 1 < bytes.length ? bytes.charCodeAt(at + 1) : 0;
    const c = at + 2 < bytes.length ? bytes.charCodeAt(at + 2) : 0;
    result += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)];
    result += at + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=';
    result += at + 2 < bytes.length ? BASE64[c & 63] : '=';
  }
  return result;
}
