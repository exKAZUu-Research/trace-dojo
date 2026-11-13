// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { Printer } from '../fmt';
import {
  addMethod,
  currentRuntime,
  definePackage,
  fn,
  namedType,
  nativeFunction,
  opaqueType,
  typeEntity,
} from '../native';
import { BASIC, pointerTo, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { bytesWithCapacity, type ByteView, byteView, growBytes, spareView } from './byteView';
import {
  EOF,
  ERR_UNEXPECTED_EOF,
  IO_READER,
  IO_WRITE_CLOSER,
  IO_WRITER,
  libraryVariable,
  makeBytes,
  readInto,
  sameError,
  subslice,
  writeFrom,
} from './io';
import { BYTES, byteSlice, bytesOf, ERROR_TYPE, INT, receiverStruct, spendFor, STRING } from './support';

const HEX_TABLE = '0123456789abcdef';
const ERR_LENGTH = newError('encoding/hex: odd length hex string');

/** `hex.InvalidByteError`, the byte that is not a hexadecimal digit. */
const INVALID_BYTE_ERROR = namedType('encoding/hex', 'InvalidByteError', BASIC.uint8);
addMethod(INVALID_BYTE_ERROR, 'Error', fn([], [STRING]), (receiver) =>
  new Printer().printf('encoding/hex: invalid byte: %#U', [new Iface(BASIC.int32, receiver as bigint)])
);

const invalidByte = (byte: number): Iface => new Iface(INVALID_BYTE_ERROR, BigInt(byte));

function fromHexChar(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return 0xff;
}

/** `hex.Encode`. */
function encode(dst: ByteView, src: ByteView): number {
  spendFor(src.length);
  let j = 0;
  for (let index = 0; index < src.length; index++) {
    const v = src.get(index);
    dst.set(j, HEX_TABLE.charCodeAt(v >> 4));
    dst.set(j + 1, HEX_TABLE.charCodeAt(v & 0x0f));
    j += 2;
  }
  return src.length * 2;
}

/** `hex.Decode`. */
function decode(dst: ByteView, src: ByteView): [number, Value] {
  spendFor(src.length);
  let i = 0;
  let j = 0;
  for (; j < src.length - 1; j += 2) {
    const p = src.get(j);
    const q = src.get(j + 1);
    const a = fromHexChar(p);
    const b = fromHexChar(q);
    if (a > 0x0f) return [i, invalidByte(p)];
    if (b > 0x0f) return [i, invalidByte(q)];
    dst.set(i, (a << 4) | b);
    i++;
  }
  if (src.length % 2 === 1) {
    if (fromHexChar(src.get(j)) > 0x0f) return [i, invalidByte(src.get(j))];
    return [i, ERR_LENGTH];
  }
  return [i, undefined];
}

const lengthOf = (value: Value): number => (value as Slice | undefined)?.length ?? 0;

// Dumper ------------------------------------------------------------------------------------------------------------

/** The state of `*hex.dumper`: the bytes of the current line and the offset of the next byte. */
interface DumperState {
  [key: string]: unknown;
  rightChars: string;
  used: number;
  n: number;
  closed: boolean;
}

const toChar = (byte: number): string => (byte < 32 || byte > 126 ? '.' : String.fromCharCode(byte));
const hexByte = (byte: number): string => HEX_TABLE[byte >> 4] + HEX_TABLE[byte & 0x0f];

/** `dumper.Write`, which hands each piece of the dump to `write` as Go's writes do, stopping at an error. */
function dumpWrite(state: DumperState, data: ByteView, write: (bytes: string) => Value): [number, Value] {
  if (state.closed) return [0, newError('encoding/hex: dumper closed')];
  let n = 0;
  for (let index = 0; index < data.length; index++) {
    currentRuntime().spend();
    let error: Value;
    if (state.used === 0) {
      const offset = state.n >>> 0;
      const line = [24, 16, 8, 0].map((shift) => hexByte((offset >>> shift) & 0xff)).join('');
      error = write(`${line}  `);
      if (error !== undefined) return [n, error];
    }
    const byte = data.get(index);
    const separator = state.used === 7 ? '  ' : state.used === 15 ? '  |' : ' ';
    error = write(hexByte(byte) + separator);
    if (error !== undefined) return [n, error];
    n++;
    state.rightChars += toChar(byte);
    state.used++;
    state.n++;
    if (state.used === 16) {
      error = write(`${state.rightChars}|\n`);
      if (error !== undefined) return [n, error];
      state.used = 0;
      state.rightChars = '';
    }
  }
  return [n, undefined];
}

/** `dumper.Close`, which pads the last line and writes its characters. */
function dumpClose(state: DumperState, write: (bytes: string) => Value): Value {
  if (state.closed) return undefined;
  state.closed = true;
  if (state.used === 0) return undefined;
  while (state.used < 16) {
    const error = write(state.used === 7 ? '    ' : state.used === 15 ? '    |' : '   ');
    if (error !== undefined) return error;
    state.used++;
  }
  return write(`${state.rightChars}|\n`);
}

function newDumperState(): DumperState {
  return { rightChars: '', used: 0, n: 0, closed: false };
}

const DUMPER = opaqueType(namedType('encoding/hex', 'dumper', { kind: 'struct', fields: [] }));

function writerOf(receiver: Value): (bytes: string) => Value {
  const writer = receiverStruct(receiver).native?.writer as Value;
  return (bytes) => writeFrom(writer, byteSlice(bytes))[1];
}

addMethod(
  DUMPER,
  'Write',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [data]) => {
    const [n, error] = dumpWrite(receiverStruct(receiver).native as DumperState, byteView(data), writerOf(receiver));
    return [BigInt(n), error];
  },
  true
);
addMethod(
  DUMPER,
  'Close',
  fn([], [ERROR_TYPE]),
  (receiver) => dumpClose(receiverStruct(receiver).native as DumperState, writerOf(receiver)),
  true
);

