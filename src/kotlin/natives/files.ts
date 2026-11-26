import { encodeJvmText, type FileHandle, FileSystemError, type TextReader } from '../../interpreter/programIo';
import { normalizeSlashes, parentPathOf } from '../../java/builtinIoSupport';
import { stringHash, stringOf } from '../format';
import { type Frame, ProgramExit } from '../runtime';
import { KObject, NULL, type Value } from '../values';
import { BufferedFileWriter } from './fileWriters';
import { defineNative, defineNativeProperty, libraryClass, newItems, throwError } from './registry';

// The host's clocks, as the Java interpreter's System gives them.
defineNative('java.lang.System.currentTimeMillis()', () => BigInt(Date.now()));
defineNative('java.lang.System.nanoTime()', () => BigInt(Math.round(performance.now() * 1_000_000)));

defineNative('kotlin.system.exitProcess(Int)', (_frame, _receiver, [status]) => {
  throw new ProgramExit(status as number);
});

/** The standard input that `readln` and `readLine` read, a line at a time. */
defineNative('kotlin.io.readLine()', (frame) => frame.runtime.io.stdin.reader.readLine() ?? NULL);
defineNative('kotlin.io.readlnOrNull()', (frame) => frame.runtime.io.stdin.reader.readLine() ?? NULL);
defineNative('kotlin.io.readln()', (frame) => {
  const line = frame.runtime.io.stdin.reader.readLine();
  return line ?? throwError(frame, 'kotlin.io.ReadAfterEOFException', 'EOF has already been reached');
});

function pathOf(file: Value): string {
  return (file as KObject).native?.path as string;
}

function newFile(path: string): KObject {
  const file = new KObject(libraryClass('java.io.File'), 0);
  file.native = { path };
  return file;
}

/**
 * A File's path from its parent's and its own, normalized as java.io.File normalizes them, as the Java interpreter
 * does: an empty parent is the root.
 */
function joined(parent: string | undefined, child: string): string {
  if (parent === undefined) return normalizeSlashes(child);
  if (parent === '') return normalizeSlashes(`/${child}`);
  return normalizeSlashes(`${parent}/${child}`);
}

function nameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Rethrows a file system's error as the exception Java's file streams throw, as `a.txt (No such file or directory)`. */
function rethrown(frame: Frame, path: string, error: unknown): never {
  if (!(error instanceof FileSystemError)) throw error;
  const reason =
    error.code === 'EISDIR'
      ? 'Is a directory'
      : error.code === 'ENOTDIR'
        ? 'Not a directory'
        : 'No such file or directory';
  return throwError(frame, 'java.io.FileNotFoundException', `${path} (${reason})`);
}

function writeFile(frame: Frame, path: string, text: string, append: boolean): void {
  try {
    // A lone surrogate encodes as `?` in UTF-8 on the JVM, as the Java interpreter's file sink writes it.
    frame.runtime.io.files.open(path, { create: 'always', truncate: !append, append }).write(encodeJvmText(text));
  } catch (error) {
    rethrown(frame, path, error);
  }
}

