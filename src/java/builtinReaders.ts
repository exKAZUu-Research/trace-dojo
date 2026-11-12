import type { TextReader } from '../interpreter/programIo';
import {
  classOf,
  classType,
  defineIOInterface,
  filePathOf,
  type IOContext,
  openFileReader,
  readSourceOf,
  readSources,
  STANDARD_INPUT,
  TextSource,
  throwsIO,
} from './builtinIoSupport';
import { createStream } from './builtinStreamSupport';
import { addConstructor, addMethod, newString } from './builtinSupport';
import { type Frame, throwBuiltin } from './runtime';
import { BOOLEAN, CHAR, type ClassInfo, INT, type JavaType, LONG, VOID } from './types';
import { charCodeOf, JavaArray, type JavaObject, JavaString, type Value } from './values';

const CHAR_ARRAY: JavaType = { kind: 'array', element: CHAR };

/** `System.in`, `FileInputStream`, and the readers of `java.io`, which read standard input and files. */
export function defineReaders(context: IOContext, closeable: ClassInfo): void {
  const inputStream = classOf(context, 'InputStream');
  inputStream.interfaces.push(closeable);
  inputStream.supertypes.push(classType(closeable));
  readSources.set(context.systemIn, STANDARD_INPUT);
  defineInputStream(context, inputStream);
  const reader = context.registry.define('Reader', context.objectClass, 'java.io');
  reader.isAbstract = true;
  for (const parent of [defineIOInterface(context, 'Readable', 'java.lang'), closeable]) {
    reader.interfaces.push(parent);
    reader.supertypes.push(classType(parent));
  }
  defineReaderMethods(context, reader);
  const inputStreamReader = context.registry.define('InputStreamReader', reader, 'java.io');
  addConstructor(inputStreamReader, [inputStream.type], (frame, receiver, [stream]) => {
    readSources.set(receiver as JavaObject, readSourceOf(frame, stream));
  });
  const fileReader = context.registry.define('FileReader', inputStreamReader, 'java.io');
  const notFound = { takesAppend: false, thrown: classOf(context, 'FileNotFoundException') };
  defineFileOpeners(context, fileReader, notFound, (frame, receiver, path) => {
    readSources.set(receiver as JavaObject, new TextSource(openFileReader(frame, path)));
  });
  const stringReader = context.registry.define('StringReader', reader, 'java.io');
  addConstructor(stringReader, [context.stringType], (frame, receiver, [text]) => {
    if (!(text instanceof JavaString)) throwBuiltin(frame, 'NullPointerException');
    readSources.set(receiver as JavaObject, new TextSource(frame.runtime.io.textReader(text.value), true));
  });
  // StringReader's close throws no IOException, though its reads still declare one.
  addMethod(stringReader, 'close', [], VOID, false, (frame, receiver) => {
    readSourceOf(frame, receiver).close(frame);
  });
  defineBufferedReader(context, reader);
}

/**
 * Adds the constructors of a class that opens a file by its name or its `File`, and with `takesAppend` also whether
 * to append to it.
 */
export function defineFileOpeners(
  context: IOContext,
  cls: ClassInfo,
  options: { takesAppend: boolean; thrown: ClassInfo },
  open: (frame: Frame, receiver: Value, path: string, append: boolean) => void
): void {
  for (const pathType of [context.stringType, classOf(context, 'File').type]) {
    for (const parameterTypes of options.takesAppend ? [[pathType], [pathType, BOOLEAN]] : [[pathType]]) {
      const constructor = addConstructor(cls, parameterTypes, (frame, receiver, [path, append]) => {
        open(frame, receiver, filePathOf(frame, path), append === true);
      });
      constructor.thrownTypes = [options.thrown];
    }
  }
}

function defineInputStream(context: IOContext, inputStream: ClassInfo): void {
  throwsIO(
    context,
    addMethod(inputStream, 'read', [], INT, false, (frame, receiver) =>
      readByte(readSourceOf(frame, receiver).reader(frame))
    )
  );
  throwsIO(
    context,
    addMethod(inputStream, 'close', [], VOID, false, (frame, receiver) => {
      readSourceOf(frame, receiver).close(frame);
    })
  );
  const fileInputStream = context.registry.define('FileInputStream', inputStream, 'java.io');
  const notFound = { takesAppend: false, thrown: classOf(context, 'FileNotFoundException') };
  defineFileOpeners(context, fileInputStream, notFound, (frame, receiver, path) => {
    readSources.set(receiver as JavaObject, new TextSource(openFileReader(frame, path)));
  });
}

/** The UTF-8 bytes of a code point that a byte read has begun and not yet returned. */
const pendingBytes = new WeakMap<TextReader, number[]>();

const encoder = new TextEncoder();

