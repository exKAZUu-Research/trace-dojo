import type { Entity } from '../entities';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { BASIC, ERROR_TYPE, identical, type NamedType, pointerTo, sliceOf, type Type } from '../types';
import { Cell, GoStruct, Iface, Pointer, type Slice, type Value } from '../values';
import {
  copyBuffer,
  EOF,
  ERR_OFFSET,
  ERR_SHORT_WRITE,
  ERR_WHENCE,
  implementsInterface,
  IO_ERRORS,
  IO_FUNCTIONS,
  IO_READ_CLOSER,
  IO_READER,
  IO_READER_AT,
  IO_STRING_WRITER,
  IO_TYPES,
  IO_WRITER,
  IO_WRITER_AT,
  IO_WRITER_TO,
  libraryVariable,
  makeBytes,
  readInto,
  sameError,
  subslice,
  writeFrom,
} from './io';
import { byteSlice, callMethod, receiverStruct, sliceOfValues, sliceValues, stringPanic } from './support';

const BYTES = sliceOf(BASIC.uint8);
const INT = BASIC.int;
const INT64 = BASIC.int64;
const READ = fn([BYTES], [INT, ERROR_TYPE]);
const COUNT_RESULTS: Type[] = [INT64, ERROR_TYPE];

function struct(name: string, fields: [string, Type][], embedded = false): NamedType {
  return namedType('io', name, {
    kind: 'struct',
    fields: fields.map(([fieldName, type]) => ({ name: fieldName, type, embedded })),
  });
}

function pointerValue(type: NamedType, fields: Value[]): Iface {
  currentRuntime().allocate(1);
  return new Iface(pointerTo(type), new Pointer(new Cell(new GoStruct(fields)), 'v'));
}

const fieldsOf = (receiver: Value): Value[] => receiverStruct(receiver).fields;

// LimitedReader -----------------------------------------------------------------------------------------------------

const LIMITED_READER = struct('LimitedReader', [
  ['R', IO_READER],
  ['N', INT64],
]);
addMethod(
  LIMITED_READER,
  'Read',
  READ,
  (receiver, [buffer]) => {
    const fields = fieldsOf(receiver);
    const limit = fields[1] as bigint;
    if (limit <= 0n) return [0n, EOF];
    let p = buffer;
    if (BigInt((p as Slice | undefined)?.length ?? 0) > limit) p = subslice(p, 0, Number(limit));
    const [n, error] = readInto(fields[0], p);
    fields[1] = (fields[1] as bigint) - BigInt(n);
    return [BigInt(n), error];
  },
  true
);

function limitOf(reader: Value): bigint | undefined {
  if (!(reader instanceof Iface) || !identical(reader.type, pointerTo(LIMITED_READER))) return undefined;
  return fieldsOf(reader.value)[1] as bigint;
}

function copyStreams(dst: Value, src: Value, buffer?: Slice): [bigint, Value] {
  return copyBuffer(dst, src, buffer, limitOf);
}

// SectionReader -----------------------------------------------------------------------------------------------------

const SECTION_READER = struct('SectionReader', [
  ['r', IO_READER_AT],
  ['base', INT64],
  ['off', INT64],
  ['limit', INT64],
  ['n', INT64],
]);

const MAX_INT64 = (1n << 63n) - 1n;

function readAt(reader: Value, buffer: Value, offset: bigint): [bigint, Value] {
  return callMethod(reader, 'ReadAt', [buffer, offset]) as [bigint, Value];
}

