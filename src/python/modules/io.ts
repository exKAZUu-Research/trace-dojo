// The in-memory streams of io; streams over files stay unsupported.
import { bytesLikeData, newByteArray, newBytes, PyBytes } from '../bytesValues';
import { addressOf, pyRepr } from '../conversions';
import { method } from '../define';
import { viewOf } from '../memoryview';
import { registerModule } from '../modules';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, getAttribute, lookupSpecial } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { iterStr } from '../strings';
import {
  builtinClass,
  exceptionClassNamed,
  nativeFunction,
  newException,
  None,
  propertyClass,
  pyError,
  typeClass,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../types';
import { PyClass, PyDescriptor, PyError, PyOpaque, type PyValue } from '../values';

const unsupportedOperationClass = new PyClass(
  'UnsupportedOperation',
  [exceptionClassNamed('OSError'), exceptionClassNamed('ValueError')],
  typeClass
);
unsupportedOperationClass.mro = [
  unsupportedOperationClass,
  exceptionClassNamed('OSError'),
  exceptionClassNamed('ValueError'),
  ...exceptionClassNamed('Exception').mro,
];
unsupportedOperationClass.module = 'io';
unsupportedOperationClass.layout = { base: 'exception' };
unsupportedOperationClass.isBaseType = true;
unsupportedOperationClass.construct = exceptionClassNamed('OSError').construct;

function unsupportedOperation(message: string): PyError {
  return new PyError(newException(unsupportedOperationClass, [message]));
}

/** A size argument of read() and readline(): an int, or None or a negative int for no limit. */
function sizeArgument(value: PyValue | undefined): number {
  if (value === undefined || value === None) return -1;
  if (typeof value !== 'bigint' && typeof value !== 'boolean' && lookupSpecial(value, '__index__') === undefined) {
    throw typeError(`argument should be integer or None, not '${typeName(value)}'`);
  }
  return Number(toIndex(value));
}

/** What both kinds of stream share: a position, a closed flag, and methods that read lines of their items. */
interface Stream {
  position: number;
  closed: boolean;
  closedMessage: string;
  length: () => number;
  slice: (start: number, end: number) => PyValue;
  lineEnd: (from: number) => number;
  isEmpty: (value: PyValue) => boolean;
}

function checkOpen(stream: Stream): void {
  if (stream.closed) throw valueError(stream.closedMessage);
}

function readFrom(stream: Stream, size: number): PyValue {
  checkOpen(stream);
  const start = Math.min(stream.position, stream.length());
  const end = size < 0 ? stream.length() : Math.min(stream.length(), start + size);
  stream.position = Math.max(stream.position, end);
  return stream.slice(start, end);
}

function readLineFrom(stream: Stream, size: number): PyValue {
  checkOpen(stream);
  const start = Math.min(stream.position, stream.length());
  let end = stream.lineEnd(start);
  if (size >= 0) end = Math.min(end, start + size);
  stream.position = Math.max(stream.position, end);
  return stream.slice(start, end);
}

function readLinesFrom(stream: Stream, hint: number, length: (line: PyValue) => number): PyValue[] {
  const lines: PyValue[] = [];
  let total = 0;
  for (let line = readLineFrom(stream, -1); !stream.isEmpty(line); line = readLineFrom(stream, -1)) {
    currentRuntime().spend();
    lines.push(line);
    total += length(line);
    if (hint > 0 && total > hint) break;
  }
  return lines;
}

const streamOf = (self: PyValue): Stream => (self as PyOpaque).data as Stream;

/** Defines the methods both StringIO and BytesIO have the same way. */
// code-gauge-allow functionNcss 45 -- One small method per stream operation.
function defineStreamMethods(cls: PyClass, itemsLength: (value: PyValue) => number): void {
  method(cls, 'read', 'expected', 0, 1, (self, [size]) => readFrom(streamOf(self), sizeArgument(size)));
  method(cls, 'readline', 'expected', 0, 1, (self, [size]) => readLineFrom(streamOf(self), sizeArgument(size)));
  method(cls, 'readlines', 'expected', 0, 1, (self, [hint]) =>
    currentRuntime().listOf(readLinesFrom(streamOf(self), sizeArgument(hint), itemsLength))
  );
  method(cls, 'tell', 'none', 0, 0, (self) => {
    const stream = streamOf(self);
    checkOpen(stream);
    return BigInt(stream.position);
  });
  method(cls, 'close', 'none', 0, 0, (self) => {
    streamOf(self).closed = true;
    return None;
  });
  for (const name of ['readable', 'writable', 'seekable']) {
    method(cls, name, 'none', 0, 0, (self) => {
      checkOpen(streamOf(self));
      return true;
    });
  }
  method(cls, 'isatty', 'none', 0, 0, (self) => {
    checkOpen(streamOf(self));
    return false;
  });
  method(cls, 'flush', 'none', 0, 0, (self) => {
    checkOpen(streamOf(self));
    return None;
  });
  method(cls, 'fileno', 'none', 0, 0, () => {
    throw unsupportedOperation('fileno');
  });
  method(cls, 'writelines', 'one', 1, 1, (self, [lines]) => {
    const write = getAttribute(self, 'write');
    for (const line of currentRuntime().toArray(lines)) callValue(write, [line]);
    return None;
  });
  method(cls, '__iter__', 'none', 0, 0, (self) => {
    checkOpen(streamOf(self));
    return self;
  });
  method(cls, '__next__', 'none', 0, 0, (self) => {
    const stream = streamOf(self);
    const line = readLineFrom(stream, -1);
    if (stream.isEmpty(line)) throw pyError('StopIteration');
    return line;
  });
  method(cls, '__enter__', 'none', 0, 0, (self) => {
    checkOpen(streamOf(self));
    return self;
  });
  method(cls, '__exit__', 'expected', 0, Number.POSITIVE_INFINITY, (self) => {
    streamOf(self).closed = true;
    return None;
  });
  method(cls, '__repr__', 'none', 0, 0, (self) => `<_io.${cls.name} object at ${addressOf(self as PyOpaque)}>`);
  getter(cls, 'closed', (self) => streamOf(self).closed);
}

function getter(cls: PyClass, name: string, read: (self: PyValue) => PyValue): void {
  cls.dict.set(
    name,
    new PyDescriptor(
      propertyClass,
      nativeFunction(name, ([self]) => read(self))
    )
  );
}

// StringIO ----------------------------------------------------------------------------------------------------------

interface TextStream extends Stream {
  chars: string[];
  newline: string | undefined;
  /** The kinds of line ending a universal-newline StringIO has translated: 1 for \r, 2 for \n, 4 for \r\n. */
  seen: number;
}

const stringIOClass = builtinClass('StringIO');
stringIOClass.module = '_io';

stringIOClass.construct = (cls, args, kwargs) => {
  checkArgs(
    { qualified: 'StringIO', min: 0, max: 2, style: 'takes', keywords: ['initial_value', 'newline'] },
    args,
    kwargs
  );
  const initial = unbox(argument(args, kwargs, 0, 'initial_value') ?? '');
  const newlineValue = unbox(argument(args, kwargs, 1, 'newline') ?? '\n');
  if (newlineValue !== None && typeof newlineValue !== 'string') {
    throw typeError(`newline must be str or None, not ${typeName(newlineValue)}`);
  }
  const newline = newlineValue === None ? undefined : (newlineValue as string);
  if (newline !== undefined && !['', '\n', '\r', '\r\n'].includes(newline)) {
    throw valueError(`illegal newline value: ${pyRepr(newline)}`);
  }
  if (initial !== None && typeof initial !== 'string') {
    throw typeError(`initial_value must be str or None, not ${typeName(initial)}`);
  }
  const stream: TextStream = {
    chars: [],
    position: 0,
    closed: false,
    closedMessage: 'I/O operation on closed file',
    newline,
    seen: 0,
    length: () => stream.chars.length,
    slice: (start, end) => stream.chars.slice(start, end).join(''),
    lineEnd: (from) => textLineEnd(stream, from),
    isEmpty: (value) => value === '',
  };
  if (typeof initial === 'string') writeText(stream, initial);
  stream.position = 0;
  return new PyOpaque(cls, 'StringIO', stream);
};

/** The index after the line starting at `from`, which ends as the stream's newline mode reads lines. */
// code-gauge-allow functionCognitiveComplexity 19 -- One case per newline mode of StringIO.
function textLineEnd(stream: TextStream, from: number): number {
  const { chars, newline } = stream;
  for (let index = from; index < chars.length; index++) {
    const char = chars[index];
    if (newline === '' && (char === '\n' || char === '\r')) {
      return char === '\r' && chars[index + 1] === '\n' ? index + 2 : index + 1;
    }
    if (newline === '\r\n' && char === '\r' && chars[index + 1] === '\n') return index + 2;
    if ((newline === undefined || newline === '\n') && char === '\n') return index + 1;
    if (newline === '\r' && char === '\r') return index + 1;
  }
  return chars.length;
}

/** Writes text at the position, translating line endings as the newline mode does, and returns its length. */
function writeText(stream: TextStream, text: string): number {
  let translated = text;
  if (stream.newline === undefined) {
    if (/\r\n/.test(text)) stream.seen |= 4;
    if (/\r(?!\n)/.test(text)) stream.seen |= 1;
    if (/(?<!\r)\n/.test(text)) stream.seen |= 2;
    translated = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  } else if (stream.newline === '\r' || stream.newline === '\r\n') {
    translated = text.replaceAll('\n', stream.newline);
  }
  const chars = iterStr(translated);
  currentRuntime().buildString(stream.chars.length + chars.length);
  while (stream.chars.length < stream.position) stream.chars.push('\0');
  stream.chars.splice(stream.position, chars.length, ...chars);
  stream.position += chars.length;
  return iterStr(text).length;
}

defineStreamMethods(stringIOClass, (line) => iterStr(line as string).length);
const textStream = (self: PyValue): TextStream => streamOf(self) as TextStream;

method(stringIOClass, 'write', 'one', 1, 1, (self, [textValue]) => {
  const text = unbox(textValue);
  const stream = textStream(self);
  checkOpen(stream);
  if (typeof text !== 'string') throw typeError(`string argument expected, got '${typeName(text)}'`);
  return BigInt(writeText(stream, text));
});
method(stringIOClass, 'getvalue', 'none', 0, 0, (self) => {
  const stream = textStream(self);
  checkOpen(stream);
  return stream.chars.join('');
});
method(stringIOClass, 'seek', 'expected', 1, 2, (self, [positionValue, whenceValue]) => {
  const stream = textStream(self);
  checkOpen(stream);
  const position = Number(toIndex(positionValue));
  const whence = Number(toIndex(whenceValue ?? 0n));
  if (whence < 0 || whence > 2) throw valueError(`Invalid whence (${whence}, should be 0, 1 or 2)`);
  if (whence === 0 && position < 0) throw valueError(`Negative seek position ${position}`);
  if (whence !== 0 && position !== 0) {
    throw new PyError(newException(exceptionClassNamed('OSError'), ["Can't do nonzero cur-relative seeks"]));
  }
  if (whence === 0) stream.position = position;
  else if (whence === 2) stream.position = stream.chars.length;
  return BigInt(stream.position);
});
method(stringIOClass, 'truncate', 'expected', 0, 1, (self, [sizeValue]) => {
  const stream = textStream(self);
  checkOpen(stream);
  const size = sizeValue === undefined || sizeValue === None ? stream.position : Number(toIndex(sizeValue));
  if (size < 0) throw valueError(`Negative size value ${size}`);
  if (size < stream.chars.length) stream.chars.length = size;
  return BigInt(size);
});
getter(stringIOClass, 'newlines', (self) => {
  const names = ['\r', '\n', '\r\n'].filter((_, index) => textStream(self).seen & (1 << index));
  if (names.length === 0) return None;
  return names.length === 1 ? names[0] : currentRuntime().tuple(names);
});
getter(stringIOClass, 'line_buffering', () => false);
getter(stringIOClass, 'encoding', () => None);
getter(stringIOClass, 'errors', () => None);

// BytesIO -----------------------------------------------------------------------------------------------------------

interface BinaryStream extends Stream {
  buffer: PyBytes;
}

const bytesIOClass = builtinClass('BytesIO');
bytesIOClass.module = '_io';

bytesIOClass.construct = (cls, args, kwargs) => {
  checkArgs({ qualified: 'BytesIO', min: 0, max: 1, style: 'takes', keywords: ['initial_bytes'] }, args, kwargs);
  const initial = argument(args, kwargs, 0, 'initial_bytes') ?? None;
  const data = initial === None ? new Uint8Array(0) : bytesLikeData(initial);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(initial)}'`);
  const stream: BinaryStream = {
    buffer: newByteArray(new Uint8Array(data)),
    position: 0,
    closed: false,
    closedMessage: 'I/O operation on closed file.',
    length: () => stream.buffer.length,
    slice: (start, end) => newBytes(stream.buffer.data.slice(start, end)),
    lineEnd: (from) => {
      const index = stream.buffer.data.indexOf(0x0a, from);
      return index === -1 ? stream.buffer.length : index + 1;
    },
    isEmpty: (value) => (value as PyBytes).length === 0,
  };
  return new PyOpaque(cls, 'BytesIO', stream);
};

