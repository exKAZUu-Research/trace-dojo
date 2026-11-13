import { linkOverrides } from './builtinCollectionSupport';
import {
  BUFFER_SIZE,
  bufferedEncoderSink,
  BufferedWriterSink,
  classOf,
  classType,
  DirectSink,
  EncoderSink,
  fileSink,
  type IOContext,
  openFileWriter,
  type Sink,
  sinkOf,
  standardSink,
  throwsIO,
  type WriteKind,
  writeSinks,
} from './builtinIoSupport';
import { withLocaleFirst } from './builtinLocale';
import { definePrintMethods } from './builtinPrint';
import { defineFileOpeners } from './builtinReaders';
import { standardChannelOf } from './builtins';
import { addConstructor, addInterface, addMethod, newString } from './builtinSupport';
import { charSequenceText, definePrintf } from './builtinText';
import { type Frame, JavaThrow, throwBuiltin } from './runtime';
import {
  BOOLEAN,
  CHAR,
  type ClassInfo,
  INT,
  isSubclass,
  type JavaType,
  type MethodInfo,
  type NativeMethod,
  VOID,
} from './types';
import { charToString, JavaArray, type JavaObject, JavaString, type Value } from './values';

const CHAR_ARRAY: JavaType = { kind: 'array', element: CHAR };

/** `System.out`'s byte writes, `FileOutputStream`, and the writers of `java.io`, which write to the streams and files. */
export function defineWriters(context: IOContext, closeable: ClassInfo, flushable: ClassInfo): void {
  const outputStream = classOf(context, 'OutputStream');
  for (const parent of [closeable, flushable]) {
    outputStream.interfaces.push(parent);
    outputStream.supertypes.push(classType(parent));
  }
  for (const stream of [context.systemOut, context.systemErr]) writeSinks.set(stream, standardSink(stream));
  defineOutputStreams(context, outputStream);
  const writer = context.registry.define('Writer', context.objectClass, 'java.io');
  writer.isAbstract = true;
  for (const parent of [closeable, flushable]) {
    writer.interfaces.push(parent);
    writer.supertypes.push(classType(parent));
  }
  defineWriterMethods(writer, context, (method) => throwsIO(context, method), sinkWrite, true);
  const appendable = classOf(context, 'Appendable');
  addInterface(writer, classType(appendable));
  linkOverrides(writer);
  const outputStreamWriter = context.registry.define('OutputStreamWriter', writer, 'java.io');
  addConstructor(outputStreamWriter, [outputStream.type], (frame, receiver, [stream]) => {
    writeSinks.set(receiver as JavaObject, new EncoderSink(sinkOf(frame, stream)));
  });
  const fileWriter = context.registry.define('FileWriter', outputStreamWriter, 'java.io');
  defineFileOpeners(
    context,
    fileWriter,
    { takesAppend: true, thrown: context.ioException },
    (frame, receiver, path, append) => {
      const sink = new EncoderSink(fileSink(openFileWriter(frame, path, append)));
      writeSinks.set(receiver as JavaObject, sink);
    }
  );
  defineBufferedWriter(context, writer);
  defineStringWriter(context, writer);
  definePrintWriter(context, writer, outputStream);
}

/** What `write` methods do with the text they are given. */
type WriteText = (frame: Frame, receiver: Value, text: string, kind: WriteKind) => void;

function sinkWrite(frame: Frame, receiver: Value, text: string, kind: WriteKind): void {
  sinkOf(frame, receiver).write(frame, text, kind);
}

/**
 * Defines `write` and `append` on a writer class, and `flush` and `close` with `withFlushAndClose`, each passed to
 * `declare`, which subclasses that narrow the methods' throws clauses redefine.
 */
