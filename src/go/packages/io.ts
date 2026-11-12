import type { Entity, FuncEntity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import {
  BASIC,
  ERROR_TYPE,
  type FuncType,
  lookupFieldOrMethod,
  type NamedType,
  pointerTo,
  sliceOf,
  type Type,
  typeString,
} from '../types';
import { Cell, GoStruct, Iface, Pointer, Slice, type Value } from '../values';
import { byteSlice, bytesOf, callMethod } from './support';

const BYTE_SLICE = sliceOf(BASIC.uint8);

export const IO_WRITER = namedType('io', 'Writer', {
  kind: 'interface',
  methods: [{ name: 'Write', type: fn([BYTE_SLICE], [BASIC.int, ERROR_TYPE]) }],
});

export const IO_READER = namedType('io', 'Reader', {
  kind: 'interface',
  methods: [{ name: 'Read', type: fn([BYTE_SLICE], [BASIC.int, ERROR_TYPE]) }],
});

/** `io.EOF`, which readers return at the end and programs compare with ==. */
export const EOF = newError('EOF');

/** Reads everything from a reader through its Read method, 512 bytes at a time as io.ReadAll starts. */
function readAll(reader: Value): [string, Value] {
  let data = '';
  for (;;) {
    const buffer = byteSlice('\0'.repeat(512));
    const [count, error] = callMethod(reader, 'Read', [buffer]) as [bigint, Value];
    data += bytesOf(buffer).slice(0, Number(count));
    if (error !== undefined) return [data, error === EOF ? undefined : error];
  }
}

const members: Record<string, Entity> = {
  Reader: typeEntity(IO_READER),
  Writer: typeEntity(IO_WRITER),
  EOF: {
    kind: 'var',
    name: 'EOF',
    type: ERROR_TYPE,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => EOF,
  },
  Copy: nativeFunction('Copy', fn([IO_WRITER, IO_READER], [BASIC.int64, ERROR_TYPE]), ([writer, reader]) => {
    const [data, error] = readAll(reader);
    if (data.length > 0) {
      const [, writeError] = callMethod(writer, 'Write', [byteSlice(data)]) as [bigint, Value];
      if (writeError !== undefined) return [0n, writeError];
    }
    return [BigInt(data.length), error];
  }),
  ReadAll: nativeFunction('ReadAll', fn([IO_READER], [BYTE_SLICE, ERROR_TYPE]), ([reader]) => {
    const [data, error] = readAll(reader);
    return [byteSlice(data) as Slice, error];
  }),
  WriteString: nativeFunction(
    'WriteString',
    fn([IO_WRITER, BASIC.string], [BASIC.int, ERROR_TYPE]),
    ([writer, text]) => callMethod(writer, 'Write', [byteSlice(text as string)]) as Value[]
  ),
};

// Helpers transcribed from Go's io.go and multi.go ----------------------------------------------------------------

export const ERR_UNEXPECTED_EOF = newError('unexpected EOF');
const ERR_SHORT_WRITE = newError('short write');
const ERR_SHORT_BUFFER = newError('short buffer');
const ERR_NO_PROGRESS = newError('multiple Read calls return no data or error');

const subslice = (slice: Slice | undefined, from: number, to = slice?.length ?? 0): Slice | undefined =>
  slice && new Slice(slice.array, slice.offset + from, to - from, slice.capacity - from);

const readInto = (reader: Value, target: Slice | undefined): [number, Value] => {
  const [count, error] = callMethod(reader, 'Read', [target]) as [bigint, Value];
  return [Number(count), error];
};

function readAtLeast(reader: Value, buffer: Slice | undefined, min: number): [bigint, Value] {
  if ((buffer?.length ?? 0) < min) return [0n, ERR_SHORT_BUFFER];
  let count = 0;
  let error: Value;
  while (count < min && error === undefined) {
    const [read, readError] = readInto(reader, subslice(buffer, count));
    count += read;
    error = readError;
  }
  if (count >= min) error = undefined;
  else if (count > 0 && error === EOF) error = ERR_UNEXPECTED_EOF;
  return [BigInt(count), error];
}

const variable = (name: string, type: Type, value: Value): Entity => ({
  kind: 'var',
  name,
  type,
  span: { row: 0, column: 0 },
  used: true,
  boxed: false,
  owner: undefined,
  slot: -1,
  library: () => value,
});

const READ = fn([BYTE_SLICE], [BASIC.int, ERROR_TYPE]);
const interfaceOf = (name: string, methods: { name: string; type: FuncType }[]): NamedType =>
  namedType('io', name, {
    kind: 'interface',
    methods: methods.toSorted((a, b) => (a.name < b.name ? -1 : 1)),
  });
const CLOSE = { name: 'Close', type: fn([], [ERROR_TYPE]) };
const READ_METHOD = { name: 'Read', type: READ };
const WRITE_METHOD = { name: 'Write', type: READ };
const CLOSER = interfaceOf('Closer', [CLOSE]);
const READ_CLOSER = interfaceOf('ReadCloser', [READ_METHOD, CLOSE]);
const READ_WRITER = interfaceOf('ReadWriter', [READ_METHOD, WRITE_METHOD]);
const WRITE_CLOSER = interfaceOf('WriteCloser', [WRITE_METHOD, CLOSE]);
const READ_WRITE_CLOSER = interfaceOf('ReadWriteCloser', [READ_METHOD, WRITE_METHOD, CLOSE]);
const BYTE_READER = interfaceOf('ByteReader', [{ name: 'ReadByte', type: fn([], [BASIC.uint8, ERROR_TYPE]) }]);
const BYTE_WRITER = interfaceOf('ByteWriter', [{ name: 'WriteByte', type: fn([BASIC.uint8], [ERROR_TYPE]) }]);
const RUNE_READER = interfaceOf('RuneReader', [
  { name: 'ReadRune', type: fn([], [BASIC.int32, BASIC.int, ERROR_TYPE]) },
]);
const STRING_WRITER = interfaceOf('StringWriter', [
  { name: 'WriteString', type: fn([BASIC.string], [BASIC.int, ERROR_TYPE]) },
]);

/** `io.LimitedReader`, whose exported fields hold the reader and the bytes it may still read. */
const LIMITED_READER = namedType('io', 'LimitedReader', {
  kind: 'struct',
  fields: [
    { name: 'R', type: IO_READER, embedded: false },
    { name: 'N', type: BASIC.int64, embedded: false },
  ],
});
addMethod(
  LIMITED_READER,
  'Read',
  READ,
  (receiver, [target]) => {
    const fields = ((receiver as Pointer).load() as GoStruct).fields;
    const left = fields[1] as bigint;
    if (left <= 0n) return [0n, EOF];
    const buffer = target as Slice | undefined;
    const limited = (buffer?.length ?? 0) > left ? subslice(buffer, 0, Number(left)) : buffer;
    const [count, error] = readInto(fields[0], limited);
    fields[1] = left - BigInt(count);
    return [BigInt(count), error];
  },
  true
);
const newLimitedReader = (reader: Value, limit: bigint): Iface =>
  new Iface(pointerTo(LIMITED_READER), new Pointer(new Cell(new GoStruct([reader, limit])), 'v'));

/** The unexported reader types of io, which hold Go values in their native state. */
const MULTI_READER = namedType('io', 'multiReader', { kind: 'struct', fields: [] });
addMethod(
  MULTI_READER,
  'Read',
  READ,
  (receiver, [target]) => {
    const readers = ((receiver as Pointer).load() as GoStruct).native?.readers as Value[];
    while (readers.length > 0) {
      const [count, error] = readInto(readers[0], target as Slice | undefined);
      if (error === EOF) readers.shift();
      if (count > 0 || error !== EOF) return [BigInt(count), error === EOF && readers.length > 0 ? undefined : error];
    }
    return [0n, EOF];
  },
  true
);
const MULTI_WRITER = namedType('io', 'multiWriter', { kind: 'struct', fields: [] });
addMethod(
  MULTI_WRITER,
  'Write',
  READ,
  (receiver, [data]) => {
    const writers = ((receiver as Pointer).load() as GoStruct).native?.writers as Value[];
    const length = (data as Slice | undefined)?.length ?? 0;
    for (const writer of writers) {
      const [count, error] = callMethod(writer, 'Write', [data]) as [bigint, Value];
      if (error !== undefined) return [count, error];
      if (Number(count) !== length) return [count, ERR_SHORT_WRITE];
    }
    return [BigInt(length), undefined];
  },
  true
);
const TEE_READER = namedType('io', 'teeReader', { kind: 'struct', fields: [] });
addMethod(
  TEE_READER,
  'Read',
  READ,
  (receiver, [target]) => {
    const { reader, writer } = ((receiver as Pointer).load() as GoStruct).native as { reader: Value; writer: Value };
    const [count, error] = readInto(reader, target as Slice | undefined);
    if (count > 0) {
      const [written, writeError] = callMethod(writer, 'Write', [subslice(target as Slice, 0, count)]) as [
        bigint,
        Value,
      ];
      if (writeError !== undefined) return [written, writeError];
    }
    return [BigInt(count), error];
  },
  true
);
const DISCARD = namedType('io', 'discard', { kind: 'struct', fields: [] });
addMethod(DISCARD, 'Write', READ, (_receiver, [data]) => [BigInt((data as Slice | undefined)?.length ?? 0), undefined]);
addMethod(DISCARD, 'WriteString', fn([BASIC.string], [BASIC.int, ERROR_TYPE]), (_receiver, [text]) => [
  BigInt((text as string).length),
  undefined,
]);
const NOP_CLOSER = namedType('io', 'nopCloser', {
  kind: 'struct',
  fields: [{ name: 'Reader', type: IO_READER, embedded: true }],
});
addMethod(NOP_CLOSER, 'Close', fn([], [ERROR_TYPE]), () => {});
/** NopCloser's type for readers that also have WriteTo, as the library's readers of strings and bytes do. */
const NOP_CLOSER_WRITER_TO = namedType('io', 'nopCloserWriterTo', {
  kind: 'struct',
  fields: [{ name: 'Reader', type: IO_READER, embedded: true }],
});
addMethod(NOP_CLOSER_WRITER_TO, 'Close', fn([], [ERROR_TYPE]), () => {});
const WRITER_TO_TYPES = new Set(['*strings.Reader', '*bytes.Reader', '*bytes.Buffer']);

const native = (type: NamedType, state: Record<string, unknown>): Iface =>
  new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct([], state)), 'v'));