function attempt(run: () => void): boolean {
  try {
    run();
    return true;
  } catch (error) {
    if (error instanceof FileSystemError) return false;
    throw error;
  }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

defineNative('java.io.File.<init>(String)', (_frame, receiver, [path]) => {
  (receiver as KObject).native = { path: normalizeSlashes(path as string) };
});
defineNative('java.io.File.<init>(String?, String)', (_frame, receiver, [parent, child]) => {
  (receiver as KObject).native = { path: joined(parent === NULL ? undefined : (parent as string), child as string) };
});
defineNative('java.io.File.<init>(File?, String)', (_frame, receiver, [parent, child]) => {
  (receiver as KObject).native = { path: joined(parent === NULL ? undefined : pathOf(parent), child as string) };
});
defineNativeProperty('java.io.File.name', (_frame, receiver) => nameOf(pathOf(receiver)));
defineNativeProperty('java.io.File.path', (_frame, receiver) => pathOf(receiver));
defineNativeProperty('java.io.File.absolutePath', (_frame, receiver) => {
  const path = pathOf(receiver);
  return path.startsWith('/') ? path : joined('', path);
});
defineNativeProperty('java.io.File.parent', (_frame, receiver) => parentPathOf(pathOf(receiver)) ?? NULL);
defineNativeProperty('java.io.File.parentFile', (_frame, receiver) => {
  const parent = parentPathOf(pathOf(receiver));
  return parent === undefined ? NULL : newFile(parent);
});
defineNativeProperty(
  'java.io.File.isFile',
  (frame, receiver) => frame.runtime.io.files.kindOf(pathOf(receiver)) === 'file'
);
defineNativeProperty(
  'java.io.File.isDirectory',
  (frame, receiver) => frame.runtime.io.files.kindOf(pathOf(receiver)) === 'directory'
);
defineNative(
  'java.io.File.exists()',
  (frame, receiver) => frame.runtime.io.files.kindOf(pathOf(receiver)) !== undefined
);
defineNative('java.io.File.length()', (frame, receiver) => {
  const path = pathOf(receiver);
  return BigInt(frame.runtime.io.files.kindOf(path) === 'file' ? utf8Length(frame.runtime.io.files.readFile(path)) : 0);
});
defineNative('java.io.File.delete()', (frame, receiver) =>
  attempt(() => frame.runtime.io.files.remove(pathOf(receiver)))
);
defineNative('java.io.File.mkdir()', (frame, receiver) =>
  attempt(() => frame.runtime.io.files.createDirectory(pathOf(receiver), false))
);
defineNative('java.io.File.mkdirs()', (frame, receiver) => {
  const { files } = frame.runtime.io;
  if (files.kindOf(pathOf(receiver)) !== undefined) return false;
  return attempt(() => files.createDirectory(pathOf(receiver), true));
});
defineNative('java.io.File.createNewFile()', (frame, receiver) => {
  const path = pathOf(receiver);
  try {
    frame.runtime.io.files.open(path, { create: 'exclusive', truncate: false, append: true });
    return true;
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    if (error.code === 'EEXIST' || error.code === 'EISDIR') return false;
    return throwError(
      frame,
      'java.io.IOException',
      error.code === 'ENOTDIR' ? 'Not a directory' : 'No such file or directory'
    );
  }
});
defineNative('java.io.File.renameTo(File)', (frame, receiver, [dest]) =>
  attempt(() => frame.runtime.io.files.rename(pathOf(receiver), pathOf(dest)))
);
defineNative('java.io.File.list()', (frame, receiver) => {
  const path = pathOf(receiver);
  if (frame.runtime.io.files.kindOf(path) !== 'directory') return NULL;
  return newItems(frame, 'kotlin.Array', frame.runtime.io.files.list(path));
});
defineNative('java.io.File.listFiles()', (frame, receiver) => {
  const path = pathOf(receiver);
  if (frame.runtime.io.files.kindOf(path) !== 'directory') return NULL;
  return newItems(
    frame,
    'kotlin.Array',
    frame.runtime.io.files.list(path).map((name) => newFile(joined(path, name)))
  );
});
defineNative(
  'java.io.File.equals(Any?)',
  (_frame, receiver, [other]) =>
    other instanceof KObject && other.cls === (receiver as KObject).cls && pathOf(other) === pathOf(receiver)
);
// Java's File.hashCode is the path's hash code xored with 1234321 on Unix.
defineNative('java.io.File.hashCode()', (frame, receiver) => stringHash(pathOf(receiver), frame) ^ 1_234_321);
defineNative('java.io.File.toString()', (_frame, receiver) => pathOf(receiver));

defineNative('kotlin.io.File.readText()', (frame, receiver) => {
  const path = pathOf(receiver);
  try {
    return frame.runtime.io.files.readFile(path);
  } catch (error) {
    return rethrown(frame, path, error);
  }
});
defineNative('kotlin.io.File.writeText(String)', (frame, receiver, [text]) => {
  writeFile(frame, pathOf(receiver), text as string, false);
});
defineNative('kotlin.io.File.appendText(String)', (frame, receiver, [text]) => {
  writeFile(frame, pathOf(receiver), text as string, true);
});
defineNative('kotlin.io.File.bufferedReader()', (frame, receiver) => {
  const path = pathOf(receiver);
  let reader: TextReader;
  try {
    reader = frame.runtime.io.openReader(path);
  } catch (error) {
    return rethrown(frame, path, error);
  }
  const value = new KObject(libraryClass('java.io.BufferedReader'), 0);
  value.native = { reader };
  return value;
});

function openWriter(frame: Frame, file: Value, className: string): KObject {
  const path = pathOf(file);
  let handle: FileHandle;
  try {
    handle = frame.runtime.io.files.open(path, { create: 'always', truncate: true, append: false });
  } catch (error) {
    return rethrown(frame, path, error);
  }
  const value = new KObject(libraryClass(className), 0);
  value.native = { writer: new BufferedFileWriter(handle) };
  return value;
}

defineNative('kotlin.io.File.bufferedWriter()', (frame, receiver) =>
  openWriter(frame, receiver, 'java.io.BufferedWriter')
);
defineNative('kotlin.io.File.printWriter()', (frame, receiver) => openWriter(frame, receiver, 'java.io.PrintWriter'));

function readerOf(value: Value): TextReader {
  return (value as KObject).native?.reader as TextReader;
}

function writerOf(value: Value): BufferedFileWriter {
  return (value as KObject).native?.writer as BufferedFileWriter;
}

/** The writer of a `BufferedWriter`, which throws once it is closed, as Java's does. */
function openWriterOf(frame: Frame, value: Value): BufferedFileWriter {
  const writer = writerOf(value);
  return writer.isClosed ? throwError(frame, 'java.io.IOException', 'Stream closed') : writer;
}

/** Runs a `PrintWriter`'s operation, which does nothing once it is closed instead of throwing, as Java's does. */
function printing(frame: Frame, value: Value, run: (writer: BufferedFileWriter) => void): void {
  const writer = writerOf(value);
  if (!writer.isClosed) run(writer);
}

defineNative('java.io.BufferedReader.readLine()', (_frame, receiver) => readerOf(receiver).readLine() ?? NULL);
defineNative('java.io.BufferedReader.read()', (_frame, receiver) => {
  const char = readerOf(receiver).read();
  return char === undefined ? -1 : (char.codePointAt(0) as number);
});
defineNative('java.io.BufferedReader.ready()', (_frame, receiver) => !readerOf(receiver).isAtEnd);
defineNative('java.io.BufferedReader.close()', () => {});
defineNative('java.io.BufferedWriter.write(String)', (frame, receiver, [text]) => {
  openWriterOf(frame, receiver).write(frame, text as string);
});
defineNative('java.io.BufferedWriter.newLine()', (frame, receiver) => {
  openWriterOf(frame, receiver).write(frame, '\n');
});
defineNative('java.io.BufferedWriter.flush()', (frame, receiver) => {
  openWriterOf(frame, receiver).flush(frame);
});
defineNative('java.io.BufferedWriter.close()', (frame, receiver) => {
  writerOf(receiver).close(frame);
});
defineNative('java.io.PrintWriter.print(Any?)', (frame, receiver, [value]) => {
  printing(frame, receiver, (writer) => writer.write(frame, stringOf(frame, value)));
});
defineNative('java.io.PrintWriter.println(Any?)', (frame, receiver, [value]) => {
  printing(frame, receiver, (writer) => {
    writer.write(frame, stringOf(frame, value));
    writer.write(frame, '\n');
  });
});
defineNative('java.io.PrintWriter.println()', (frame, receiver) => {
  printing(frame, receiver, (writer) => writer.write(frame, '\n'));
});
defineNative('java.io.PrintWriter.flush()', (frame, receiver) => {
  printing(frame, receiver, (writer) => writer.flush(frame));
});
defineNative('java.io.PrintWriter.close()', (frame, receiver) => {
  writerOf(receiver).close(frame);
});
