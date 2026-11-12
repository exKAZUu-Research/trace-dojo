// oxlint-disable unicorn/prefer-code-point -- Go strings hold UTF-8 bytes as code units 0–255, which charCodeAt and fromCharCode read and write as they are.
import type { Entity, FuncEntity } from '../entities';
import { newError } from '../errorValues';
import { decodeRune, encodeRune } from '../literals';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { GoPanic } from '../runtime';
import { BASIC, ERROR_TYPE, type FuncType, identical, pointerTo, RUNE, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Pointer, type Slice, type Value } from '../values';
import { EOF } from './io';
import { STRINGS_PACKAGE } from './strings';
import { BOOL, BYTES, byteSlice, bytesOf, INT, sliceOfValues, sliceValues, spendFor, STRING } from './support';

const BYTE_SLICES = sliceOf(BYTES);

/** The parameters of the bytes functions that stay strings, as `cutset` of Trim and `chars` of IndexAny do. */
const STRING_PARAMETERS: Record<string, number> = {
  ContainsAny: 1,
  IndexAny: 1,
  LastIndexAny: 1,
  Trim: 1,
  TrimLeft: 1,
  TrimRight: 1,
};

function toBytesType(type: Type): Type {
  if (identical(type, STRING)) return BYTES;
  if (identical(type, sliceOf(STRING))) return BYTE_SLICES;
  return type;
}

function toBytesValue(value: Value, type: Type): Value {
  if (identical(type, STRING)) return byteSlice(value as string);
  if (identical(type, sliceOf(STRING)))
    return value === undefined ? undefined : sliceOfValues(sliceValues(value).map((item) => byteSlice(item as string)));
  return value;
}

function toStringValue(value: Value, type: Type): Value {
  if (identical(type, STRING)) return bytesOf(value);
  if (identical(type, sliceOf(STRING)))
    return value === undefined ? undefined : sliceOfValues(sliceValues(value).map((item) => bytesOf(item)));
  return value;
}

/** A bytes function that does what the strings function of the same name does, on byte slices. */
function fromStrings(name: string): FuncEntity {
  const original = STRINGS_PACKAGE.members.get(name) as FuncEntity;
  const kept = STRING_PARAMETERS[name];
  const params = original.type.params.map((type, index) => (index === kept ? type : toBytesType(type)));
  const signature: FuncType = { ...original.type, params, results: original.type.results.map(toBytesType) };
  const direct = original.direct as NonNullable<FuncEntity['direct']>;
  return nativeFunction(name, signature, (args) => {
    const converted = args.map((arg, index) =>
      index === kept ? arg : toStringValue(arg, original.type.params[index])
    );
    const result = direct(converted, undefined);
    const { results } = original.type;
    if (results.length === 1) return toBytesValue(result as Value, results[0]);
    return (result as Value[]).map((value, index) => toBytesValue(value, results[index]));
  });
}

const DERIVED = [
  'Contains',
  'ContainsRune',
  'ContainsAny',
  'ContainsFunc',
  'Count',
  'Cut',
  'CutPrefix',
  'CutSuffix',
  'EqualFold',
  'Fields',
  'FieldsFunc',
  'HasPrefix',
  'HasSuffix',
  'Index',
  'IndexByte',
  'IndexRune',
  'IndexAny',
  'IndexFunc',
  'LastIndex',
  'LastIndexByte',
  'LastIndexAny',
  'LastIndexFunc',
  'Join',
  'Map',
  'Repeat',
  'Replace',
  'ReplaceAll',
  'Split',
  'SplitN',
  'SplitAfter',
  'SplitAfterN',
  'ToLower',
  'ToUpper',
  'Title',
  'ToTitle',
  'Trim',
  'TrimLeft',
  'TrimRight',
  'TrimSpace',
  'TrimPrefix',
  'TrimSuffix',
  'TrimFunc',
  'TrimLeftFunc',
  'TrimRightFunc',
  'Compare',
];

// Buffer --------------------------------------------------------------------------------------------------------------

