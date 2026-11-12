import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { BASIC, ERROR_TYPE, sliceOf } from '../types';
import type { Slice, Value } from '../values';
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

export const IO_PACKAGE = definePackage('io', members, [
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
  'ErrUnexpectedEOF',
  'ErrShortWrite',
  'ErrClosedPipe',
]);