addMethod(
  SECTION_READER,
  'Read',
  READ,
  (receiver, [buffer]) => {
    const fields = fieldsOf(receiver);
    const [r, , off, limit] = fields as [Value, bigint, bigint, bigint];
    if (off >= limit) return [0n, EOF];
    let p = buffer;
    if (BigInt((p as Slice | undefined)?.length ?? 0) > limit - off) p = subslice(p, 0, Number(limit - off));
    const [n, error] = readAt(r, p, off);
    fields[2] = off + n;
    return [n, error];
  },
  true
);
addMethod(
  SECTION_READER,
  'Seek',
  fn([INT64, INT], COUNT_RESULTS),
  (receiver, [offsetValue, whence]) => {
    const fields = fieldsOf(receiver);
    const [, base, off, limit] = fields as [Value, bigint, bigint, bigint];
    const origin = [base, off, limit][Number(whence as bigint)] as bigint | undefined;
    if (origin === undefined || (whence as bigint) < 0n) return [0n, ERR_WHENCE];
    const offset = BigInt.asIntN(64, (offsetValue as bigint) + origin);
    if (offset < base) return [0n, ERR_OFFSET];
    fields[2] = offset;
    return [offset - base, undefined];
  },
  true
);
addMethod(
  SECTION_READER,
  'ReadAt',
  fn([BYTES, INT64], [INT, ERROR_TYPE]),
  (receiver, [buffer, offsetValue]) => {
    const [r, base, , limit] = fieldsOf(receiver) as [Value, bigint, bigint, bigint];
    let off = offsetValue as bigint;
    if (off < 0n || off >= limit - base) return [0n, EOF];
    off += base;
    if (BigInt((buffer as Slice | undefined)?.length ?? 0) > limit - off) {
      const [n, error] = readAt(r, subslice(buffer, 0, Number(limit - off)), off);
      return [n, error ?? EOF];
    }
    return readAt(r, buffer, off);
  },
  true
);
addMethod(
  SECTION_READER,
  'Size',
  fn([], [INT64]),
  (receiver) => {
    const [, base, , limit] = fieldsOf(receiver) as [Value, bigint, bigint, bigint];
    return limit - base;
  },
  true
);
addMethod(
  SECTION_READER,
  'Outer',
  fn([], [IO_READER_AT, INT64, INT64]),
  (receiver) => {
    const fields = fieldsOf(receiver);
    return [fields[0], fields[1], fields[4]];
  },
  true
);

// OffsetWriter ------------------------------------------------------------------------------------------------------

const OFFSET_WRITER = struct('OffsetWriter', [
  ['w', IO_WRITER_AT],
  ['base', INT64],
  ['off', INT64],
]);

function writeAt(writer: Value, buffer: Value, offset: bigint): [bigint, Value] {
  return callMethod(writer, 'WriteAt', [buffer, offset]) as [bigint, Value];
}

addMethod(
  OFFSET_WRITER,
  'Write',
  READ,
  (receiver, [buffer]) => {
    const fields = fieldsOf(receiver);
    const [n, error] = writeAt(fields[0], buffer, fields[2] as bigint);
    fields[2] = (fields[2] as bigint) + n;
    return [n, error];
  },
  true
);
addMethod(
  OFFSET_WRITER,
  'WriteAt',
  fn([BYTES, INT64], [INT, ERROR_TYPE]),
  (receiver, [buffer, offset]) => {
    const [w, base] = fieldsOf(receiver) as [Value, bigint];
    if ((offset as bigint) < 0n) return [0n, ERR_OFFSET];
    return writeAt(w, buffer, (offset as bigint) + base);
  },
  true
);
addMethod(
  OFFSET_WRITER,
  'Seek',
  fn([INT64, INT], COUNT_RESULTS),
  (receiver, [offsetValue, whence]) => {
    const fields = fieldsOf(receiver);
    const [, base, off] = fields as [Value, bigint, bigint];
    const origin = [base, off][Number(whence as bigint)] as bigint | undefined;
    if (origin === undefined || (whence as bigint) < 0n) return [0n, ERR_WHENCE];
    const offset = BigInt.asIntN(64, (offsetValue as bigint) + origin);
    if (offset < base) return [0n, ERR_OFFSET];
    fields[2] = offset;
    return [offset - base, undefined];
  },
  true
);

// teeReader, multiReader, multiWriter -------------------------------------------------------------------------------

const TEE_READER = struct('teeReader', [
  ['r', IO_READER],
  ['w', IO_WRITER],
]);
addMethod(
  TEE_READER,
  'Read',
  READ,
  (receiver, [buffer]) => {
    const [r, w] = fieldsOf(receiver);
    const [n, error] = readInto(r, buffer);
    if (n > 0) {
      const [written, writeError] = writeFrom(w, subslice(buffer, 0, n));
      if (writeError !== undefined) return [BigInt(written), writeError];
    }
    return [BigInt(n), error];
  },
  true
);

const EOF_READER = struct('eofReader', []);
addMethod(EOF_READER, 'Read', READ, () => [0n, EOF]);

const MULTI_READER = struct('multiReader', [['readers', sliceOf(IO_READER)]]);
const MULTI_READER_POINTER = pointerTo(MULTI_READER);

function isMultiReader(reader: Value): reader is Iface {
  return reader instanceof Iface && identical(reader.type, MULTI_READER_POINTER);
}