/** `bytes.Buffer`: the bytes written and not yet read, from `offset` on. */
const BUFFER = namedType('bytes', 'Buffer', { kind: 'struct', fields: [] });
const BUFFER_POINTER = pointerTo(BUFFER);

interface BufferState {
  data: string;
  offset: number;
}

function bufferOf(receiver: Value): BufferState {
  if (!(receiver instanceof Pointer)) throw new GoPanic(newError('invalid memory address or nil pointer dereference'));
  const struct = receiver.load() as GoStruct;
  struct.native ??= { buffer: { data: '', offset: 0 } satisfies BufferState };
  return struct.native.buffer as BufferState;
}

const unread = (state: BufferState): string => state.data.slice(state.offset);

function write(receiver: Value, text: string): void {
  const state = bufferOf(receiver);
  // An empty buffer starts over, as Go's Buffer reuses its space.
  if (state.offset >= state.data.length) {
    state.data = '';
    state.offset = 0;
  }
  state.data += text;
  spendFor(text.length);
}

const methods: [string, Type[], Type[], (receiver: Value, args: Value[]) => Value | Value[]][] = [
  [
    'Write',
    [BYTES],
    [INT, ERROR_TYPE],
    (receiver, [bytes]) => {
      const text = bytesOf(bytes);
      write(receiver, text);
      return [BigInt(text.length), undefined];
    },
  ],
  [
    'WriteString',
    [STRING],
    [INT, ERROR_TYPE],
    (receiver, [text]) => {
      write(receiver, text as string);
      return [BigInt((text as string).length), undefined];
    },
  ],
  [
    'WriteByte',
    [BASIC.uint8],
    [ERROR_TYPE],
    (receiver, [byte]) => {
      write(receiver, String.fromCharCode(Number(byte as bigint)));
      return;
    },
  ],
  [
    'WriteRune',
    [RUNE],
    [INT, ERROR_TYPE],
    (receiver, [rune]) => {
      const text = encodeRune(Number(rune as bigint));
      write(receiver, text);
      return [BigInt(text.length), undefined];
    },
  ],
  ['String', [], [STRING], (receiver) => (receiver === undefined ? '<nil>' : unread(bufferOf(receiver)))],
  ['Bytes', [], [BYTES], (receiver) => byteSlice(unread(bufferOf(receiver)))],
  ['Len', [], [INT], (receiver) => BigInt(unread(bufferOf(receiver)).length)],
  ['Cap', [], [INT], (receiver) => BigInt(bufferOf(receiver).data.length)],
  [
    'Reset',
    [],
    [],
    (receiver) => {
      const state = bufferOf(receiver);
      state.data = '';
      state.offset = 0;
      return;
    },
  ],
  [
    'Truncate',
    [INT],
    [],
    (receiver, [count]) => {
      const state = bufferOf(receiver);
      const n = Number(count as bigint);
      if (n < 0 || n > unread(state).length) throw new GoPanic(newError('bytes.Buffer: truncation out of range'));
      state.data = state.data.slice(0, state.offset + n);
      return;
    },
  ],
  ['Grow', [INT], [], () => {}],
  [
    'Read',
    [BYTES],
    [INT, ERROR_TYPE],
    (receiver, [target]) => {
      const state = bufferOf(receiver);
      const slice = target as Slice | undefined;
      const room = slice?.length ?? 0;
      if (state.offset >= state.data.length) {
        state.data = '';
        state.offset = 0;
        return [0n, room === 0 ? undefined : EOF];
      }
      const taken = state.data.slice(state.offset, state.offset + room);
      for (let index = 0; index < taken.length; index++) (slice as Slice).set(index, BigInt(taken.charCodeAt(index)));
      state.offset += taken.length;
      return [BigInt(taken.length), undefined];
    },
  ],
  [
    'Next',
    [INT],
    [BYTES],
    (receiver, [count]) => {
      const state = bufferOf(receiver);
      const taken = state.data.slice(state.offset, state.offset + Math.max(Number(count as bigint), 0));
      state.offset += taken.length;
      return byteSlice(taken);
    },
  ],
  [
    'ReadByte',
    [],
    [BASIC.uint8, ERROR_TYPE],
    (receiver) => {
      const state = bufferOf(receiver);
      if (state.offset >= state.data.length) return [0n, EOF];
      return [BigInt(state.data.charCodeAt(state.offset++)), undefined];
    },
  ],
  [
    'ReadRune',
    [],
    [RUNE, INT, ERROR_TYPE],
    (receiver) => {
      const state = bufferOf(receiver);
      if (state.offset >= state.data.length) return [0n, 0n, EOF];
      const { rune, size } = decodeRune(state.data, state.offset);
      state.offset += size;
      return [BigInt(rune), BigInt(size), undefined];
    },
  ],
  [
    'ReadString',
    [BASIC.uint8],
    [STRING, ERROR_TYPE],
    (receiver, [delimiter]) => readUntil(bufferOf(receiver), Number(delimiter as bigint)),
  ],
  [
    'ReadBytes',
    [BASIC.uint8],
    [BYTES, ERROR_TYPE],
    (receiver, [delimiter]) => {
      const [text, error] = readUntil(bufferOf(receiver), Number(delimiter as bigint));
      return [byteSlice(text), error];
    },
  ],
];
for (const [name, params, results, impl] of methods) addMethod(BUFFER, name, fn(params, results), impl, true);

