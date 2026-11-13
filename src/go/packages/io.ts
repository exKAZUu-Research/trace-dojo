import { assignFailure } from '../assignability';
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { BASIC, ERROR_TYPE, sliceOf, type Type } from '../types';
import { Iface, Pointer, Slice, type Value } from '../values';
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

const RUNE_READ = fn([], [BASIC.int32, BASIC.int, ERROR_TYPE]);
const BYTE_READ = fn([], [BASIC.uint8, ERROR_TYPE]);
const UNREAD = fn([], [ERROR_TYPE]);

export const IO_RUNE_SCANNER = namedType('io', 'RuneScanner', {
  kind: 'interface',
  methods: [
    { name: 'ReadRune', type: RUNE_READ },
    { name: 'UnreadRune', type: UNREAD },
  ],
});

export const IO_STRING_WRITER = namedType('io', 'StringWriter', {
  kind: 'interface',
  methods: [{ name: 'WriteString', type: fn([BASIC.string], [BASIC.int, ERROR_TYPE]) }],
});

export const IO_READER_FROM = namedType('io', 'ReaderFrom', {
  kind: 'interface',
  methods: [{ name: 'ReadFrom', type: fn([IO_READER], [BASIC.int64, ERROR_TYPE]) }],
});

const IO_WRITER_TO = namedType('io', 'WriterTo', {
  kind: 'interface',
  methods: [{ name: 'WriteTo', type: fn([IO_WRITER], [BASIC.int64, ERROR_TYPE]) }],
});

const INTERFACES = [
  IO_RUNE_SCANNER,
  IO_WRITER_TO,
  IO_STRING_WRITER,
  IO_READER_FROM,
  namedType('io', 'RuneReader', { kind: 'interface', methods: [{ name: 'ReadRune', type: RUNE_READ }] }),
  namedType('io', 'ByteReader', { kind: 'interface', methods: [{ name: 'ReadByte', type: BYTE_READ }] }),
  namedType('io', 'ByteScanner', {
    kind: 'interface',
    methods: [
      { name: 'ReadByte', type: BYTE_READ },
      { name: 'UnreadByte', type: UNREAD },
    ],
  }),
];

/** `io.EOF`, which readers return at the end and programs compare with ==. */
export const EOF = newError('EOF');
export const ERR_SHORT_WRITE = newError('short write');
export const ERR_UNEXPECTED_EOF = newError('unexpected EOF');
export const ERR_NO_PROGRESS = newError('multiple Read calls return no data or error');
const ERR_INVALID_WRITE = newError('invalid write result');

/** Whether two error values are the same error, as `==` compares the pointers that `errors.New` returns. */
export function sameError(a: Value, b: Value): boolean {
  if (a === b) return true;
  return (
    a instanceof Iface &&
    b instanceof Iface &&
    a.type === b.type &&
    a.value instanceof Pointer &&
    b.value instanceof Pointer &&
    a.value.equals(b.value)
  );
}

/** `io.WriteString`: the writer's own WriteString when it has one, and Write otherwise. */
export function writeString(writer: Value, text: string): [bigint, Value] {
  const viaString = implementsInterface(writer, IO_STRING_WRITER);
  return callMethod(writer, viaString ? 'WriteString' : 'Write', [viaString ? text : byteSlice(text)]) as [
    bigint,
    Value,
  ];
}

function implementsInterface(value: Value, type: Type): boolean {
  return value instanceof Iface && assignFailure(value.type, type) === undefined;
}

export function libraryVariable(name: string, type: Type, value: Value): Entity {
  return {
    kind: 'var',
    name,
    type,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => value,
  };
}

function intConstant(name: string, value: number): Entity {
  return {
    kind: 'const',
    name,
    type: BASIC.untypedInt,
    value: { kind: 'int', value: BigInt(value) },
    span: { row: 0, column: 0 },
    used: true,
  };
}