/** Reads the next byte of the text's UTF-8 encoding, or -1 at its end. */
function readByte(reader: TextReader): number {
  let pending = pendingBytes.get(reader);
  if (!pending || pending.length === 0) {
    const unit = reader.read();
    if (unit === undefined) return -1;
    const next = reader.text[reader.position];
    const isPair = /[\uD800-\uDBFF]/.test(unit) && next !== undefined && /[\uDC00-\uDFFF]/.test(next);
    if (isPair) reader.position++;
    pending = [...encoder.encode(isPair ? `${unit}${next}` : unit.replace(/\p{Cs}/u, '?'))];
    pendingBytes.set(reader, pending);
  }
  return pending.shift() as number;
}

function defineReaderMethods(context: IOContext, reader: ClassInfo): void {
  throwsIO(
    context,
    addMethod(reader, 'read', [], INT, false, (frame, receiver) => readChar(textOf(frame, receiver)))
  );
  throwsIO(
    context,
    addMethod(reader, 'read', [CHAR_ARRAY], INT, false, (frame, receiver, [array]) =>
      readInto(frame, receiver, array, 0, array instanceof JavaArray ? array.values.length : 0)
    )
  );
  throwsIO(
    context,
    addMethod(reader, 'read', [CHAR_ARRAY, INT, INT], INT, false, (frame, receiver, [array, offset, length]) =>
      readInto(frame, receiver, array, offset as number, length as number)
    )
  );
  throwsIO(
    context,
    addMethod(reader, 'ready', [], BOOLEAN, false, (frame, receiver) => readSourceOf(frame, receiver).isReady(frame))
  );
  throwsIO(
    context,
    addMethod(reader, 'skip', [LONG], LONG, false, (frame, receiver, [count]) => {
      if ((count as bigint) < 0n) throwBuiltin(frame, 'IllegalArgumentException', 'skip value is negative');
      const text = textOf(frame, receiver);
      const skipped = Math.min(Number(count as bigint), text.text.length - text.position);
      text.position += skipped;
      frame.runtime.scanString(skipped);
      return BigInt(skipped);
    })
  );
  throwsIO(
    context,
    addMethod(reader, 'close', [], VOID, false, (frame, receiver) => {
      readSourceOf(frame, receiver).close(frame);
    })
  );
}

/** Reads the next UTF-16 code unit as a `char`, or -1 at the end. */
function readChar(reader: TextReader): number {
  const unit = reader.read();
  return unit === undefined ? -1 : charCodeOf(unit, 0);
}

function textOf(frame: Frame, receiver: Value): TextReader {
  return readSourceOf(frame, receiver).reader(frame);
}

/** Reads up to `length` chars into the array from `offset`, returning how many it read, or -1 at the end. */
function readInto(frame: Frame, receiver: Value, array: Value, offset: number, length: number): number {
  if (!(array instanceof JavaArray)) return throwBuiltin(frame, 'NullPointerException');
  if (offset < 0 || length < 0 || offset + length > array.values.length) {
    throwBuiltin(frame, 'IndexOutOfBoundsException');
  }
  const text = textOf(frame, receiver);
  if (length === 0) return 0;
  if (text.isAtEnd) return -1;
  let count = 0;
  for (; count < length && !text.isAtEnd; count++) {
    array.values[offset + count] = readChar(text);
  }
  return count;
}

function defineBufferedReader(context: IOContext, reader: ClassInfo): void {
  const bufferedReader = context.registry.define('BufferedReader', reader, 'java.io');
  for (const parameterTypes of [[reader.type], [reader.type, INT]]) {
    addConstructor(bufferedReader, parameterTypes, (frame, receiver, [inner, size]) => {
      if (size !== undefined && (size as number) <= 0)
        throwBuiltin(frame, 'IllegalArgumentException', 'Buffer size <= 0');
      // Closing either reader closes the other's source, as closing a BufferedReader closes the reader it wraps.
      readSources.set(receiver as JavaObject, readSourceOf(frame, inner));
    });
  }
  throwsIO(
    context,
    addMethod(bufferedReader, 'readLine', [], context.stringType, false, (frame, receiver) => {
      const line = readSourceOf(frame, receiver).reader(frame).readLine();
      return line === undefined ? undefined : newString(frame, line);
    })
  );
  const { stream, streamImpl } = context;
  addMethod(bufferedReader, 'lines', [], classType(stream, context.stringType), false, (frame, receiver) =>
    createStream(
      frame,
      streamImpl,
      function* () {
        const source = readSourceOf(frame, receiver);
        for (let line = source.reader(frame).readLine(); line !== undefined; line = source.reader(frame).readLine()) {
          yield newString(frame, line);
        }
      },
      [receiver]
    )
  );
}
