import { assignFailure } from '../assignability';
import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { currentRuntime, fn, namedType, nativeFunction, typeEntity } from '../native';
import { grownCapacity } from '../sliceOps';
import { BASIC, ERROR_TYPE, type FuncType, type NamedType, sliceOf, type Type } from '../types';
import { Iface, Pointer, Slice, type Value } from '../values';
import { byteSlice, callMethod } from './support';

const BYTE_SLICE = sliceOf(BASIC.uint8);
const INT = BASIC.int;
const INT64 = BASIC.int64;

function ioInterface(name: string, methods: Record<string, FuncType>): NamedType {
  return namedType('io', name, {
    kind: 'interface',
    methods: Object.keys(methods)
      .toSorted()
      .map((method) => ({ name: method, type: methods[method] })),
  });
}

const READ = fn([BYTE_SLICE], [INT, ERROR_TYPE]);
const CLOSE = fn([], [ERROR_TYPE]);
const SEEK = fn([INT64, INT], [INT64, ERROR_TYPE]);
const AT = fn([BYTE_SLICE, INT64], [INT, ERROR_TYPE]);
const RUNE_READ = fn([], [BASIC.int32, INT, ERROR_TYPE]);
const BYTE_READ = fn([], [BASIC.uint8, ERROR_TYPE]);
const UNREAD = fn([], [ERROR_TYPE]);

export const IO_WRITER = ioInterface('Writer', { Write: READ });
export const IO_READER = ioInterface('Reader', { Read: READ });
export const IO_RUNE_SCANNER = ioInterface('RuneScanner', { ReadRune: RUNE_READ, UnreadRune: UNREAD });
export const IO_STRING_WRITER = ioInterface('StringWriter', {
  WriteString: fn([BASIC.string], [INT, ERROR_TYPE]),
});
export const IO_READER_FROM = ioInterface('ReaderFrom', { ReadFrom: fn([IO_READER], [INT64, ERROR_TYPE]) });
export const IO_WRITER_TO = ioInterface('WriterTo', { WriteTo: fn([IO_WRITER], [INT64, ERROR_TYPE]) });
export const IO_READER_AT = ioInterface('ReaderAt', { ReadAt: AT });
export const IO_WRITER_AT = ioInterface('WriterAt', { WriteAt: AT });
export const IO_CLOSER = ioInterface('Closer', { Close: CLOSE });
export const IO_WRITE_CLOSER = ioInterface('WriteCloser', { Write: READ, Close: CLOSE });
export const IO_READ_CLOSER = ioInterface('ReadCloser', { Read: READ, Close: CLOSE });

export const IO_RUNE_READER = ioInterface('RuneReader', { ReadRune: RUNE_READ });

const INTERFACES = [
  IO_WRITER,
  IO_READER,
  IO_RUNE_SCANNER,
  IO_RUNE_READER,
  IO_STRING_WRITER,
  IO_READER_FROM,
  IO_WRITER_TO,
  IO_READER_AT,
  IO_WRITER_AT,
  IO_CLOSER,
  IO_WRITE_CLOSER,
  IO_READ_CLOSER,
  ioInterface('Seeker', { Seek: SEEK }),
  ioInterface('ReadWriter', { Read: READ, Write: READ }),
  ioInterface('ReadWriteCloser', { Read: READ, Write: READ, Close: CLOSE }),
  ioInterface('ReadSeeker', { Read: READ, Seek: SEEK }),
  ioInterface('ReadSeekCloser', { Read: READ, Seek: SEEK, Close: CLOSE }),
  ioInterface('WriteSeeker', { Write: READ, Seek: SEEK }),
  ioInterface('ReadWriteSeeker', { Read: READ, Write: READ, Seek: SEEK }),
  ioInterface('ByteReader', { ReadByte: BYTE_READ }),
  ioInterface('ByteScanner', { ReadByte: BYTE_READ, UnreadByte: UNREAD }),
  ioInterface('ByteWriter', { WriteByte: fn([BASIC.uint8], [ERROR_TYPE]) }),
];