addMethod(
  MULTI_READER,
  'Read',
  READ,
  (receiver, [buffer]) => {
    const fields = fieldsOf(receiver);
    const runtime = currentRuntime();
    for (;;) {
      runtime.spend();
      const readers = fields[0] as Slice | undefined;
      if (!readers || readers.length === 0) return [0n, EOF];
      const first = readers.get(0);
      if (readers.length === 1 && isMultiReader(first)) {
        fields[0] = fieldsOf(first.value)[0];
        continue;
      }
      const [n, error] = readInto(first, buffer);
      const atEof = sameError(error, EOF);
      if (atEof) {
        readers.set(0, new Iface(EOF_READER, new GoStruct([])));
        fields[0] = subslice(readers, 1);
      }
      if (n > 0 || !atEof) {
        const remaining = (fields[0] as Slice).length;
        return [BigInt(n), atEof && remaining > 0 ? undefined : error];
      }
    }
  },
  true
);

function multiWriteTo(receiver: Value, writer: Value, buffer: Slice): [bigint, Value] {
  const fields = fieldsOf(receiver);
  const readers = fields[0] as Slice | undefined;
  let sum = 0n;
  for (let index = 0; index < (readers?.length ?? 0); index++) {
    const reader = (readers as Slice).get(index);
    const [n, error] = isMultiReader(reader)
      ? multiWriteTo(reader.value, writer, buffer)
      : copyStreams(writer, reader, buffer);
    sum += n;
    if (error !== undefined) {
      fields[0] = subslice(readers, index);
      return [sum, error];
    }
    (readers as Slice).set(index, undefined);
  }
  fields[0] = undefined;
  return [sum, undefined];
}

addMethod(
  MULTI_READER,
  'WriteTo',
  fn([IO_WRITER], COUNT_RESULTS),
  (receiver, [writer]) => multiWriteTo(receiver, writer, makeBytes(32 * 1024)),
  true
);

const MULTI_WRITER = struct('multiWriter', [['writers', sliceOf(IO_WRITER)]]);
addMethod(
  MULTI_WRITER,
  'Write',
  READ,
  (receiver, [buffer]) => {
    const length = (buffer as Slice | undefined)?.length ?? 0;
    for (const writer of sliceValues(fieldsOf(receiver)[0])) {
      currentRuntime().spend();
      const [n, error] = writeFrom(writer, buffer);
      if (error !== undefined) return [BigInt(n), error];
      if (n !== length) return [BigInt(n), ERR_SHORT_WRITE];
    }
    return [BigInt(length), undefined];
  },
  true
);
addMethod(
  MULTI_WRITER,
  'WriteString',
  fn([BASIC.string], [INT, ERROR_TYPE]),
  (receiver, [text]) => {
    const s = text as string;
    let bytes: Slice | undefined;
    for (const writer of sliceValues(fieldsOf(receiver)[0])) {
      currentRuntime().spend();
      let result: [bigint, Value];
      if (implementsInterface(writer, IO_STRING_WRITER)) {
        result = callMethod(writer, 'WriteString', [s]) as [bigint, Value];
      } else {
        bytes ??= byteSlice(s);
        result = callMethod(writer, 'Write', [bytes]) as [bigint, Value];
      }
      if (result[1] !== undefined) return result;
      if (result[0] !== BigInt(s.length)) return [result[0], ERR_SHORT_WRITE];
    }
    return [BigInt(s.length), undefined];
  },
  true
);

// discard and nopCloser ---------------------------------------------------------------------------------------------

const DISCARD_TYPE = struct('discard', []);
addMethod(DISCARD_TYPE, 'Write', READ, (_, [buffer]) => [
  BigInt((buffer as Slice | undefined)?.length ?? 0),
  undefined,
]);
addMethod(DISCARD_TYPE, 'WriteString', fn([BASIC.string], [INT, ERROR_TYPE]), (_, [text]) => [
  BigInt((text as string).length),
  undefined,
]);
addMethod(DISCARD_TYPE, 'ReadFrom', fn([IO_READER], COUNT_RESULTS), (_, [reader]) => {
  const buffer = makeBytes(8192);
  let n = 0n;
  for (;;) {
    currentRuntime().spend();
    const [count, error] = readInto(reader, buffer);
    n += BigInt(count);
    if (error !== undefined) return [n, sameError(error, EOF) ? undefined : error];
  }
});
const DISCARD = new Iface(DISCARD_TYPE, new GoStruct([]));