Object.assign(members, {
  ReadCloser: typeEntity(READ_CLOSER),
  ReadWriter: typeEntity(READ_WRITER),
  WriteCloser: typeEntity(WRITE_CLOSER),
  ReadWriteCloser: typeEntity(READ_WRITE_CLOSER),
  Closer: typeEntity(CLOSER),
  ByteReader: typeEntity(BYTE_READER),
  ByteWriter: typeEntity(BYTE_WRITER),
  RuneReader: typeEntity(RUNE_READER),
  StringWriter: typeEntity(STRING_WRITER),
  LimitedReader: typeEntity(LIMITED_READER),
  ErrUnexpectedEOF: variable('ErrUnexpectedEOF', ERROR_TYPE, ERR_UNEXPECTED_EOF),
  ErrShortWrite: variable('ErrShortWrite', ERROR_TYPE, ERR_SHORT_WRITE),
  ErrShortBuffer: variable('ErrShortBuffer', ERROR_TYPE, ERR_SHORT_BUFFER),
  ErrNoProgress: variable('ErrNoProgress', ERROR_TYPE, ERR_NO_PROGRESS),
  Discard: variable('Discard', IO_WRITER, new Iface(DISCARD, new GoStruct([]))),
  ReadFull: nativeFunction('ReadFull', fn([IO_READER, BYTE_SLICE], [BASIC.int, ERROR_TYPE]), ([reader, buffer]) =>
    readAtLeast(reader, buffer as Slice | undefined, (buffer as Slice | undefined)?.length ?? 0)
  ),
  ReadAtLeast: nativeFunction(
    'ReadAtLeast',
    fn([IO_READER, BYTE_SLICE, BASIC.int], [BASIC.int, ERROR_TYPE]),
    ([reader, buffer, min]) => readAtLeast(reader, buffer as Slice | undefined, Number(min as bigint))
  ),
  LimitReader: nativeFunction('LimitReader', fn([IO_READER, BASIC.int64], [IO_READER]), ([reader, limit]) =>
    newLimitedReader(reader, limit as bigint)
  ),
  MultiReader: nativeFunction('MultiReader', fn([sliceOf(IO_READER)], [IO_READER], true), ([readers]) =>
    native(MULTI_READER, { readers: (readers as Slice | undefined)?.values() ?? [] })
  ),
  MultiWriter: nativeFunction('MultiWriter', fn([sliceOf(IO_WRITER)], [IO_WRITER], true), ([writers]) =>
    native(MULTI_WRITER, { writers: (writers as Slice | undefined)?.values() ?? [] })
  ),
  TeeReader: nativeFunction('TeeReader', fn([IO_READER, IO_WRITER], [IO_READER]), ([reader, writer]) =>
    native(TEE_READER, { reader, writer })
  ),
  NopCloser: nativeFunction(
    'NopCloser',
    fn([IO_READER], [READ_CLOSER]),
    ([reader]) =>
      new Iface(
        reader instanceof Iface &&
          (WRITER_TO_TYPES.has(typeString(reader.type)) ||
            lookupFieldOrMethod(reader.type, 'WriteTo').kind === 'method')
          ? NOP_CLOSER_WRITER_TO
          : NOP_CLOSER,
        new GoStruct([reader])
      )
  ),
  CopyN: nativeFunction(
    'CopyN',
    fn([IO_WRITER, IO_READER, BASIC.int64], [BASIC.int64, ERROR_TYPE]),
    ([writer, reader, count]) => {
      const copy = (members.Copy as FuncEntity).direct as NonNullable<FuncEntity['direct']>;
      const [written, error] = copy([writer, newLimitedReader(reader, count as bigint)], undefined) as [bigint, Value];
      if (written === count) return [written, undefined];
      return [written, error ?? EOF];
    }
  ),
});

export const IO_PACKAGE = definePackage('io', members, [
  'Pipe',
  'PipeReader',
  'PipeWriter',
  'SectionReader',
  'NewSectionReader',
  'CopyBuffer',
  'Seeker',
  'ReadSeeker',
  'ReaderAt',
  'WriterAt',
  'ReaderFrom',
  'WriterTo',
  'ErrClosedPipe',
]);
