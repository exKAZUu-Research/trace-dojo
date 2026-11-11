// `_codecs.escape_decode`, which the pickles of Python 2 strings need.
import { bytesLikeData, newBytes } from '../bytesValues';
import { newTuple, typeError, typeName, valueError } from '../types';
import type { PyValue } from '../values';
import { clinicFunction } from './clinicArgs';

const SIMPLE_ESCAPES: Record<string, number> = {
  '\\': 0x5c,
  "'": 0x27,
  '"': 0x22,
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
};

/** `_codecs.escape_decode`: the bytes a bytes literal's escapes stand for, as pickles of Python 2 strings hold them. */
function escapeDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < data.length) {
    const byte = data[index++];
    if (byte !== 0x5c) {
      out.push(byte);
      continue;
    }
    if (index >= data.length) throw valueError(String.raw`Trailing \ in string`);
    const char = String.fromCodePoint(data[index++]);
    if (char in SIMPLE_ESCAPES) out.push(SIMPLE_ESCAPES[char]);
    else if (char === '\n') continue;
    else if (/[0-7]/.test(char)) index = octalEscape(data, index, char, out);
    else if (char === 'x') index = hexEscape(data, index, out);
    else out.push(0x5c, char.codePointAt(0) as number);
  }
  return Uint8Array.from(out);
}

function octalEscape(data: Uint8Array, start: number, first: string, out: number[]): number {
  let value = Number(first);
  let index = start;
  for (let count = 1; count < 3 && index < data.length && /[0-7]/.test(String.fromCodePoint(data[index])); count++) {
    value = value * 8 + Number(String.fromCodePoint(data[index++]));
  }
  out.push(value & 0xff);
  return index;
}

function hexEscape(data: Uint8Array, start: number, out: number[]): number {
  const text = String.fromCodePoint(...data.subarray(start, start + 2));
  if (!/^[\da-f]{2}$/i.test(text)) throw valueError(`invalid \\x escape at position ${start - 2}`);
  out.push(Number.parseInt(text, 16));
  return start + 2;
}

export const escapeDecodeFunction = clinicFunction(
  { name: 'escape_decode', params: ['data', 'errors'], positionalOnly: 2, required: 1 },
  ([data]) => {
    const bytes = bytesLikeData(data as PyValue);
    if (bytes === undefined) throw typeError(`a bytes-like object is required, not '${typeName(data as PyValue)}'`);
    return newTuple([newBytes(escapeDecode(bytes)), BigInt(bytes.length)]);
  }
);