function readUntil(state: BufferState, delimiter: number): [string, Value] {
  const at = state.data.indexOf(String.fromCharCode(delimiter), state.offset);
  const end = at === -1 ? state.data.length : at + 1;
  const text = state.data.slice(state.offset, end);
  state.offset = end;
  return [text, at === -1 ? EOF : undefined];
}

const newBuffer = (data: string): Pointer =>
  new Pointer(new Cell(new GoStruct([], { buffer: { data, offset: 0 } satisfies BufferState })), 'v');

// Reader --------------------------------------------------------------------------------------------------------------

const READER = namedType('bytes', 'Reader', { kind: 'struct', fields: [] });
const readerOf = (receiver: Value): BufferState =>
  (((receiver as Pointer).load() as GoStruct).native?.buffer ?? { data: '', offset: 0 }) as BufferState;
addMethod(READER, 'Len', fn([], [INT]), (receiver) => BigInt(unread(readerOf(receiver)).length), true);
addMethod(READER, 'Size', fn([], [BASIC.int64]), (receiver) => BigInt(readerOf(receiver).data.length), true);
for (const name of ['Read', 'ReadByte', 'ReadRune']) {
  const method = methods.find((entry) => entry[0] === name) as (typeof methods)[number];
  addMethod(READER, name, fn(method[1], method[2]), method[3], true);
}

const members: Record<string, Entity> = {
  ...Object.fromEntries(DERIVED.map((name) => [name, fromStrings(name)])),
  Buffer: typeEntity(BUFFER),
  Reader: typeEntity(READER),
  MinRead: {
    kind: 'const',
    name: 'MinRead',
    type: BASIC.untypedInt,
    value: { kind: 'int', value: 512n },
    span: { row: 0, column: 0 },
    used: true,
  },
  Equal: nativeFunction('Equal', fn([BYTES, BYTES], [BOOL]), ([a, b]) => bytesOf(a) === bytesOf(b)),
  Clone: nativeFunction('Clone', fn([BYTES], [BYTES]), ([b]) => (b === undefined ? undefined : byteSlice(bytesOf(b)))),
  NewBuffer: nativeFunction('NewBuffer', fn([BYTES], [BUFFER_POINTER]), ([b]) => newBuffer(bytesOf(b))),
  NewBufferString: nativeFunction('NewBufferString', fn([STRING], [BUFFER_POINTER]), ([s]) => newBuffer(s as string)),
  NewReader: nativeFunction(
    'NewReader',
    fn([BYTES], [pointerTo(READER)]),
    ([b]) =>
      new Pointer(new Cell(new GoStruct([], { buffer: { data: bytesOf(b), offset: 0 } satisfies BufferState })), 'v')
  ),
};

export const BYTES_PACKAGE = definePackage('bytes', members);
