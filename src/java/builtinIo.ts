import { defineFiles, defineFileTypes } from './builtinFiles';
import { classOf, defineIOInterface, type IOContext, throwsIO } from './builtinIoSupport';
import { defineReaders } from './builtinReaders';
import { defineThrowableIn, stringify } from './builtins';
import { defineScanner } from './builtinScanner';
import { addAbstractMethod, addMethod, newString } from './builtinSupport';
import { defineWriters } from './builtinWriters';
import type { Frame } from './runtime';
import { type ClassInfo, VOID } from './types';
import type { JavaObject, Value } from './values';

/** The classes that read and write standard input, standard output, and files. */
export function defineFileIO(context: IOContext): void {
  defineIOExceptions(context);
  const closeable = defineIOInterface(context, 'Closeable', 'java.io', classOf(context, 'AutoCloseable'));
  throwsIO(context, addAbstractMethod(closeable, 'close', [], VOID));
  const flushable = defineIOInterface(context, 'Flushable', 'java.io');
  throwsIO(context, addAbstractMethod(flushable, 'flush', [], VOID));
  const types = defineFileTypes(context);
  defineReaders(context, closeable);
  defineWriters(context, closeable, flushable);
  defineScanner(context, closeable);
  defineFiles(context, types);
  defineIO(context);
}

/** `System.in`, `System.out`, and `System.err`. */
export function standardStreamsOf(system: ClassInfo): Pick<IOContext, 'systemIn' | 'systemOut' | 'systemErr'> {
  const constantOf = (name: string): JavaObject => system.fields.get(name)?.constant as JavaObject;
  return { systemIn: constantOf('in'), systemOut: constantOf('out'), systemErr: constantOf('err') };
}

function defineIOExceptions(context: IOContext): void {
  const { registry, ioException } = context;
  defineThrowableIn(registry, 'UncheckedIOException', classOf(context, 'RuntimeException'), 'java.io');
  defineThrowableIn(registry, 'InputMismatchException', classOf(context, 'NoSuchElementException'), 'java.util');
  // Their messages name the file, followed by the reason when another exception does not tell it.
  const fileSystemException = defineThrowableIn(registry, 'FileSystemException', ioException, 'java.nio.file');
  for (const name of [
    'NoSuchFileException',
    'FileAlreadyExistsException',
    'DirectoryNotEmptyException',
    'NotDirectoryException',
  ]) {
    defineThrowableIn(registry, name, fileSystemException, 'java.nio.file');
  }
}

/** `IO`, which compact source files use to print and read lines without `System.out` and `System.in`. */
function defineIO({ registry, objectClass, stringType }: IOContext): void {
  const ioClass = registry.define('IO', objectClass);
  for (const [name, suffix] of [
    ['print', ''],
    ['println', '\n'],
  ] as const) {
    addMethod(ioClass, name, [objectClass.type], VOID, true, (frame, _, [value]) => {
      frame.runtime.print(`${stringify(frame, value, objectClass.type)}${suffix}`);
    });
  }
  addMethod(ioClass, 'println', [], VOID, true, (frame) => {
    frame.runtime.print('\n');
  });
  addMethod(ioClass, 'readln', [], stringType, true, readln);
  // The prompt prints without a line break.
  addMethod(ioClass, 'readln', [stringType], stringType, true, (frame, _, [prompt]) => {
    frame.runtime.print(stringify(frame, prompt, stringType));
    return readln(frame);
  });
}

/** `IO.readln`, which returns null at the end of input. */
function readln(frame: Frame): Value {
  const { stdin } = frame.runtime.io;
  const line = stdin.isClosed ? undefined : stdin.reader.readLine();
  return line === undefined ? undefined : newString(frame, line);
}