defineStreamMethods(bytesIOClass, (line) => (line as PyBytes).length);
const binaryStream = (self: PyValue): BinaryStream => streamOf(self) as BinaryStream;

method(bytesIOClass, 'write', 'one', 1, 1, (self, [value]) => {
  const stream = binaryStream(self);
  checkOpen(stream);
  const data = bytesLikeData(value);
  if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
  stream.buffer.checkNoExports();
  const { buffer, position } = stream;
  if (buffer.length < position) buffer.splice(buffer.length, buffer.length, new Uint8Array(position - buffer.length));
  buffer.splice(position, Math.min(buffer.length, position + data.length), new Uint8Array(data));
  stream.position += data.length;
  return BigInt(data.length);
});
method(bytesIOClass, 'read1', 'expected', 0, 1, (self, [size]) => readFrom(binaryStream(self), sizeArgument(size)));
method(bytesIOClass, 'readinto', 'one', 1, 1, (self, [target]) => {
  const stream = binaryStream(self);
  if (!(target instanceof PyBytes) || !target.isMutable) {
    throw typeError(`readinto() argument must be read-write bytes-like object, not ${typeName(target)}`);
  }
  const data = readFrom(stream, target.length) as PyBytes;
  target.data.set(data.data);
  return BigInt(data.length);
});
method(bytesIOClass, 'getvalue', 'none', 0, 0, (self) => {
  const stream = binaryStream(self);
  checkOpen(stream);
  return newBytes(new Uint8Array(stream.buffer.data));
});
method(bytesIOClass, 'getbuffer', 'none', 0, 0, (self) => {
  const stream = binaryStream(self);
  checkOpen(stream);
  return viewOf(stream.buffer);
});
method(bytesIOClass, 'seek', 'expected', 1, 2, (self, [positionValue, whenceValue]) => {
  const stream = binaryStream(self);
  checkOpen(stream);
  let position = Number(toIndex(positionValue));
  const whence = Number(toIndex(whenceValue ?? 0n));
  if (whence < 0 || whence > 2) throw valueError(`invalid whence (${whence}, should be 0, 1 or 2)`);
  if (whence === 0 && position < 0) throw valueError(`negative seek value ${position}`);
  if (whence === 1) position += stream.position;
  if (whence === 2) position += stream.buffer.length;
  stream.position = Math.max(0, position);
  return BigInt(stream.position);
});
method(bytesIOClass, 'truncate', 'expected', 0, 1, (self, [sizeValue]) => {
  const stream = binaryStream(self);
  checkOpen(stream);
  const size = sizeValue === undefined || sizeValue === None ? stream.position : Number(toIndex(sizeValue));
  if (size < 0) throw valueError(`negative size value ${size}`);
  stream.buffer.checkNoExports();
  if (size < stream.buffer.length) stream.buffer.splice(size, stream.buffer.length, new Uint8Array(0));
  return BigInt(size);
});

// The module --------------------------------------------------------------------------------------------------------

const FILE_FEATURE = 'ファイルの読み書き';

registerModule(
  'io',
  () =>
    new Map<string, PyValue>([
      ['StringIO', stringIOClass],
      ['BytesIO', bytesIOClass],
      ['UnsupportedOperation', unsupportedOperationClass],
      ['SEEK_SET', 0n],
      ['SEEK_CUR', 1n],
      ['SEEK_END', 2n],
      ['DEFAULT_BUFFER_SIZE', 131_072n],
    ]),
  Object.fromEntries(
    [
      'open',
      'open_code',
      'FileIO',
      'TextIOWrapper',
      'BufferedReader',
      'BufferedWriter',
      'BufferedRandom',
      'BufferedRWPair',
      'IOBase',
      'RawIOBase',
      'BufferedIOBase',
      'TextIOBase',
      'IncrementalNewlineDecoder',
      'text_encoding',
    ].map((name) => [name, `io.${name}（${FILE_FEATURE}）`])
  )
);
