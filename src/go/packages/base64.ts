import type { Entity } from '../entities';
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
import type { Runtime } from '../runtime';
import { BASIC, pointerTo, RUNE, type Type } from '../types';
import { Cell, GoArray, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import type { ByteView } from './byteView';
import { bytesWithCapacity, byteView, growBytes, spareView } from './byteView';
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
import { BOOL, BYTES, bytesOf, ERROR_TYPE, INT, receiverStruct, spendFor, STRING, stringPanic } from './support';

const STD_PADDING = 0x3d;
const NO_PADDING = -1;
const INVALID = 0xff;

const ENCODING = namedType('encoding/base64', 'Encoding', {
  kind: 'struct',
  fields: [
    { name: 'encode', type: { kind: 'array', element: BASIC.uint8, length: 64 }, embedded: false },
    { name: 'decodeMap', type: { kind: 'array', element: BASIC.uint8, length: 256 }, embedded: false },
    { name: 'padChar', type: RUNE, embedded: false },
    { name: 'strict', type: BOOL, embedded: false },
  ],
});
const ENCODING_POINTER = pointerTo(ENCODING);

/** `base64.CorruptInputError`, the offset of the first byte that does not decode. */
const CORRUPT_INPUT_ERROR = namedType('encoding/base64', 'CorruptInputError', BASIC.int64);
addMethod(
  CORRUPT_INPUT_ERROR,
  'Error',
  fn([], [STRING]),
  (receiver) => `illegal base64 data at input byte ${receiver as bigint}`
);

function corrupt(offset: number): Iface {
  return new Iface(CORRUPT_INPUT_ERROR, BigInt(offset));
}

/** The fields of an Encoding, read once per call. */
interface Enc {
  encode: number[];
  decodeMap: number[];
  padChar: number;
  strict: boolean;
}

function encOfStruct(struct: GoStruct): Enc {
  const [encode, decodeMap, padChar, strict] = struct.fields;
  return {
    encode: (encode as GoArray).elements.map(Number),
    decodeMap: (decodeMap as GoArray).elements.map(Number),
    padChar: Number(padChar as bigint),
    strict: strict as boolean,
  };
}

function encOf(receiver: Value): Enc {
  return encOfStruct(receiverStruct(receiver));
}

function encodingStruct(enc: Enc): GoStruct {
  return new GoStruct([
    new GoArray(enc.encode.map(BigInt)),
    new GoArray(enc.decodeMap.map(BigInt)),
    BigInt(enc.padChar),
    enc.strict,
  ]);
}

function newEncoding(alphabet: string): GoStruct {
  if (alphabet.length !== 64) stringPanic('encoding alphabet is not 64-bytes long');
  const decodeMap = Array.from({ length: 256 }, () => INVALID);
  const encode: number[] = [];
  for (let index = 0; index < 64; index++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255.
    const symbol = alphabet.charCodeAt(index);
    if (symbol === 0x0a || symbol === 0x0d) stringPanic('encoding alphabet contains newline character');
    if (decodeMap[symbol] !== INVALID) stringPanic('encoding alphabet includes duplicate symbols');
    decodeMap[symbol] = index;
    encode.push(symbol);
  }
  return encodingStruct({ encode, decodeMap, padChar: STD_PADDING, strict: false });
}

function withPadding(struct: GoStruct, padding: number): GoStruct {
  const enc = encOfStruct(struct);
  if (padding < NO_PADDING || padding === 0x0d || padding === 0x0a || padding > 0xff) stringPanic('invalid padding');
  if (padding !== NO_PADDING && enc.decodeMap[padding] !== INVALID) stringPanic('padding contained in alphabet');
  return encodingStruct({ ...enc, padChar: padding });
}

function encodingPointer(struct: GoStruct): Pointer {
  currentRuntime().allocate(1);
  return new Pointer(new Cell(struct), 'v');
}

// Encoding ----------------------------------------------------------------------------------------------------------

function encodedLen(enc: Enc, n: number): number {
  if (enc.padChar === NO_PADDING) return Math.floor(n / 3) * 4 + Math.floor(((n % 3) * 8 + 5) / 6);
  return Math.floor((n + 2) / 3) * 4;
}

function decodedLen(n: number, padChar: number): number {
  if (padChar === NO_PADDING) return Math.floor(n / 4) * 3 + Math.floor(((n % 4) * 6) / 8);
  return Math.floor(n / 4) * 3;
}

/** `Encoding.Encode`. */
function encode(enc: Enc, dstView: ByteView, srcView: ByteView): void {
  let src = srcView;
  let dst = dstView;
  if (src.length === 0) return;
  spendFor(src.length);
  const symbol = (val: number, shift: number): number => enc.encode[(val >>> shift) & 0x3f];
  while (src.length >= 3) {
    const val = (src.get(0) << 16) | (src.get(1) << 8) | src.get(2);
    dst.get(3);
    dst.set(0, symbol(val, 18));
    dst.set(1, symbol(val, 12));
    dst.set(2, symbol(val, 6));
    dst.set(3, symbol(val, 0));
    src = src.from(3);
    dst = dst.from(4);
  }
  if (src.length === 0) return;
  const val = (src.get(0) << 16) | (src.length === 2 ? src.get(1) << 8 : 0);
  dst.set(0, symbol(val, 18));
  dst.set(1, symbol(val, 12));
  if (src.length === 2) dst.set(2, symbol(val, 6));
  else if (enc.padChar !== NO_PADDING) dst.set(2, enc.padChar);
  if (enc.padChar !== NO_PADDING) dst.set(3, enc.padChar);
}

const isNewline = (byte: number): boolean => byte === 0x0a || byte === 0x0d;

/** The symbols of one quantum that decodeQuantum read: their values, their count, and where reading stopped. */
interface Quantum {
  dbuf: number[];
  dlen: number;
  si: number;
  error?: Iface;
  /** An error that ends decoding without writing anything. */
  fatal?: Iface;
}

/** The first half of `Encoding.decodeQuantum`: reads up to 4 symbols at `start`, skipping newlines and padding. */
function readQuantum(enc: Enc, src: ByteView, start: number): Quantum {
  const quantum: Quantum = { dbuf: [0, 0, 0, 0], dlen: 4, si: start };
  for (let j = 0; j < 4; j++) {
    if (src.length === quantum.si) {
      if (j === 0) return { ...quantum, dlen: 0 };
      if (j === 1 || enc.padChar !== NO_PADDING) return { ...quantum, fatal: corrupt(quantum.si - j) };
      quantum.dlen = j;
      return quantum;
    }
    const input = src.get(quantum.si++);
    const out = enc.decodeMap[input];
    if (out !== INVALID) quantum.dbuf[j] = out;
    else if (isNewline(input)) j--;
    else return readPadding(enc, src, quantum, j, input);
  }
  return quantum;
}

/** The padding branch of decodeQuantum: the `=` (or `==`) must end the input but for newlines. */
function readPadding(enc: Enc, src: ByteView, quantum: Quantum, j: number, input: number): Quantum {
  const skipNewlines = (): void => {
    while (quantum.si < src.length && isNewline(src.get(quantum.si))) quantum.si++;
  };
  if (input !== enc.padChar || j < 2) return { ...quantum, fatal: corrupt(quantum.si - 1) };
  if (j === 2) {
    skipNewlines();
    if (quantum.si === src.length) return { ...quantum, fatal: corrupt(src.length) };
    if (src.get(quantum.si) !== enc.padChar) return { ...quantum, fatal: corrupt(quantum.si - 1) };
    quantum.si++;
  }
  skipNewlines();
  return { ...quantum, dlen: j, error: quantum.si < src.length ? corrupt(quantum.si) : undefined };
}

/** `Encoding.decodeQuantum`: decodes up to 4 symbols at `start`, returning the next index, the byte count, and an error. */
function decodeQuantum(enc: Enc, dst: ByteView, src: ByteView, start: number): [number, number, Iface | undefined] {
  const { dbuf, dlen, si, error, fatal } = readQuantum(enc, src, start);
  if (fatal) return [si, 0, fatal];
  if (dlen === 0) return [si, 0, undefined];
  const val = (dbuf[0] << 18) | (dbuf[1] << 12) | (dbuf[2] << 6) | dbuf[3];
  const bytes = [(val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff];
  if (dlen === 4) {
    dst.set(2, bytes[2]);
    bytes[2] = 0;
  }
  if (dlen >= 3) {
    dst.set(1, bytes[1]);
    if (enc.strict && bytes[2] !== 0) return [si, 0, corrupt(si - 1)];
    bytes[1] = 0;
  }
  dst.set(0, bytes[0]);
  if (enc.strict && (bytes[1] !== 0 || bytes[2] !== 0)) return [si, 0, corrupt(si - 2)];
  return [si, dlen - 1, error];
}

/** `Encoding.Decode`, including its 8- and 4-symbol fast paths, which write whole words into dst. */
function decode(enc: Enc, dst: ByteView, src: ByteView): [number, Iface | undefined] {
  if (src.length === 0) return [0, undefined];
  spendFor(src.length);
  let n = 0;
  let si = 0;
  let error: Iface | undefined;
  for (const width of [8, 4]) {
    while (src.length - si >= width && dst.length - n >= width) {
      const symbols = Array.from({ length: width }, (_, index) => enc.decodeMap[src.get(si + index)]);
      if (symbols.every((symbol) => symbol !== INVALID)) {
        let bits = 0n;
        for (const symbol of symbols) bits = (bits << 6n) | BigInt(symbol);
        bits <<= BigInt(width * 8 - width * 6);
        for (let index = 0; index < width; index++) {
          dst.set(n + index, Number((bits >> BigInt((width - 1 - index) * 8)) & 0xffn));
        }
        n += (width / 4) * 3;
        si += width;
      } else {
        let count: number;
        [si, count, error] = decodeQuantum(enc, dst.from(n), src, si);
        n += count;
        if (error) return [n, error];
      }
    }
  }
  while (si < src.length) {
    let count: number;
    [si, count, error] = decodeQuantum(enc, dst.from(n), src, si);
    n += count;
    if (error) return [n, error];
  }
  return [n, error];
}

const encodingMethod = (
  name: string,
  params: Type[],
  results: Type[],
  impl: (enc: Enc, args: Value[]) => Value | Value[]
): void => {
  addMethod(ENCODING, name, fn(params, results), (receiver, args) => impl(encOf(receiver), args), true);
};

encodingMethod('Encode', [BYTES, BYTES], [], (enc, [dst, src]) => {
  encode(enc, byteView(dst), byteView(src));
  return [];
});
encodingMethod('EncodeToString', [BYTES], [STRING], (enc, [src]) => {
  const buffer = makeBytes(encodedLen(enc, (src as Slice | undefined)?.length ?? 0));
  encode(enc, byteView(buffer), byteView(src));
  return bytesOf(buffer);
});
encodingMethod('AppendEncode', [BYTES, BYTES], [BYTES], (enc, [dst, src]) => {
  const n = encodedLen(enc, (src as Slice | undefined)?.length ?? 0);
  const grown = growBytes(dst, n);
  if (!grown) return grown;
  encode(enc, byteView(spareView(grown, n)), byteView(src));
  return new Slice(grown.array, grown.offset, grown.length + n, grown.capacity);
});
encodingMethod('EncodedLen', [INT], [INT], (enc, [n]) => BigInt(encodedLen(enc, Number(n as bigint))));
encodingMethod('DecodedLen', [INT], [INT], (enc, [n]) => BigInt(decodedLen(Number(n as bigint), enc.padChar)));
encodingMethod('Decode', [BYTES, BYTES], [INT, ERROR_TYPE], (enc, [dst, src]) => {
  const [n, error] = decode(enc, byteView(dst), byteView(src));
  return [BigInt(n), error];
});
encodingMethod('DecodeString', [STRING], [BYTES, ERROR_TYPE], (enc, [s]) => {
  const text = s as string;
  const capacity = decodedLen(text.length, enc.padChar);
  const buffer = makeBytes(capacity);
  const [n, error] = decode(enc, byteView(buffer), byteView(bytesWithCapacity(text, text.length, text.length)));
  return [new Slice(buffer.array, 0, n, capacity), error];
});
encodingMethod('AppendDecode', [BYTES, BYTES], [BYTES, ERROR_TYPE], (enc, [dst, src]) => {
  const source = byteView(src);
  let length = source.length;
  while (length > 0 && source.get(length - 1) === enc.padChar) length--;
  const n = decodedLen(length, NO_PADDING);
  const grown = growBytes(dst, n);
  if (!grown) return [grown, decode(enc, byteView(undefined), source)[1]];
  const [count, error] = decode(enc, byteView(spareView(grown, n)), source);
  return [new Slice(grown.array, grown.offset, grown.length + count, grown.capacity), error];
});
addMethod(ENCODING, 'WithPadding', fn([RUNE], [ENCODING_POINTER]), (receiver, [padding]) =>
  encodingPointer(withPadding(receiver as GoStruct, Number(padding as bigint)))
);
addMethod(ENCODING, 'Strict', fn([], [ENCODING_POINTER]), (receiver) =>
  encodingPointer(encodingStruct({ ...encOfStruct(receiver as GoStruct), strict: true }))
);

// Streams -----------------------------------------------------------------------------------------------------------

/** The state of `*base64.encoder`, which buffers up to 2 bytes between writes. */
interface EncoderState {
  [key: string]: unknown;
  error: Value;
  enc: Value;
  writer: Value;
  buf: number[];
  out: Slice;
}

const ENCODER = opaqueType(namedType('encoding/base64', 'encoder', { kind: 'struct', fields: [] }));
const encoderOf = (receiver: Value): EncoderState => receiverStruct(receiver).native as EncoderState;

function encodeChunk(state: EncoderState, src: number[]): number {
  const enc = encOf(state.enc);
  const source = makeBytes(src.length);
  for (const [index, byte] of src.entries()) source.array[index] = BigInt(byte);
  encode(enc, byteView(state.out), byteView(source));
  return encodedLen(enc, src.length);
}

addMethod(
  ENCODER,
  'Write',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [data]) => {
    const state = encoderOf(receiver);
    if (state.error !== undefined) return [0n, state.error];
    const p = byteView(data);
    let at = 0;
    if (state.buf.length > 0) {
      while (at < p.length && state.buf.length < 3) state.buf.push(p.get(at++));
      if (state.buf.length < 3) return [BigInt(at), undefined];
      encodeChunk(state, state.buf);
      [, state.error] = writeFrom(state.writer, subslice(state.out, 0, 4));
      if (state.error !== undefined) return [BigInt(at), state.error];
      state.buf = [];
    }
    while (p.length - at >= 3) {
      currentRuntime().spend();
      let nn = Math.min((1024 / 4) * 3, p.length - at);
      nn -= nn % 3;
      encodeChunk(
        state,
        Array.from({ length: nn }, (_, index) => p.get(at + index))
      );
      [, state.error] = writeFrom(state.writer, subslice(state.out, 0, (nn / 3) * 4));
      if (state.error !== undefined) return [BigInt(at), state.error];
      at += nn;
    }
    while (at < p.length) state.buf.push(p.get(at++));
    return [BigInt(at), undefined];
  },
  true
);
addMethod(
  ENCODER,
  'Close',
  fn([], [ERROR_TYPE]),
  (receiver) => {
    const state = encoderOf(receiver);
    if (state.error === undefined && state.buf.length > 0) {
      const length = encodeChunk(state, state.buf);
      [, state.error] = writeFrom(state.writer, subslice(state.out, 0, length));
      state.buf = [];
    }
    return state.error;
  },
  true
);

/** The state of `*base64.decoder`, which reads whole quanta and keeps decoded bytes that did not fit. */
interface DecoderState {
  [key: string]: unknown;
  error: Value;
  readError: Value;
  enc: Value;
  reader: Value;
  buf: Slice;
  nbuf: number;
  out: Slice | undefined;
  outbuf: Slice;
}

const DECODER = opaqueType(namedType('encoding/base64', 'decoder', { kind: 'struct', fields: [] }));

/** `newlineFilteringReader.Read`: reads from the wrapped reader and drops CR and LF. */
function readWithoutNewlines(reader: Value, buffer: Slice): [number, Value] {
  let [n, error] = readInto(reader, buffer);
  while (n > 0) {
    currentRuntime().spend();
    let offset = 0;
    for (let index = 0; index < n; index++) {
      const byte = buffer.get(index);
      if (byte !== 0x0dn && byte !== 0x0an) buffer.set(offset++, byte);
    }
    if (offset > 0) return [offset, error];
    [n, error] = readInto(reader, buffer);
  }
  return [n, error];
}

function takeOut(state: DecoderState, p: Value): number {
  const target = byteView(p);
  const out = state.out as Slice;
  const n = Math.min(target.length, out.length);
  for (let index = 0; index < n; index++) target.set(index, Number(out.get(index) as bigint));
  state.out = subslice(out, n);
  return n;
}

// code-gauge-allow functionCognitiveComplexity 25 -- transcribes Go's decoder.Read, whose order of checks decides which error a read returns.
// code-gauge-allow functionNcss 45 -- transcribes Go's decoder.Read step by step.
function decoderRead(state: DecoderState, p: Value): [number, Value] {
  const pLength = (p as Slice | undefined)?.length ?? 0;
  if (state.out && state.out.length > 0) return [takeOut(state, p), undefined];
  if (state.error !== undefined) return [0, state.error];
  while (state.nbuf < 4 && state.readError === undefined) {
    currentRuntime().spend();
    const nn = Math.min(Math.max(Math.floor(pLength / 3) * 4, 4), 1024);
    let count: number;
    [count, state.readError] = readWithoutNewlines(state.reader, subslice(state.buf, state.nbuf, nn) as Slice);
    state.nbuf += count;
  }
  const enc = encOf(state.enc);
  if (state.nbuf < 4) {
    if (enc.padChar === NO_PADDING && state.nbuf > 0) {
      const [nw, error] = decode(enc, byteView(state.outbuf), byteView(subslice(state.buf, 0, state.nbuf)));
      state.error = error;
      state.nbuf = 0;
      state.out = subslice(state.outbuf, 0, nw);
      const n = takeOut(state, p);
      if (n > 0 || (pLength === 0 && (state.out as Slice).length > 0)) return [n, undefined];
      if (state.error !== undefined) return [0, state.error];
    }
    state.error = state.readError;
    if (sameError(state.error, EOF) && state.nbuf > 0) state.error = ERR_UNEXPECTED_EOF;
    return [0, state.error];
  }
  const nr = Math.floor(state.nbuf / 4) * 4;
  let nw = Math.floor(state.nbuf / 4) * 3;
  let n: number;
  if (nw > pLength) {
    [nw, state.error] = decode(enc, byteView(state.outbuf), byteView(subslice(state.buf, 0, nr)));
    state.out = subslice(state.outbuf, 0, nw);
    n = takeOut(state, p);
  } else {
    [n, state.error] = decode(enc, byteView(p), byteView(subslice(state.buf, 0, nr)));
  }
  state.nbuf -= nr;
  for (let index = 0; index < state.nbuf; index++) state.buf.set(index, state.buf.get(nr + index));
  return [n, state.error];
}

addMethod(
  DECODER,
  'Read',
  fn([BYTES], [INT, ERROR_TYPE]),
  (receiver, [p]) => {
    const [n, error] = decoderRead(receiverStruct(receiver).native as DecoderState, p);
    return [BigInt(n), error];
  },
  true
);

function streamValue(type: Type, state: EncoderState | DecoderState): Iface {
  return new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct([], state)), 'v'));
}