/** `io.EOF`, which readers return at the end and programs compare with ==. */
export const EOF = newError('EOF');
export const ERR_SHORT_WRITE = newError('short write');
export const ERR_SHORT_BUFFER = newError('short buffer');
export const ERR_UNEXPECTED_EOF = newError('unexpected EOF');
export const ERR_NO_PROGRESS = newError('multiple Read calls return no data or error');
const ERR_CLOSED_PIPE = newError('io: read/write on closed pipe');
const ERR_INVALID_WRITE = newError('invalid write result');
export const ERR_WHENCE = newError('Seek: invalid whence');
export const ERR_OFFSET = newError('Seek: invalid offset');

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

/** Whether an interface value's dynamic type implements the interface, as a type assertion `v.(I)` checks. */
export function implementsInterface(value: Value, type: Type): boolean {
  return value instanceof Iface && assignFailure(value.type, type) === undefined;
}

/** `io.WriteString`: the writer's own WriteString when it has one, and Write otherwise. */
export function writeString(writer: Value, text: string): [bigint, Value] {
  const viaString = implementsInterface(writer, IO_STRING_WRITER);
  return callMethod(writer, viaString ? 'WriteString' : 'Write', [viaString ? text : byteSlice(text)]) as [
    bigint,
    Value,
  ];
}

