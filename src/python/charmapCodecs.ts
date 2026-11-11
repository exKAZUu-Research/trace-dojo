// CPython's charmap codecs, which map each byte to a character through a table, such as cp1252 and koi8_r, and the
// `_codecs` functions that encode and decode through any mapping: charmap_encode, charmap_decode, and charmap_build.
import { bytesLikeData, newBytes, PyBytes } from './bytesValues';
import { decodeBytes, decodeWithSteps, encodeString, ErrorHandling, registerCodec, type TextCodec } from './codecs';
import { CHARMAP_TABLES } from './data/charmapCodecs';
import { builtin, method } from './define';
import { getItem } from './objects';
import { currentRuntime } from './runtimeContext';
import { builtinClass, newDict, newTuple, None, typeError, typeName } from './types';
import { PyOpaque, type PyValue } from './values';

const REASON = 'character maps to <undefined>';
const UNDEFINED = 0xff_fe;
const UNDEFINED_CHAR = String.fromCodePoint(UNDEFINED);
/** The handlers CPython's charmap encoder applies without creating an exception. */
const INLINE_HANDLERS = { encode: new Set(['ignore', 'replace', 'xmlcharrefreplace']), decode: new Set<string>() };

/** The characters the bytes decode to, as code points, U+FFFE for a byte that decodes to nothing. */
function decodingTable(module: string): number[] {
  const text = CHARMAP_TABLES[module];
  // oxlint-disable-next-line typescript/no-misused-spread -- The tables hold one character per byte.
  const upper = [...text].map((char) => char.codePointAt(0) as number);
  return upper.length === 256 ? upper : [...Array.from({ length: 128 }, (_, byte) => byte), ...upper];
}

/** The byte each character encodes to: the last that decodes to it, as codecs.charmap_build maps them. */
function encodingTable(table: readonly number[]): Map<number, number> {
  const encode = new Map<number, number>();
  for (const [byte, point] of table.entries()) if (point !== UNDEFINED) encode.set(point, byte);
  return encode;
}

for (const module of Object.keys(CHARMAP_TABLES)) {
  registerCodec(module, (): TextCodec => {
    const table = decodingTable(module);
    const encode = encodingTable(table);
    return {
      name: 'charmap',
      inlineHandlers: INLINE_HANDLERS,
      encode: (points, errors) =>
        encodeCharmap(points, errors, (point) => {
          const byte = encode.get(point);
          return byte === undefined ? undefined : [byte];
        }),
      decode: (data, errors) =>
        decodeCharmap(data, errors, (byte) =>
          table[byte] === UNDEFINED ? undefined : String.fromCodePoint(table[byte])
        ),
    };
  });
}

/** The table of a charmap codec module, which its encodings module gives as `decoding_table`. */
export function charmapTable(module: string): string {
  return String.fromCodePoint(...decodingTable(module));
}

/**
 * Encodes code points through `lookup`, which gives a character's bytes or undefined. As CPython's charmap encoder,
 * it gives each run of unencodable characters to the error handler at once and encodes the replacement through the
 * mapping, failing for the whole run when the mapping cannot encode it either.
 */
// code-gauge-allow functionCognitiveComplexity 16 -- Follows charmap_encoding_error, which encodes each replacement through the mapping.
function encodeCharmap(
  points: readonly number[],
  errors: ErrorHandling,
  lookup: (point: number) => readonly number[] | undefined
): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < points.length) {
    const bytes = lookup(points[index]);
    if (bytes) {
      out.push(...bytes);
      index++;
      continue;
    }
    let end = index + 1;
    while (end < points.length && lookup(points[end]) === undefined) end++;
    const replacement = errors.encodeError(index, end, REASON);
    if ('bytes' in replacement) out.push(...replacement.bytes);
    else {
      for (const char of replacement.text) {
        const replaced = lookup(char.codePointAt(0) as number);
        if (!replaced) throw errors.encodeException(index, end, REASON);
        out.push(...replaced);
      }
    }
    index = end;
  }
  return Uint8Array.from(out);
}

/** Decodes bytes through `lookup`, which gives a byte's text or undefined, one byte to each error. */
function decodeCharmap(data: Uint8Array, errors: ErrorHandling, lookup: (byte: number) => string | undefined): string {
  return decodeWithSteps(data, errors, (bytes, index) => {
    const text = lookup(bytes[index]);
    return text === undefined ? { reason: REASON, end: index + 1 } : { text, length: 1 };
  });
}

// The _codecs functions ---------------------------------------------------------------------------------------------

/** `_codecs.EncodingMap`, the encoding table codecs.charmap_build makes from a decoding table. */
const encodingMapClass = builtinClass('EncodingMap');

interface EncodingMap {
  bytes: Map<number, number>;
  /** The blocks of the three-level table CPython keeps, which `size()` counts. */
  blocks: { middle: number; inner: number };
}

method(encodingMapClass, 'size', 'none', 0, 0, (self) => {
  const { middle, inner } = ((self as PyOpaque).data as EncodingMap).blocks;
  // The size in bytes of CPython's struct encoding_map, with its middle blocks of 16 bytes and inner ones of 128.
  return BigInt(63 + 16 * middle + 128 * inner);
});