// Package -----------------------------------------------------------------------------------------------------------

const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** The encodings a run shares as Go's package variables, which a program can modify through the pointers. */
const encodingsOfRuns = new WeakMap<Runtime, Record<string, Pointer>>();

function encodingsOfRun(): Record<string, Pointer> {
  const runtime = currentRuntime();
  let encodings = encodingsOfRuns.get(runtime);
  if (!encodings) {
    const std = newEncoding(`${STANDARD_ALPHABET}+/`);
    const url = newEncoding(`${STANDARD_ALPHABET}-_`);
    encodings = {
      StdEncoding: encodingPointer(std),
      URLEncoding: encodingPointer(url),
      RawStdEncoding: encodingPointer(withPadding(std, NO_PADDING)),
      RawURLEncoding: encodingPointer(withPadding(url, NO_PADDING)),
    };
    encodingsOfRuns.set(runtime, encodings);
  }
  return encodings;
}

function runeConstant(name: string, value: number): Entity {
  return {
    kind: 'const',
    name,
    type: RUNE,
    value: { kind: 'int', value: BigInt(value) },
    span: { row: 0, column: 0 },
    used: true,
  };
}

const members: Record<string, Entity> = {
  Encoding: typeEntity(ENCODING),
  CorruptInputError: typeEntity(CORRUPT_INPUT_ERROR),
  StdPadding: runeConstant('StdPadding', STD_PADDING),
  NoPadding: runeConstant('NoPadding', NO_PADDING),
  ...Object.fromEntries(
    ['StdEncoding', 'URLEncoding', 'RawStdEncoding', 'RawURLEncoding'].map((name) => [
      name,
      libraryVariable(name, ENCODING_POINTER, () => encodingsOfRun()[name]),
    ])
  ),
  NewEncoding: nativeFunction('NewEncoding', fn([STRING], [ENCODING_POINTER]), ([alphabet]) =>
    encodingPointer(newEncoding(alphabet as string))
  ),
  NewEncoder: nativeFunction('NewEncoder', fn([ENCODING_POINTER, IO_WRITER], [IO_WRITE_CLOSER]), ([enc, writer]) =>
    streamValue(ENCODER, { error: undefined, enc, writer, buf: [], out: makeBytes(1024) })
  ),
  NewDecoder: nativeFunction('NewDecoder', fn([ENCODING_POINTER, IO_READER], [IO_READER]), ([enc, reader]) =>
    streamValue(DECODER, {
      error: undefined,
      readError: undefined,
      enc,
      reader,
      buf: makeBytes(1024),
      nbuf: 0,
      out: undefined,
      outbuf: makeBytes((1024 / 4) * 3),
    })
  ),
};

export const BASE64_PACKAGE = definePackage('encoding/base64', members);
