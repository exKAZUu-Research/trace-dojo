import { defineAttribute } from '../attributeDescriptors';
import { bytesLikeData, newByteArray, newBytes, PyBytes } from '../bytesValues';
import { addressOf, pyRepr } from '../conversions';
import { method } from '../define';
import { builtinClassesWithDict } from '../descriptors';
import { createFileIOClass } from '../inputStream';
import { viewOf } from '../memoryview';
import { argument, checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { callValue, getAttribute, iterate, lookupSpecial } from '../objects';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { iterStr } from '../strings';
import {
  builtinClass,
  classOf,
  defineMethod,
  exceptionClassNamed,
  nativeFunction,
  newException,
  newTuple,
  None,
  propertyClass,
  pyError,
  typeClass,
  typeError,
  typeName,
  unbox,
  valueError,
} from '../types';
import { DONE, PyClass, PyDescriptor, PyError, PyFunction, type PyInstance, PyOpaque, type PyValue } from '../values';
import { unpackKeywords } from './clinicArgs';
import { ioCodecNatives } from './ioCodecs';
import { IO_SOURCE } from './ioPython';
import { defineTextReadline } from './ioTextReadline';

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
    if (hint > 0 && total >= hint) break;
  }
  return lines;
}

const streamOf = (self: PyValue): Stream => (self as PyOpaque).data as Stream;

/** Defines the methods both StringIO and BytesIO have the same way; the others they inherit from `_io._IOBase`. */
function defineStreamMethods(cls: PyClass): void {
  method(cls, 'read', 'expected', 0, 1, (self, [size]) => readFrom(streamOf(self), sizeArgument(size)));
  method(cls, 'readline', 'expected', 0, 1, (self, [size]) => readLineFrom(streamOf(self), sizeArgument(size)));
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
  method(cls, '__next__', 'none', 0, 0, (self) => {
    const stream = streamOf(self);
    // A program's subclass reads its lines with its own readline, as CPython's iternext does for subclasses.
    const line = classOf(self).isBuiltin ? readLineFrom(stream, -1) : callValue(getAttribute(self, 'readline'), []);
    if (stream.isEmpty(line)) throw pyError('StopIteration');
    return line;
  });
  method(cls, '__repr__', 'none', 0, 0, (self) => `<_io.${cls.name} object at ${addressOf(self as PyOpaque)}>`);
  getter(cls, 'closed', (self) => streamOf(self).closed);
}

/** The methods BytesIO has of its own that StringIO inherits from `_io._IOBase`. */
function defineBytesIOLineMethods(cls: PyClass): void {
  method(cls, 'readlines', 'expected', 0, 1, (self, [hint]) =>
    currentRuntime().listOf(readLinesFrom(streamOf(self), sizeArgument(hint), (line) => (line as PyBytes).length))
  );
  method(cls, 'isatty', 'none', 0, 0, (self) => {
    checkOpen(streamOf(self));
    return false;
  });
  method(cls, 'flush', 'none', 0, 0, (self) => {
    checkOpen(streamOf(self));
    return None;
  });
  method(cls, 'writelines', 'one', 1, 1, (self, [lines]) => {
    checkOpen(streamOf(self));
    const write = getAttribute(self, 'write');
    const next = iterate(lines);
    for (let line = next(); line !== DONE; line = next()) callValue(write, [line]);
    return None;
  });
  method(cls, '__iter__', 'none', 0, 0, (self) => {
    checkOpen(streamOf(self));
    return self;
  });
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
  /** The kinds of line ending a universal-newline StringIO has encountered: 1 for \r, 2 for \n, 4 for \r\n. */
  seen: number;
}