/** `charmap_build(decoding_table)`: an EncodingMap, or a dict when the table does not fit one. */
function charmapBuild(table: PyValue): PyValue {
  if (typeof table !== 'string' || table === '') throw typeError('bad argument type for built-in operation');
  // oxlint-disable-next-line typescript/no-misused-spread -- A decoding table holds one character per byte.
  const points = [...table].map((char) => char.codePointAt(0) as number);
  if (points[0] !== 0 || points.some((point) => point > 0xff_ff)) {
    return newDict(points.map((point, byte) => [BigInt(point), BigInt(byte)]));
  }
  const bytes = new Map<number, number>();
  for (const [byte, point] of points.entries()) if (point !== UNDEFINED) bytes.set(point, byte & 0xff);
  const middle = new Set([...bytes.keys()].map((point) => point >> 11)).size;
  const inner = new Set([...bytes.keys()].map((point) => point >> 7)).size;
  if (middle > 0xff || inner > 0xff) return newDict(points.map((point, byte) => [BigInt(point), BigInt(byte)]));
  return new PyOpaque(encodingMapClass, '', { bytes, blocks: { middle, inner } });
}

/** The bytes a mapping gives a character: an EncodingMap's byte, or what `mapping[ord(char)]` gives. */
// code-gauge-allow functionCognitiveComplexity 16 -- One case per kind of value a mapping may give, as charmapencode_lookup checks them.
function encodingLookup(mapping: PyValue): (point: number) => readonly number[] | undefined {
  if (mapping instanceof PyOpaque && mapping.cls === encodingMapClass) {
    const { bytes } = mapping.data as EncodingMap;
    return (point) => {
      const byte = bytes.get(point);
      return byte === undefined ? undefined : [byte];
    };
  }
  return (point) => {
    const value = mappedValue(mapping, point);
    if (value === undefined || value === None) return;
    if (typeof value === 'bigint') {
      if (value < 0n || value > 255n) throw typeError('character mapping must be in range(256)');
      return [Number(value)];
    }
    if (value instanceof PyBytes) return [...value.data];
    throw typeError(`character mapping must return integer, bytes or None, not ${typeName(value)}`);
  };
}

/** The text a mapping gives a byte: the character of a table string, or what `mapping[byte]` gives. */
// code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of value a mapping may give, as charmap_decode_mapping checks them.
function decodingLookup(mapping: PyValue): (byte: number) => string | undefined {
  if (typeof mapping === 'string') {
    // oxlint-disable-next-line typescript/no-misused-spread -- A decoding table holds one character per byte.
    const chars = [...mapping];
    return (byte) => (byte < chars.length && chars[byte] !== UNDEFINED_CHAR ? chars[byte] : undefined);
  }
  return (byte) => {
    const value = mappedValue(mapping, byte);
    if (value === undefined || value === None) return;
    if (typeof value === 'bigint') {
      if (value < 0n || value > 0x10_ff_ffn) throw typeError('character mapping must be in range(0x110000)');
      return value === 0xff_fen ? undefined : String.fromCodePoint(Number(value));
    }
    if (typeof value === 'string') return value === UNDEFINED_CHAR ? undefined : value;
    throw typeError('character mapping must return integer, None or str');
  };
}

/** `mapping[key]`, or undefined when the mapping raises LookupError. */
function mappedValue(mapping: PyValue, key: number): PyValue | undefined {
  try {
    return getItem(mapping, BigInt(key));
  } catch (error) {
    if (currentRuntime().isLookupError(error)) return undefined;
    throw error;
  }
}

function errorsName(name: string, errors: PyValue | undefined): string {
  if (errors === undefined || errors === None) return 'strict';
  if (typeof errors !== 'string') throw typeError(`${name}() argument 2 must be str or None, not ${typeName(errors)}`);
  return errors;
}

/** `charmap_encode(str, errors=None, mapping=None)`, which encodes Latin-1 without a mapping. */
function charmapEncode([input, errors, mapping]: PyValue[]): PyValue {
  if (typeof input !== 'string') throw typeError(`charmap_encode() argument 1 must be str, not ${typeName(input)}`);
  const handler = errorsName('charmap_encode', errors);
  // oxlint-disable-next-line typescript/no-misused-spread -- Python encodes strings by code point.
  const points = [...input].map((char) => char.codePointAt(0) as number);
  if (mapping === undefined || mapping === None) {
    return newTuple([newBytes(encodeString(input, 'latin-1', handler)), BigInt(points.length)]);
  }
  const errorHandling = new ErrorHandling(handler, 'charmap', input, INLINE_HANDLERS.encode, points);
  currentRuntime().scan(points.length);
  return newTuple([newBytes(encodeCharmap(points, errorHandling, encodingLookup(mapping))), BigInt(points.length)]);
}

/** `charmap_decode(data, errors=None, mapping=None)`, which decodes Latin-1 without a mapping. */
function charmapDecode([input, errors, mapping]: PyValue[]): PyValue {
  const data = bytesLikeData(input);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(input)}'`);
  const handler = errorsName('charmap_decode', errors);
  if (mapping === undefined || mapping === None) {
    return newTuple([decodeBytes(data, 'latin-1', handler), BigInt(data.length)]);
  }
  currentRuntime().scan(data.length);
  const errorHandling = new ErrorHandling(handler, 'charmap', new Uint8Array(data), INLINE_HANDLERS.decode);
  return newTuple([decodeCharmap(data, errorHandling, decodingLookup(mapping)), BigInt(data.length)]);
}

/** The charmap functions of `_codecs`. */
export function charmapNatives(): [string, PyValue][] {
  return [
    ['charmap_build', builtin('charmap_build', 'one', 1, 1, ([table]) => charmapBuild(table))],
    ['charmap_encode', builtin('charmap_encode', 'expected', 1, 3, charmapEncode)],
    ['charmap_decode', builtin('charmap_decode', 'expected', 1, 3, charmapDecode)],
    ['EncodingMap', encodingMapClass],
  ];
}