const NOP_CLOSER = struct('nopCloser', [['Reader', IO_READER]], true);
const NOP_CLOSER_WRITER_TO = struct('nopCloserWriterTo', [['Reader', IO_READER]], true);
for (const type of [NOP_CLOSER, NOP_CLOSER_WRITER_TO]) {
  addMethod(type, 'Close', fn([], [ERROR_TYPE]), () => {});
  addMethod(type, 'Read', READ, (receiver, [buffer]) => callMethod((receiver as GoStruct).fields[0], 'Read', [buffer]));
}
addMethod(NOP_CLOSER_WRITER_TO, 'WriteTo', fn([IO_WRITER], COUNT_RESULTS), (receiver, [writer]) =>
  callMethod((receiver as GoStruct).fields[0], 'WriteTo', [writer])
);

// Package -----------------------------------------------------------------------------------------------------------

const members: Record<string, Entity> = {
  ...IO_TYPES,
  ...IO_ERRORS,
  ...IO_FUNCTIONS,
  LimitedReader: typeEntity(LIMITED_READER),
  SectionReader: typeEntity(SECTION_READER),
  OffsetWriter: typeEntity(OFFSET_WRITER),
  Discard: libraryVariable('Discard', IO_WRITER, DISCARD),
  Copy: nativeFunction('Copy', fn([IO_WRITER, IO_READER], COUNT_RESULTS), ([dst, src]) => copyStreams(dst, src)),
  CopyBuffer: nativeFunction('CopyBuffer', fn([IO_WRITER, IO_READER, BYTES], COUNT_RESULTS), ([dst, src, buffer]) => {
    if (buffer !== undefined && (buffer as Slice).length === 0) stringPanic('empty buffer in CopyBuffer');
    return copyStreams(dst, src, buffer as Slice | undefined);
  }),
  CopyN: nativeFunction('CopyN', fn([IO_WRITER, IO_READER, INT64], COUNT_RESULTS), ([dst, src, n]) => {
    const limit = n as bigint;
    const [written, error] = copyStreams(dst, pointerValue(LIMITED_READER, [src, limit]));
    if (written === limit) return [limit, undefined];
    return [written, written < limit && error === undefined ? EOF : error];
  }),
  LimitReader: nativeFunction('LimitReader', fn([IO_READER, INT64], [IO_READER]), ([reader, n]) =>
    pointerValue(LIMITED_READER, [reader, n])
  ),
  NewSectionReader: nativeFunction(
    'NewSectionReader',
    fn([IO_READER_AT, INT64, INT64], [pointerTo(SECTION_READER)]),
    ([reader, offset, n]) => {
      const off = offset as bigint;
      const remaining = off <= MAX_INT64 - (n as bigint) ? (n as bigint) + off : MAX_INT64;
      return pointerValue(SECTION_READER, [reader, off, off, remaining, n]).value;
    }
  ),
  NewOffsetWriter: nativeFunction(
    'NewOffsetWriter',
    fn([IO_WRITER_AT, INT64], [pointerTo(OFFSET_WRITER)]),
    ([writer, offset]) => pointerValue(OFFSET_WRITER, [writer, offset, offset]).value
  ),
  TeeReader: nativeFunction('TeeReader', fn([IO_READER, IO_WRITER], [IO_READER]), ([reader, writer]) =>
    pointerValue(TEE_READER, [reader, writer])
  ),
  MultiReader: nativeFunction('MultiReader', fn([sliceOf(IO_READER)], [IO_READER], true), ([readers]) =>
    pointerValue(MULTI_READER, [sliceOfValues(sliceValues(readers))])
  ),
  MultiWriter: nativeFunction('MultiWriter', fn([sliceOf(IO_WRITER)], [IO_WRITER], true), ([writers]) => {
    const all = sliceValues(writers).flatMap((writer) =>
      writer instanceof Iface && identical(writer.type, pointerTo(MULTI_WRITER))
        ? sliceValues(fieldsOf(writer.value)[0])
        : [writer]
    );
    return pointerValue(MULTI_WRITER, [sliceOfValues(all)]);
  }),
  NopCloser: nativeFunction('NopCloser', fn([IO_READER], [IO_READ_CLOSER]), ([reader]) => {
    const type = implementsInterface(reader, IO_WRITER_TO) ? NOP_CLOSER_WRITER_TO : NOP_CLOSER;
    return new Iface(type, new GoStruct([reader]));
  }),
};

/** The io package, without the pipes, which need goroutines. */
export const IO_PACKAGE = definePackage('io', members, ['Pipe', 'PipeReader', 'PipeWriter']);