function defineWriterMethods(
  cls: ClassInfo,
  context: IOContext,
  declare: (method: MethodInfo) => MethodInfo,
  write: WriteText,
  withFlushAndClose: boolean,
  overrides: (name: string, parameterTypes: JavaType[]) => boolean = () => true
): void {
  const { stringType } = context;
  const add = (name: string, parameterTypes: JavaType[], returnType: JavaType, native: NativeMethod): void => {
    if (overrides(name, parameterTypes)) declare(addMethod(cls, name, parameterTypes, returnType, false, native));
  };
  add('write', [INT], VOID, (frame, receiver, [code]) => {
    write(frame, receiver, charToString((code as number) & 0xff_ff), 'char');
  });
  add('write', [stringType], VOID, (frame, receiver, [value]) => {
    if (!(value instanceof JavaString)) throwBuiltin(frame, 'NullPointerException');
    write(frame, receiver, value.value, 'string');
  });
  add('write', [stringType, INT, INT], VOID, (frame, receiver, [value, offset, length]) => {
    if (!(value instanceof JavaString)) throwBuiltin(frame, 'NullPointerException');
    write(frame, receiver, sliceChecked(frame, value.value, offset as number, length as number), 'string');
  });
  add('write', [CHAR_ARRAY], VOID, (frame, receiver, [array]) => {
    if (!(array instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
    write(frame, receiver, charsOf(frame, array), 'chars');
  });
  add('write', [CHAR_ARRAY, INT, INT], VOID, (frame, receiver, [array, offset, length]) => {
    if (!(array instanceof JavaArray)) throwBuiltin(frame, 'NullPointerException');
    write(frame, receiver, sliceChecked(frame, charsOf(frame, array), offset as number, length as number), 'chars');
  });
  defineAppends(classOf(context, 'CharSequence'), cls.type, add, write);
  if (!withFlushAndClose) return;
  add('flush', [], VOID, (frame, receiver) => {
    sinkOf(frame, receiver).flush(frame);
  });
  add('close', [], VOID, (frame, receiver) => {
    sinkOf(frame, receiver).close(frame);
  });
}

/** The `append` methods of `Appendable`, which write a char or a `CharSequence` and return the writer. */
function defineAppends(
  charSequence: ClassInfo,
  writerType: JavaType,
  add: (name: string, parameterTypes: JavaType[], returnType: JavaType, native: NativeMethod) => void,
  write: WriteText
): void {
  add('append', [CHAR], writerType, (frame, receiver, [code]) => {
    write(frame, receiver, charToString(code as number), 'char');
    return receiver;
  });
  add('append', [charSequence.type], writerType, (frame, receiver, [value]) => {
    write(frame, receiver, charSequenceText(frame, value), 'string');
    return receiver;
  });
  add('append', [charSequence.type, INT, INT], writerType, (frame, receiver, [value, start, end]) => {
    const sequence = value ?? new JavaString('null');
    const part = frame.runtime.invokeVirtual(frame, charSequence, 'subSequence', sequence, [start, end]);
    write(frame, receiver, charSequenceText(frame, part), 'string');
    return receiver;
  });
}

function sliceChecked(frame: Frame, text: string, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > text.length) throwBuiltin(frame, 'IndexOutOfBoundsException');
  return text.slice(offset, offset + length);
}

function charsOf(frame: Frame, array: JavaArray): string {
  frame.runtime.scanString(array.values.length);
  return array.values.map((code) => charToString(code as number)).join('');
}

/** The decoders of the UTF-8 bytes written to output streams, which hold the bytes of a partly written character. */
const decoders = new WeakMap<object, TextDecoder>();

function defineOutputStreams(context: IOContext, outputStream: ClassInfo): void {
  const writeByte = (frame: Frame, receiver: Value, byte: number): void => {
    const key =
      receiver === context.systemOut || receiver === context.systemErr ? standardChannelOf(frame, receiver) : receiver;
    let decoder = decoders.get(key as object);
    if (!decoder) {
      decoder = new TextDecoder();
      decoders.set(key as object, decoder);
    }
    const text = decoder.decode(new Uint8Array([byte & 0xff]), { stream: true });
    if (text) sinkOf(frame, receiver).write(frame, text);
  };
  throwsIO(
    context,
    addMethod(outputStream, 'write', [INT], VOID, false, (frame, receiver, [byte]) => {
      writeByte(frame, receiver, byte as number);
    })
  );
  for (const name of ['flush', 'close'] as const) {
    throwsIO(
      context,
      addMethod(outputStream, name, [], VOID, false, (frame, receiver) => {
        sinkOf(frame, receiver)[name](frame);
      })
    );
  }
  // PrintStream's methods throw no IOException.
  const printStream = classOf(context, 'PrintStream');
  addMethod(printStream, 'write', [INT], VOID, false, (frame, receiver, [byte]) => {
    writeByte(frame, receiver, byte as number);
  });
  for (const name of ['flush', 'close'] as const) {
    addMethod(printStream, name, [], VOID, false, (frame, receiver) => {
      sinkOf(frame, receiver)[name](frame);
    });
  }
  // PrintStream implements Appendable, its append methods printing as print(String) does.
  const print = printStream.methods.find(
    (method) => method.name === 'print' && method.parameterTypes[0] === context.stringType
  )?.native as NativeMethod;
  defineAppends(
    classOf(context, 'CharSequence'),
    printStream.type,
    (name, parameterTypes, returnType, native) => {
      addMethod(printStream, name, parameterTypes, returnType, false, native);
    },
    (frame, receiver, text) => {
      print(frame, receiver, [new JavaString(text)]);
    }
  );
  addInterface(printStream, classType(classOf(context, 'Appendable')));
  linkOverrides(printStream);
  const fileOutputStream = context.registry.define('FileOutputStream', outputStream, 'java.io');
  defineFileOpeners(
    context,
    fileOutputStream,
    { takesAppend: true, thrown: classOf(context, 'FileNotFoundException') },
    (frame, receiver, path, append) => {
      writeSinks.set(receiver as JavaObject, new DirectSink(fileSink(openFileWriter(frame, path, append))));
    }
  );
}

class StringSink implements Sink {
  text = '';

  /** Grows the text as a `StringBuffer` does, within the length of one string. */
  write(frame: Frame, text: string): void {
    frame.runtime.allocateString(frame, this.text.length + text.length, text.length);
    this.text += text;
  }

  flush(): void {}

  /** Closing a `StringWriter` has no effect. */
  close(): void {}
}

function defineStringWriter(context: IOContext, writer: ClassInfo): void {
  const stringWriter = context.registry.define('StringWriter', writer, 'java.io');
  addConstructor(stringWriter, [], (_, receiver) => {
    writeSinks.set(receiver as JavaObject, new StringSink());
  });
  // StringWriter overrides its writes and flush without IOException, though not write(char[]) or close.
  defineWriterMethods(
    stringWriter,
    context,
    (method) => method,
    sinkWrite,
    false,
    (name, parameterTypes) => name !== 'write' || parameterTypes.length !== 1 || parameterTypes[0].kind !== 'array'
  );
  addMethod(stringWriter, 'flush', [], VOID, false, () => {});
  addMethod(stringWriter, 'toString', [], context.stringType, false, (frame, receiver) =>
    newString(frame, (writeSinks.get(receiver as JavaObject) as StringSink).text)
  );
}

function defineBufferedWriter(context: IOContext, writer: ClassInfo): void {
  const bufferedWriter = context.registry.define('BufferedWriter', writer, 'java.io');
  for (const parameterTypes of [[writer.type], [writer.type, INT]]) {
    addConstructor(bufferedWriter, parameterTypes, (frame, receiver, [inner, size]) => {
      if (size !== undefined && (size as number) <= 0) {
        throwBuiltin(frame, 'IllegalArgumentException', 'Buffer size <= 0');
      }
      const sink = new BufferedWriterSink(sinkOf(frame, inner), (size as number | undefined) ?? BUFFER_SIZE);
      writeSinks.set(receiver as JavaObject, sink);
    });
  }
  throwsIO(
    context,
    addMethod(bufferedWriter, 'newLine', [], VOID, false, (frame, receiver) => {
      sinkOf(frame, receiver).write(frame, '\n');
    })
  );
}

/** Whether a `PrintWriter` flushes on `println`, `printf`, and `format`, and whether writing it has failed. */
interface PrintWriterState {
  autoFlush: boolean;
  hasError: boolean;
  /** Whether the program closed it, after which `checkError` no longer flushes. */
  isClosed: boolean;
}

const printWriterStates = new WeakMap<JavaObject, PrintWriterState>();

function definePrintWriter(context: IOContext, writer: ClassInfo, outputStream: ClassInfo): void {
  const printWriter = context.registry.define('PrintWriter', writer, 'java.io');
  definePrintWriterConstructors(context, printWriter, writer, outputStream);
  defineWriterMethods(
    printWriter,
    context,
    (method) => method,
    (frame, receiver, text, kind) => printTo(frame, receiver, text, false, kind),
    false
  );
  addMethod(printWriter, 'flush', [], VOID, false, (frame, receiver) => {
    guarded(frame, receiver, (sink) => sink.flush(frame));
  });
  addMethod(printWriter, 'close', [], VOID, false, (frame, receiver) => {
    guarded(frame, receiver, (sink) => sink.close(frame));
    (printWriterStates.get(receiver as JavaObject) as PrintWriterState).isClosed = true;
  });
  addMethod(printWriter, 'checkError', [], BOOLEAN, false, (frame, receiver) => {
    const state = printWriterStates.get(receiver as JavaObject) as PrintWriterState;
    if (!state.isClosed) guarded(frame, receiver, (sink) => sink.flush(frame));
    return state.hasError;
  });
  definePrintMethods(printWriter, context.stringType, context.objectClass.type, printTo);
  definePrintf(printWriter, context.stringType, context.objectClass.type, printTo);
  const locale = classOf(context, 'Locale');
  for (const name of ['printf', 'format']) withLocaleFirst(printWriter, name, locale.type, false);
}

function definePrintWriterConstructors(
  context: IOContext,
  printWriter: ClassInfo,
  writer: ClassInfo,
  outputStream: ClassInfo
): void {
  for (const parameterTypes of [[writer.type], [writer.type, BOOLEAN]]) {
    addConstructor(printWriter, parameterTypes, (frame, receiver, [inner, autoFlush]) => {
      startPrinting(receiver, new DirectSink(sinkOf(frame, inner)), autoFlush);
    });
  }
  // A PrintWriter of a stream encodes through a buffered writer, as Java's does.
  for (const parameterTypes of [[outputStream.type], [outputStream.type, BOOLEAN]]) {
    addConstructor(printWriter, parameterTypes, (frame, receiver, [stream, autoFlush]) => {
      startPrinting(receiver, bufferedEncoderSink(sinkOf(frame, stream)), autoFlush);
    });
  }
  defineFileOpeners(
    context,
    printWriter,
    { takesAppend: false, thrown: classOf(context, 'FileNotFoundException') },
    (frame, receiver, path) => {
      const sink = bufferedEncoderSink(fileSink(openFileWriter(frame, path, false)));
      startPrinting(receiver, sink, false);
    }
  );
}

function startPrinting(receiver: Value, sink: Sink, autoFlush: Value): void {
  writeSinks.set(receiver as JavaObject, sink);
  printWriterStates.set(receiver as JavaObject, { autoFlush: autoFlush === true, hasError: false, isClosed: false });
}

function printTo(frame: Frame, receiver: Value, text: string, isLine: boolean, kind: WriteKind = 'string'): void {
  guarded(frame, receiver, (sink) => {
    sink.write(frame, text, kind);
    if (isLine && printWriterStates.get(receiver as JavaObject)?.autoFlush) sink.flush(frame);
  });
}

/** Runs a PrintWriter's call, which catches the IOException of a closed or failed writer for `checkError`. */
function guarded(frame: Frame, receiver: Value, run: (sink: Sink) => void): void {
  const state = printWriterStates.get(receiver as JavaObject) as PrintWriterState;
  try {
    run(sinkOf(frame, receiver));
  } catch (error) {
    const ioException = frame.runtime.builtins.classes.get('IOException') as ClassInfo;
    if (!(error instanceof JavaThrow) || !isSubclass(error.value.cls, ioException)) throw error;
    state.hasError = true;
  }
}