/** A package-level library variable; a function value gives each run its own value. */
export function libraryVariable(name: string, type: Type, value: Value | (() => Value)): Entity {
  return {
    kind: 'var',
    name,
    type,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: typeof value === 'function' ? value : () => value,
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

/** A new zeroed byte slice of the length, counted against the run's memory. */
export function makeBytes(length: number, capacity = length): Slice {
  currentRuntime().allocate(capacity);
  return new Slice(
    Array.from({ length: capacity }, (): Value => 0n),
    0,
    length,
    capacity
  );
}

/** `s[from:to]` of a byte slice, where a nil slice stays nil. */
export function subslice(slice: Value, from: number, to?: number): Slice | undefined {
  const s = slice as Slice | undefined;
  if (!s) return undefined;
  const end = to ?? s.length;
  return new Slice(s.array, s.offset + from, end - from, s.capacity - from);
}

/** Calls `Read` and returns the count as a number with the error. */
export function readInto(reader: Value, buffer: Value): [number, Value] {
  const [count, error] = callMethod(reader, 'Read', [buffer]) as [bigint, Value];
  return [Number(count), error];
}

/** Calls `Write` and returns the count as a number with the error. */
export function writeFrom(writer: Value, buffer: Value): [number, Value] {
  const [count, error] = callMethod(writer, 'Write', [buffer]) as [bigint, Value];
  return [Number(count), error];
}

/** `io.copyBuffer`: prefers the source's WriteTo and the destination's ReadFrom, as Go's Copy does. */
export function copyBuffer(
  dst: Value,
  src: Value,
  buffer: Slice | undefined,
  limitOf?: (src: Value) => bigint | undefined
): [bigint, Value] {
  if (implementsInterface(src, IO_WRITER_TO)) return callMethod(src, 'WriteTo', [dst]) as [bigint, Value];
  if (implementsInterface(dst, IO_READER_FROM)) return callMethod(dst, 'ReadFrom', [src]) as [bigint, Value];
  let buf = buffer;
  if (!buf) {
    let size = 32 * 1024;
    const limit = limitOf?.(src);
    if (limit !== undefined && BigInt(size) > limit) size = limit < 1n ? 1 : Number(limit);
    buf = makeBytes(size);
  }
  const runtime = currentRuntime();
  let written = 0n;
  for (;;) {
    runtime.spend();
    const [nr, er] = readInto(src, buf);
    if (nr > 0) {
      let [nw, ew] = writeFrom(dst, subslice(buf, 0, nr));
      if (nw < 0 || nr < nw) {
        nw = 0;
        ew ??= ERR_INVALID_WRITE;
      }
      written += BigInt(nw);
      if (ew !== undefined) return [written, ew];
      if (nr !== nw) return [written, ERR_SHORT_WRITE];
    }
    if (er !== undefined) return [written, sameError(er, EOF) ? undefined : er];
  }
}

/** `io.ReadAll`, which reads into a 512-byte buffer and then into growing chunks, as Go's does. */
function readAll(reader: Value): [Slice, Value] {
  const runtime = currentRuntime();
  let b = makeBytes(0, 512);
  let next = 256;
  const chunks: Slice[] = [];
  let finalSize = 0;
  for (;;) {
    runtime.spend();
    const [n, readError] = readInto(
      reader,
      new Slice(b.array, b.offset + b.length, b.capacity - b.length, b.capacity - b.length)
    );
    b = new Slice(b.array, b.offset, b.length + n, b.capacity);
    if (readError !== undefined) {
      const error = sameError(readError, EOF) ? undefined : readError;
      if (chunks.length === 0) return [b, error];
      finalSize += b.length;
      const final = makeBytes(0, grownCapacity(0, finalSize, BASIC.uint8));
      let at = 0;
      for (const chunk of [...chunks, b]) {
        for (const byte of chunk.values()) final.array[at++] = byte;
      }
      runtime.spend(finalSize >> 4);
      return [new Slice(final.array, 0, finalSize, final.capacity), error];
    }
    if (b.capacity - b.length < Math.floor(b.capacity / 16)) {
      chunks.push(b);
      finalSize += b.length;
      runtime.checkStringLength(finalSize);
      b = makeBytes(0, grownCapacity(0, next, BASIC.uint8));
      next += Math.floor(next / 2);
    }
  }
}

/** `io.ReadAtLeast`. */
function readAtLeast(reader: Value, buffer: Value, min: number): [bigint, Value] {
  const length = (buffer as Slice | undefined)?.length ?? 0;
  if (length < min) return [0n, ERR_SHORT_BUFFER];
  const runtime = currentRuntime();
  let n = 0;
  let error: Value;
  while (n < min && error === undefined) {
    runtime.spend();
    const [count, readError] = readInto(reader, subslice(buffer, n));
    n += count;
    error = readError;
  }
  if (n >= min) error = undefined;
  else if (n > 0 && sameError(error, EOF)) error = ERR_UNEXPECTED_EOF;
  return [BigInt(n), error];
}

export const IO_TYPES: Record<string, Entity> = Object.fromEntries(
  INTERFACES.map((type) => [type.name, typeEntity(type)])
);

export const IO_ERRORS: Record<string, Entity> = {
  EOF: libraryVariable('EOF', ERROR_TYPE, EOF),
  ErrShortWrite: libraryVariable('ErrShortWrite', ERROR_TYPE, ERR_SHORT_WRITE),
  ErrShortBuffer: libraryVariable('ErrShortBuffer', ERROR_TYPE, ERR_SHORT_BUFFER),
  ErrUnexpectedEOF: libraryVariable('ErrUnexpectedEOF', ERROR_TYPE, ERR_UNEXPECTED_EOF),
  ErrNoProgress: libraryVariable('ErrNoProgress', ERROR_TYPE, ERR_NO_PROGRESS),
  ErrClosedPipe: libraryVariable('ErrClosedPipe', ERROR_TYPE, ERR_CLOSED_PIPE),
  SeekStart: intConstant('SeekStart', 0),
  SeekCurrent: intConstant('SeekCurrent', 1),
  SeekEnd: intConstant('SeekEnd', 2),
};

export const IO_FUNCTIONS: Record<string, Entity> = {
  ReadAll: nativeFunction('ReadAll', fn([IO_READER], [BYTE_SLICE, ERROR_TYPE]), ([reader]) => readAll(reader)),
  ReadAtLeast: nativeFunction(
    'ReadAtLeast',
    fn([IO_READER, BYTE_SLICE, INT], [INT, ERROR_TYPE]),
    ([reader, buffer, min]) => readAtLeast(reader, buffer, Number(min as bigint))
  ),
  ReadFull: nativeFunction('ReadFull', fn([IO_READER, BYTE_SLICE], [INT, ERROR_TYPE]), ([reader, buffer]) =>
    readAtLeast(reader, buffer, (buffer as Slice | undefined)?.length ?? 0)
  ),
  WriteString: nativeFunction('WriteString', fn([IO_WRITER, BASIC.string], [INT, ERROR_TYPE]), ([writer, text]) =>
    writeString(writer, text as string)
  ),
};
