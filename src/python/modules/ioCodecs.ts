import type { PyBytes } from '../bytesValues';
import { newBytes } from '../bytesValues';
import { codecModuleOf, decodeBytes, encodeString } from '../codecs';
import { builtin } from '../define';
import { currentRuntime } from '../runtimeContext';
import { newTuple } from '../types';
import { PyError, type PyValue } from '../values';

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
  const module = codecModuleOf(encoding);
  if (module === 'utf_8' || module === 'utf_8_sig') {
    let start = 0;
    if (module === 'utf_8_sig' && state === 0) {
      if (!final && data.length < 3 && [0xef, 0xbb, 0xbf].slice(0, data.length).every((byte, i) => data[i] === byte)) {
        return ['', 0, 0];
      }
      if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) start = 3;
    }
    const end = final ? data.length : data.length - incompleteUtf8Tail(data);
    return [decodeBytes(data.subarray(start, end), 'utf8', errors), end, 1];
  }
  const unit = module === 'utf_16' || module === 'utf_16_le' || module === 'utf_16_be' ? 2 : 4;
  if (unit === 2 || module === 'utf_32' || module === 'utf_32_le' || module === 'utf_32_be') {
    return decodeUnits(module ?? '', errors, data, final, state, unit);
  }
  return [...decodeOthers(encoding, errors, data, final), state];
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
    const bom =
      unit === 2
        ? [
            [0xff, 0xfe],
            [0xfe, 0xff],
          ]
        : [
            [0xff, 0xfe, 0, 0],
            [0, 0, 0xfe, 0xff],
          ];
    const found = bom.findIndex((mark) => mark.every((byte, index) => data[index] === byte));
    order = found === 1 ? 2 : 1;
    if (found !== -1) start = unit;
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
