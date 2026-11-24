import { type FileHandle, FileSystemError, type TextReader } from '../../interpreter/programIo';
import { stringHash, stringOf } from '../format';
import type { Frame } from '../runtime';
import { KObject, NULL, type Value } from '../values';
import { defineNative, defineNativeProperty, libraryClass, newItems, throwError } from './registry';

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

/** The path of `child` under `parent`, which Java joins with `/` unless `parent` is empty. */
function joined(parent: string | undefined, child: string): string {
  if (parent === undefined) return child;
  if (parent === '') return `/${child}`;
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`;
}

function nameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function parentOf(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  if (index === -1) return undefined;
  return index === 0 ? '/' : path.slice(0, index);
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
    frame.runtime.io.files.open(path, { create: 'always', truncate: !append, append }).write(text);
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
  (receiver as KObject).native = { path };
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
defineNativeProperty('java.io.File.parent', (_frame, receiver) => parentOf(pathOf(receiver)) ?? NULL);
defineNativeProperty('java.io.File.parentFile', (_frame, receiver) => {
  const parent = parentOf(pathOf(receiver));
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
  value.native = { handle };
  return value;
}

defineNative('kotlin.io.File.bufferedWriter()', (frame, receiver) =>
  openWriter(frame, receiver, 'java.io.BufferedWriter')
);
defineNative('kotlin.io.File.printWriter()', (frame, receiver) => openWriter(frame, receiver, 'java.io.PrintWriter'));

function readerOf(value: Value): TextReader {
  return (value as KObject).native?.reader as TextReader;
}

function handleOf(value: Value): FileHandle {
  return (value as KObject).native?.handle as FileHandle;
}

defineNative('java.io.BufferedReader.readLine()', (_frame, receiver) => readerOf(receiver).readLine() ?? NULL);
defineNative('java.io.BufferedReader.read()', (_frame, receiver) => {
  const char = readerOf(receiver).read();
  return char === undefined ? -1 : (char.codePointAt(0) as number);
});
defineNative('java.io.BufferedReader.ready()', (_frame, receiver) => !readerOf(receiver).isAtEnd);
defineNative('java.io.BufferedReader.close()', () => {});
defineNative('java.io.BufferedWriter.write(String)', (_frame, receiver, [text]) => {
  handleOf(receiver).write(text as string);
});
defineNative('java.io.BufferedWriter.newLine()', (_frame, receiver) => {
  handleOf(receiver).write('\n');
});
defineNative('java.io.BufferedWriter.flush()', () => {});
defineNative('java.io.BufferedWriter.close()', () => {});
defineNative('java.io.PrintWriter.print(Any?)', (frame, receiver, [value]) => {
  handleOf(receiver).write(stringOf(frame, value));
});
defineNative('java.io.PrintWriter.println(Any?)', (frame, receiver, [value]) => {
  handleOf(receiver).write(`${stringOf(frame, value)}\n`);
});
defineNative('java.io.PrintWriter.println()', (_frame, receiver) => {
  handleOf(receiver).write('\n');
});
defineNative('java.io.PrintWriter.flush()', () => {});
defineNative('java.io.PrintWriter.close()', () => {});