const constructStringIO: NonNullable<PyClass['construct']> = (cls, args, kwargs) => {
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
  if (stream.newline === undefined || stream.newline === '') {
    if (/\r\n/.test(text)) stream.seen |= 4;
    if (/\r(?!\n)/.test(text)) stream.seen |= 1;
    if (/(?<!\r)\n/.test(text)) stream.seen |= 2;
    if (stream.newline === undefined) translated = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  } else if (stream.newline === '\r' || stream.newline === '\r\n') {
    translated = text.replaceAll('\n', stream.newline);
  }
  const chars = iterStr(translated);
  if (chars.length === 0) return 0;
  const runtime = currentRuntime();
  const length = Math.max(stream.chars.length, stream.position + chars.length);
  runtime.buildString(length);
  // The stream keeps one array element per character, which only its growth adds.
  runtime.allocate(length - stream.chars.length);
  while (stream.chars.length < stream.position) stream.chars.push('\0');
  // Overwrites in place: splicing in a long text as arguments would exceed the host's argument limit.
  for (const [index, char] of chars.entries()) stream.chars[stream.position + index] = char;
  stream.position += chars.length;
  return iterStr(text).length;
}

const textStream = (self: PyValue): TextStream => streamOf(self) as TextStream;

// code-gauge-allow functionNcss 50 -- One small method per StringIO operation.
// code-gauge-allow functionCognitiveComplexity 25 -- One small method per StringIO operation.
function defineStringIO(cls: PyClass): void {
  cls.module = '_io';
  cls.construct = constructStringIO;
  defineStreamMethods(cls);
  method(cls, 'write', 'one', 1, 1, (self, [textValue]) => {
    const text = unbox(textValue);
    const stream = textStream(self);
    checkOpen(stream);
    if (typeof text !== 'string') throw typeError(`string argument expected, got '${typeName(text)}'`);
    return BigInt(writeText(stream, text));
  });
  method(cls, 'getvalue', 'none', 0, 0, (self) => {
    const stream = textStream(self);
    checkOpen(stream);
    return stream.chars.join('');
  });
  method(cls, 'seek', 'expected', 1, 2, (self, [positionValue, whenceValue]) => {
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
  method(cls, 'truncate', 'expected', 0, 1, (self, [sizeValue]) => {
    const stream = textStream(self);
    checkOpen(stream);
    const size = sizeValue === undefined || sizeValue === None ? stream.position : Number(toIndex(sizeValue));
    if (size < 0) throw valueError(`Negative size value ${size}`);
    if (size < stream.chars.length) stream.chars.length = size;
    return BigInt(size);
  });
  getter(cls, 'newlines', (self) => {
    const names = ['\r', '\n', '\r\n'].filter((_, index) => textStream(self).seen & (1 << index));
    if (names.length === 0) return None;
    return names.length === 1 ? names[0] : currentRuntime().tuple(names);
  });
  getter(cls, 'line_buffering', () => false);
}

// BytesIO -----------------------------------------------------------------------------------------------------------

interface BinaryStream extends Stream {
  buffer: PyBytes;
}

const constructBytesIO: NonNullable<PyClass['construct']> = (cls, args, kwargs) => {
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

const binaryStream = (self: PyValue): BinaryStream => streamOf(self) as BinaryStream;

// code-gauge-allow functionNcss 60 -- One small method per BytesIO operation.
// code-gauge-allow functionCognitiveComplexity 24 -- One small method per BytesIO operation.
function defineBytesIO(cls: PyClass): void {
  cls.module = '_io';
  cls.construct = constructBytesIO;
  defineStreamMethods(cls);
  defineBytesIOLineMethods(cls);
  method(cls, 'write', 'one', 1, 1, (self, [value]) => {
    const stream = binaryStream(self);
    checkOpen(stream);
    const data = bytesLikeData(value);
    if (data === undefined) throw typeError(`a bytes-like object is required, not '${typeName(value)}'`);
    stream.buffer.checkNoExports();
    return BigInt(writeBytes(stream, data));
  });
  method(cls, 'read1', 'expected', 0, 1, (self, [size]) => readFrom(binaryStream(self), sizeArgument(size)));
  method(cls, 'readinto', 'one', 1, 1, (self, [target]) => {
    const stream = binaryStream(self);
    if (!(target instanceof PyBytes) || !target.isMutable) {
      throw typeError(`readinto() argument must be read-write bytes-like object, not ${typeName(target)}`);
    }
    const data = readFrom(stream, target.length) as PyBytes;
    target.data.set(data.data);
    return BigInt(data.length);
  });
  method(cls, 'getvalue', 'none', 0, 0, (self) => {
    const stream = binaryStream(self);
    checkOpen(stream);
    return newBytes(new Uint8Array(stream.buffer.data));
  });
  method(cls, 'getbuffer', 'none', 0, 0, (self) => {
    const stream = binaryStream(self);
    checkOpen(stream);
    return viewOf(stream.buffer);
  });
  method(cls, 'seek', 'expected', 1, 2, (self, [positionValue, whenceValue]) => {
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
  method(cls, 'truncate', 'expected', 0, 1, (self, [sizeValue]) => {
    const stream = binaryStream(self);
    checkOpen(stream);
    const size = sizeValue === undefined || sizeValue === None ? stream.position : Number(toIndex(sizeValue));
    if (size < 0) throw valueError(`negative size value ${size}`);
    stream.buffer.checkNoExports();
    if (size < stream.buffer.length) stream.buffer.splice(size, stream.buffer.length, new Uint8Array(0));
    return BigInt(size);
  });
}

/** Writes bytes at the position, filling a gap past the end with zeros, and returns their number. */
function writeBytes(stream: BinaryStream, data: Uint8Array): number {
  if (data.length === 0) return 0;
  const { buffer, position } = stream;
  if (buffer.length < position) {
    currentRuntime().ensureRoom(Math.ceil((position - buffer.length) / 8));
    buffer.splice(buffer.length, buffer.length, new Uint8Array(position - buffer.length));
  }
  buffer.splice(position, Math.min(buffer.length, position + data.length), new Uint8Array(data));
  stream.position += data.length;
  return data.length;
}

// The module --------------------------------------------------------------------------------------------------------

function clinicInitializer(cls: PyClass): void {
  const initialize = cls.dict.get('__init__');
  if (!(initialize instanceof PyFunction)) return;
  const params = initialize.def.params.slice(1).map(({ name }) => name);
  const required = params.length - initialize.defaults.length;
  const text = cls.name === 'TextIOWrapper';
  defineAttribute(cls, 'closed', (self) => underlyingClosed(self as PyInstance, text));
  if (text) defineTextReadline(cls);
  defineMethod(cls, '__init__', (self, args, kwargs) => {
    unpackKeywords(cls.name, params, required, args, kwargs);
    return callValue(initialize, [self, ...args], kwargs);
  });
}

function underlyingClosed(self: PyInstance, text: boolean): PyValue {
  const stream = self.dict.get(text ? '_buffer' : '_raw');
  if (stream === undefined) {
    if (text) return true;
    throw valueError('I/O operation on uninitialized object');
  }
  if (stream === None) throw valueError(text ? 'underlying buffer has been detached' : 'raw stream has been detached');
  return getAttribute(stream, 'closed');
}

const FILE_FEATURE = 'ファイルの読み書き';

registerSourceModule(
  'io',
  IO_SOURCE,
  () =>
    new Map<string, PyValue>([
      [
        '_stream_classes',
        // StringIO and BytesIO derive from the run's `_io._TextIOBase` and `_io._BufferedIOBase`.
        nativeFunction('_stream_classes', ([textBase, bufferedBase]) => {
          const stringIO = builtinClass('StringIO', textBase as PyClass);
          defineStringIO(stringIO);
          const bytesIO = builtinClass('BytesIO', bufferedBase as PyClass);
          defineBytesIO(bytesIO);
          builtinClassesWithDict.add(stringIO);
          builtinClassesWithDict.add(bytesIO);
          stringIO.typeName = '_io.StringIO';
          bytesIO.typeName = '_io.BytesIO';
          return newTuple([stringIO, bytesIO]);
        }),
      ],
      [
        '_clinic_init',
        nativeFunction('_clinic_init', ([cls]) => {
          clinicInitializer(cls as PyClass);
          return None;
        }),
      ],
      ['UnsupportedOperation', unsupportedOperationClass],
      ['SEEK_SET', 0n],
      ['SEEK_CUR', 1n],
      ['SEEK_END', 2n],
      ['DEFAULT_BUFFER_SIZE', 131_072n],
      ['_file_class', nativeFunction('_file_class', ([base]) => createFileIOClass(currentRuntime(), base as PyClass))],
      ...ioCodecNatives(),
    ]),
  {
    nativeImplementation: true,
    unsupported: Object.fromEntries(['open', 'open_code'].map((name) => [name, `io.${name}（${FILE_FEATURE}）`])),
  }
);
