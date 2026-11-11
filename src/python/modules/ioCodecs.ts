import type { PyBytes } from '../bytesValues';
import { newBytes } from '../bytesValues';
import { codecModuleOf, decodeBytes, encodeString } from '../codecs';
import { builtin } from '../define';
import { currentRuntime } from '../runtimeContext';
import { newTuple } from '../types';
import { PyError, type PyValue } from '../values';
import { statefulCodecFunction } from './codecsNative';

// The incremental codecs TextIOWrapper reads and writes through, which decode a chunk of bytes as far as its last
// complete character and keep the rest, with the byte order a UTF-16 or UTF-32 stream's BOM chose as their state.

/** The private helpers of io's TextIOWrapper. */
export function ioCodecNatives(): [string, PyValue][] {
  return [
    [
      '_decode_chunk',
      builtin('_decode_chunk', 'expected', 5, 5, ([encoding, errors, data, final, flag]) => {
        const [text, consumed, state] = decodeChunk(
          encoding as string,
          errors as string,
          (data as PyBytes).data,
          final === true,
          Number(flag)
        );
        return newTuple([text, BigInt(consumed), BigInt(state)]);
      }),
    ],
    [
      '_encode_chunk',
      builtin('_encode_chunk', 'expected', 4, 4, ([encoding, errors, text, started]) =>
        newBytes(encodeChunk(encoding as string, errors as string, text as string, started === true))
      ),
    ],
    [
      '_stateful_codec',
      builtin('_stateful_codec', 'expected', 2, 2, ([encoding, direction]) =>
        statefulCodecFunction(encoding as string, direction as 'encode' | 'decode')
      ),
    ],
    [
      '_codec_name',
      builtin('_codec_name', 'one', 1, 1, ([encoding]) => {
        decodeBytes(new Uint8Array(0), encoding as string, 'strict');
        return encoding;
      }),
    ],
  ];
}

/** The text of the complete characters at the start of `data`, how many bytes they took, and the stream's state. */
function decodeChunk(
  encoding: string,
  errors: string,
  data: Uint8Array,
  final: boolean,
  state: number
): [string, number, number] {
  const module = codecModuleOf(encoding) ?? '';
  if (module === 'utf_8' || module === 'utf_8_sig')
    return decodeUtf8(module === 'utf_8_sig', errors, data, final, state);
  if (module.startsWith('utf_16')) return decodeUnits(module, errors, data, final, state, 2);
  if (module.startsWith('utf_32')) return decodeUnits(module, errors, data, final, state, 4);
  return [...decodeOthers(encoding, errors, data, final), state];
}

/** UTF-8, whose state is 1 once a UTF-8-SIG stream has passed the place of its BOM. */
function decodeUtf8(
  signed: boolean,
  errors: string,
  data: Uint8Array,
  final: boolean,
  state: number
): [string, number, number] {
  const bom = [0xef, 0xbb, 0xbf];
  let start = 0;
  if (signed && state === 0) {
    if (!final && data.length < 3 && data.every((byte, index) => bom[index] === byte)) return ['', 0, 0];
    if (bom.every((byte, index) => data[index] === byte)) start = 3;
  }
  const end = final ? data.length : data.length - incompleteUtf8Tail(data);
  return [decodeBytes(data.subarray(start, end), 'utf8', errors), end, 1];
}

/** How many bytes at the end of UTF-8 data start a character that the data does not finish. */
function incompleteUtf8Tail(data: Uint8Array): number {
  for (let index = data.length - 1; index >= Math.max(0, data.length - 4); index--) {
    const byte = data[index];
    if (byte < 0x80) return 0;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return data.length - index < length ? data.length - index : 0;
  }
  return 0;
}

/** UTF-16 or UTF-32, whose state is 1 for little-endian and 2 for big-endian once a BOM or the first chunk chose. */
// code-gauge-allow functionCognitiveComplexity 21 -- Handles the BOM, the whole code units, and a split surrogate pair of one chunk.
function decodeUnits(
  module: string,
  errors: string,
  data: Uint8Array,
  final: boolean,
  state: number,
  unit: number
): [string, number, number] {
  let start = 0;
  let order = module.endsWith('_le') ? 1 : module.endsWith('_be') ? 2 : state;
  if (order === 0) {
    if (data.length < unit && !final) return ['', 0, 0];
    const found = byteOrderMark(data, unit);
    order = found === 'big' ? 2 : 1;
    if (found !== undefined) start = unit;
  }
  let end = final ? data.length : start + Math.floor((data.length - start) / unit) * unit;
  // A UTF-16 high surrogate waits for the low one that follows it.
  if (unit === 2 && !final && end - start >= 2) {
    const high = order === 1 ? data[end - 1] : data[end - 2];
    if (high >= 0xd8 && high <= 0xdb) end -= 2;
  }
  const name = `${unit === 2 ? 'utf-16' : 'utf-32'}-${order === 1 ? 'le' : 'be'}`;
  return [decodeBytes(data.subarray(start, end), name, errors), end, order];
}

/** The byte order the BOM at the start of UTF-16 or UTF-32 data gives, or undefined without one. */
function byteOrderMark(data: Uint8Array, unit: number): 'little' | 'big' | undefined {
  const little = unit === 2 ? [0xff, 0xfe] : [0xff, 0xfe, 0, 0];
  if (little.every((byte, index) => data[index] === byte)) return 'little';
  return little.toReversed().every((byte, index) => data[index] === byte) ? 'big' : undefined;
}

/** Any other codec: the longest prefix that decodes strictly, or all the data at the end of the stream. */
function decodeOthers(encoding: string, errors: string, data: Uint8Array, final: boolean): [string, number] {
  if (!final) {
    for (let drop = 0; drop <= Math.min(3, data.length); drop++) {
      const prefix = data.subarray(0, data.length - drop);
      try {
        decodeBytes(prefix, encoding, 'strict');
        return [decodeBytes(prefix, encoding, errors), prefix.length];
      } catch (error) {
        if (!(error instanceof PyError) || currentRuntime().isLookupError(error)) throw error;
      }
    }
  }
  return [decodeBytes(data, encoding, errors), data.length];
}

/** Encodes a chunk of text, writing a BOM only at the start of a UTF-16, UTF-32, or UTF-8-SIG stream. */
function encodeChunk(encoding: string, errors: string, text: string, started: boolean): Uint8Array {
  const module = codecModuleOf(encoding);
  if (started && module === 'utf_16') return encodeString(text, 'utf-16-le', errors);
  if (started && module === 'utf_32') return encodeString(text, 'utf-32-le', errors);
  if (started && module === 'utf_8_sig') return encodeString(text, 'utf8', errors);
  return encodeString(text, encoding, errors);
}