/** Reads everything from a reader through its Read method, 512 bytes at a time as io.ReadAll starts. */
function readAll(reader: Value): [string, Value] {
  const runtime = currentRuntime();
  let data = '';
  for (;;) {
    runtime.spend();
    const buffer = byteSlice('\0'.repeat(512));
    const [count, error] = callMethod(reader, 'Read', [buffer]) as [bigint, Value];
    const chunk = bytesOf(buffer).slice(0, Math.max(0, Number(count)));
    runtime.checkStringLength(data.length + chunk.length);
    data += chunk;
    if (error !== undefined) return [data, error === EOF ? undefined : error];
  }
}

const members: Record<string, Entity> = {
  Reader: typeEntity(IO_READER),
  Writer: typeEntity(IO_WRITER),
  ...Object.fromEntries(INTERFACES.map((type) => [type.name, typeEntity(type)])),
  EOF: libraryVariable('EOF', ERROR_TYPE, EOF),
  ErrShortWrite: libraryVariable('ErrShortWrite', ERROR_TYPE, ERR_SHORT_WRITE),
  ErrUnexpectedEOF: libraryVariable('ErrUnexpectedEOF', ERROR_TYPE, ERR_UNEXPECTED_EOF),
  ErrNoProgress: libraryVariable('ErrNoProgress', ERROR_TYPE, ERR_NO_PROGRESS),
  SeekStart: intConstant('SeekStart', 0),
  SeekCurrent: intConstant('SeekCurrent', 1),
  SeekEnd: intConstant('SeekEnd', 2),
  Copy: nativeFunction('Copy', fn([IO_WRITER, IO_READER], [BASIC.int64, ERROR_TYPE]), ([writer, reader]) => {
    if (implementsInterface(reader, IO_WRITER_TO)) return callMethod(reader, 'WriteTo', [writer]);
    if (implementsInterface(writer, IO_READER_FROM)) return callMethod(writer, 'ReadFrom', [reader]);
    const runtime = currentRuntime();
    const size = 32 * 1024;
    runtime.allocate(size);
    const backing = Array.from({ length: size }, (): Value => 0n);
    const buf = new Slice(backing, 0, size, size);
    let written = 0n;
    for (;;) {
      runtime.spend();
      const [nrBig, er] = callMethod(reader, 'Read', [buf]) as [bigint, Value];
      const nr = Number(nrBig);
      if (nr > 0) {
        const chunk = new Slice(backing, 0, Math.min(nr, size), size);
        let [nwBig, ew] = callMethod(writer, 'Write', [chunk]) as [bigint, Value];
        let nw = Number(nwBig);
        if (nw < 0 || nr < nw) {
          nw = 0;
          ew ??= ERR_INVALID_WRITE;
        }
        written += BigInt(nw);
        if (ew !== undefined) return [written, ew];
        if (nr !== nw) return [written, ERR_SHORT_WRITE];
      }
      if (er !== undefined) return [written, er === EOF ? undefined : er];
    }
  }),
  ReadAll: nativeFunction('ReadAll', fn([IO_READER], [BYTE_SLICE, ERROR_TYPE]), ([reader]) => {
    const [data, error] = readAll(reader);
    return [byteSlice(data) as Slice, error];
  }),
  WriteString: nativeFunction('WriteString', fn([IO_WRITER, BASIC.string], [BASIC.int, ERROR_TYPE]), ([writer, text]) =>
    writeString(writer, text as string)
  ),
};

export const IO_PACKAGE = definePackage(
  'io',
  members,
  [
    'Pipe',
    'ReadFull',
    'ReadAtLeast',
    'MultiReader',
    'MultiWriter',
    'TeeReader',
    'LimitReader',
    'SectionReader',
    'NopCloser',
    'Discard',
    'CopyN',
    'CopyBuffer',
    'ReadCloser',
    'WriteCloser',
    'ReadWriter',
    'Closer',
    'Seeker',
    'ReaderAt',
    'WriterAt',
    'ByteReader',
    'RuneReader',
    'StringWriter',
    'ErrClosedPipe',
  ].filter((name) => !(name in members))
);