// Encoder and decoder -----------------------------------------------------------------------------------------------

const ENCODER = opaqueType(namedType('encoding/hex', 'encoder', { kind: 'struct', fields: [] }));
addMethod(
  ENCODER,
  'Write',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [data]) => {
    const state = receiverStruct(receiver).native as { writer: Value; error: Value; out: Slice };
    const p = byteView(data);
    let at = 0;
    let n = 0;
    while (at < p.length && state.error === undefined) {
      const chunkSize = Math.min(512, p.length - at);
      const encoded = encode(byteView(state.out), p.from(at).prefix(chunkSize));
      let written: number;
      [written, state.error] = writeFrom(state.writer, subslice(state.out, 0, encoded));
      n += Math.floor(written / 2);
      at += chunkSize;
    }
    return [BigInt(n), state.error];
  },
  true
);

/** The state of `*hex.decoder`: the encoded bytes read but not yet decoded, in `in` over its 1024-byte array. */
interface DecoderState {
  [key: string]: unknown;
  reader: Value;
  error: Value;
  in: Slice | undefined;
  arr: Slice;
}

function decoderRead(state: DecoderState, data: Value): [number, Value] {
  if (lengthOf(state.in) < 2 && state.error === undefined) {
    const kept = lengthOf(state.in);
    for (let index = 0; index < kept; index++) state.arr.set(index, (state.in as Slice).get(index));
    const [numRead, error] = readInto(state.reader, subslice(state.arr, kept));
    state.error = error;
    state.in = subslice(state.arr, 0, kept + numRead);
    const length = lengthOf(state.in);
    if (sameError(state.error, EOF) && length % 2 !== 0) {
      const last = Number((state.in as Slice).get(length - 1) as bigint);
      state.error = fromHexChar(last) > 0x0f ? invalidByte(last) : ERR_UNEXPECTED_EOF;
    }
  }
  let p = data;
  const available = Math.floor(lengthOf(state.in) / 2);
  if (lengthOf(p) > available) p = subslice(p, 0, available);
  const [numDec, error] = decode(byteView(p), byteView(subslice(state.in, 0, lengthOf(p) * 2)));
  state.in = subslice(state.in, 2 * numDec);
  if (error !== undefined) {
    state.in = undefined;
    state.error = error;
  }
  if (lengthOf(state.in) < 2) return [numDec, state.error];
  return [numDec, undefined];
}

