import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { currentRuntime, definePackage, fn, namedType, nativeFunction, typeEntity } from '../native';
import { BASIC, ERROR_TYPE, sliceOf } from '../types';
import { Slice, type Value } from '../values';
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
export const ERR_SHORT_WRITE = newError('short write');
const ERR_INVALID_WRITE = newError('invalid write result');

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
  ErrShortWrite: {
    kind: 'var',
    name: 'ErrShortWrite',
    type: ERROR_TYPE,
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => ERR_SHORT_WRITE,
  },
  Copy: nativeFunction('Copy', fn([IO_WRITER, IO_READER], [BASIC.int64, ERROR_TYPE]), ([writer, reader]) => {
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
  'ErrClosedPipe',
]);