const DECODER = opaqueType(namedType('encoding/hex', 'decoder', { kind: 'struct', fields: [] }));
addMethod(
  DECODER,
  'Read',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [data]) => {
    const [n, error] = decoderRead(receiverStruct(receiver).native as DecoderState, data);
    return [BigInt(n), error];
  },
  true
);

function streamValue(type: Type, state: Record<string, unknown>): Iface {
  currentRuntime().allocate(1);
  return new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct([], state)), 'v'));
}

// Package -----------------------------------------------------------------------------------------------------------

const members: Record<string, Entity> = {
  InvalidByteError: typeEntity(INVALID_BYTE_ERROR),
  ErrLength: libraryVariable('ErrLength', ERROR_TYPE, ERR_LENGTH),
  EncodedLen: nativeFunction('EncodedLen', fn([INT], [INT]), ([n]) => (n as bigint) * 2n),
  DecodedLen: nativeFunction('DecodedLen', fn([INT], [INT]), ([n]) => (n as bigint) / 2n),
  Encode: nativeFunction('Encode', fn([BYTES, BYTES], [INT]), ([dst, src]) =>
    BigInt(encode(byteView(dst), byteView(src)))
  ),
  Decode: nativeFunction('Decode', fn([BYTES, BYTES], [INT, ERROR_TYPE]), ([dst, src]) => {
    const [n, error] = decode(byteView(dst), byteView(src));
    return [BigInt(n), error];
  }),
  EncodeToString: nativeFunction('EncodeToString', fn([BYTES], [STRING]), ([src]) => {
    const dst = makeBytes(lengthOf(src) * 2);
    encode(byteView(dst), byteView(src));
    return bytesOf(dst);
  }),
  DecodeString: nativeFunction('DecodeString', fn([STRING], [BYTES, ERROR_TYPE]), ([s]) => {
    const text = s as string;
    const capacity = Math.floor(text.length / 2);
    const dst = makeBytes(capacity);
    const [n, error] = decode(byteView(dst), byteView(bytesWithCapacity(text, text.length, text.length)));
    return [new Slice(dst.array, 0, n, capacity), error];
  }),
  AppendEncode: nativeFunction('AppendEncode', fn([BYTES, BYTES], [BYTES]), ([dst, src]) => {
    const n = lengthOf(src) * 2;
    const grown = growBytes(dst, n);
    if (!grown) return grown;
    encode(byteView(spareView(grown, n)), byteView(src));
    return new Slice(grown.array, grown.offset, grown.length + n, grown.capacity);
  }),
  AppendDecode: nativeFunction('AppendDecode', fn([BYTES, BYTES], [BYTES, ERROR_TYPE]), ([dst, src]) => {
    const n = Math.floor(lengthOf(src) / 2);
    const grown = growBytes(dst, n);
    if (!grown) return [grown, decode(byteView(undefined), byteView(src))[1]];
    const [count, error] = decode(byteView(spareView(grown, n)), byteView(src));
    return [new Slice(grown.array, grown.offset, grown.length + count, grown.capacity), error];
  }),
  Dump: nativeFunction('Dump', fn([BYTES], [STRING]), ([data]) => {
    if (lengthOf(data) === 0) return '';
    const state = newDumperState();
    let out = '';
    const write = (bytes: string): Value => {
      currentRuntime().checkStringLength(out.length + bytes.length);
      out += bytes;
      return undefined;
    };
    dumpWrite(state, byteView(data), write);
    dumpClose(state, write);
    return out;
  }),
  Dumper: nativeFunction('Dumper', fn([IO_WRITER], [IO_WRITE_CLOSER]), ([writer]) =>
    streamValue(DUMPER, { ...newDumperState(), writer })
  ),
  NewEncoder: nativeFunction('NewEncoder', fn([IO_WRITER], [IO_WRITER]), ([writer]) =>
    streamValue(ENCODER, { writer, error: undefined, out: makeBytes(1024) })
  ),
  NewDecoder: nativeFunction('NewDecoder', fn([IO_READER], [IO_READER]), ([reader]) =>
    streamValue(DECODER, { reader, error: undefined, in: undefined, arr: makeBytes(1024) })
  ),
};

export const HEX_PACKAGE = definePackage('encoding/hex', members);
