import { type FileHandle, FileSystemError, type FileSystemErrorCode, parentOf } from '../../interpreter/programIo';
import type { Runtime } from '../runtime';
import { coreTypes, interfaceType } from '../types';
import type { DartObject, NativeState, Value } from '../values';
import { define, intArg, stringArg } from './nativeSupport';

/**
 * The OS error the VM reports with each failure, as macOS words and numbers it; Linux numbers ENOTEMPTY 39 instead.
 */
const OS_ERRORS: Record<FileSystemErrorCode, [string, bigint]> = {
  ENOENT: ['No such file or directory', 2n],
  EEXIST: ['File exists', 17n],
  ENOTDIR: ['Not a directory', 20n],
  EISDIR: ['Is a directory', 21n],
  EINVAL: ['Invalid argument', 22n],
  ENOTEMPTY: ['Directory not empty', 66n],
};

/** Runs a file system operation, turning its failure into the exception dart:io throws, with the path shown. */
function withFileErrors<T>(runtime: Runtime, failure: string, run: () => T, shownPath?: string): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    const [message, errno] = OS_ERRORS[error.code];
    const osError = runtime.links.construct(runtime, 'OSError', '', [message, errno]);
    const path = shownPath ?? error.path;
    if (error.code === 'ENOENT') runtime.throwError('PathNotFoundException', '', [path, osError, failure]);
    if (error.code === 'EEXIST') runtime.throwError('PathExistsException', '', [path, osError, failure]);
    return runtime.throwError('FileSystemException', '', [failure, path, osError]);
  }
}

function intList(runtime: Runtime, values: number[]): Value {
  return runtime.links.newList(runtime, interfaceType(coreTypes.int), values.map(BigInt), true);
}

/** The UTF-8 bytes of standard input that `readByteSync` has read part of a character's encoding from. */
const pendingBytes = new WeakMap<Runtime, number[]>();

define('Stdin._readLine', (runtime, _self, [retainNewlines]) => {
  pendingBytes.delete(runtime);
  const { reader } = runtime.io.stdin;
  if (reader.isAtEnd) return;
  let line = '';
  for (let character = reader.read(); character !== undefined; character = reader.read()) {
    if (character === '\n') {
      if (retainNewlines === true) return `${line}\n`;
      return line.endsWith('\r') ? line.slice(0, -1) : line;
    }
    line += character;
  }
  return line;
});

define('Stdin._readByte', (runtime) => {
  let pending = pendingBytes.get(runtime);
  if (!pending?.length) {
    const { reader } = runtime.io.stdin;
    let character = reader.read();
    if (character === undefined) return -1n;
    if (/[\uD800-\uDBFF]/u.test(character) && !reader.isAtEnd) character += reader.read() ?? '';
    pending = [...new TextEncoder().encode(character)];
    pendingBytes.set(runtime, pending);
  }
  return BigInt(pending.shift() as number);
});

define('Stdin._readRest', (runtime) => {
  pendingBytes.delete(runtime);
  return intList(runtime, [...new TextEncoder().encode(runtime.io.stdin.reader.readRest())]);
});

define('_sleep', (runtime, _self, [milliseconds]) => {
  runtime.events.advance(Number(intArg(runtime, milliseconds, 'milliseconds')));
  return;
});

define('FileSystemEntity._kindOf', (runtime, _self, [path]) => {
  const kind = runtime.io.files.kindOf(stringArg(runtime, path, 'path'));
  return kind === 'file' ? 0n : kind === 'directory' ? 1n : 2n;
});

define('FileSystemEntity._isSameFile', (runtime, _self, [path1, path2]) =>
  runtime.io.files.isSameFile(stringArg(runtime, path1, 'path1'), stringArg(runtime, path2, 'path2'))
);

define('_File._read', (runtime, _self, [path, failure]) =>
  withFileErrors(runtime, failure as string, () => runtime.io.files.readFile(stringArg(runtime, path, 'path')))
);

define('_File._write', (runtime, _self, [path, contents, append, failure, shownPath]) => {
  withFileErrors(
    runtime,
    failure as string,
    () =>
      runtime.io.files
        .open(stringArg(runtime, path, 'path'), {
          create: 'always',
          truncate: append !== true,
          append: append === true,
        })
        .write(contents as string),
    shownPath as string | undefined
  );
  return;
});

/** The open file a `_FileSink` writes to. */
class SinkFile implements NativeState {
  [key: string]: unknown;

  constructor(readonly handle: FileHandle) {}

  *values(): Iterable<Value> {
    // A file holds no values.
  }
}

define('_FileSink._open', (runtime, self, [path, appends]) => {
  const text = stringArg(runtime, path, 'path');
  const handle = withFileErrors(runtime, 'Cannot open file', () =>
    runtime.io.files.open(text, { create: 'always', truncate: appends !== true, append: false })
  );
  if (appends === true) handle.seekToEnd();
  (self as DartObject).native = new SinkFile(handle);
  return;
});

define('_FileSink._writeOpened', (_runtime, self, [contents]) => {
  ((self as DartObject).native as SinkFile).handle.write(contents as string);
  return;
});

define('_File._create', (runtime, _self, [path, recursive, exclusive]) => {
  const { files } = runtime.io;
  const text = stringArg(runtime, path, 'path');
  if (recursive === true) {
    withFileErrors(runtime, 'Creation failed', () => {
      rejectFileAncestors(runtime, text, false);
      files.createDirectory(parentOf(text), true);
    });
  }
  withFileErrors(runtime, 'Cannot create file', () =>
    files.open(text, { create: exclusive === true ? 'exclusive' : 'always', truncate: false, append: true })
  );
  return;
});

define('_Directory._createDirectory', (runtime, _self, [path, recursive]) => {
  const { files } = runtime.io;
  const text = stringArg(runtime, path, 'path');
  withFileErrors(runtime, 'Creation failed', () => {
    const kind = files.kindOf(text);
    if (kind === 'directory') return;
    if (kind === 'file') throw new FileSystemError('ENOTDIR', text);
    if (recursive === true) rejectFileAncestors(runtime, text, true);
    files.createDirectory(text, recursive === true);
  });
  return;
});

/**
 * Fails a recursive creation at the first of a path's ancestors that is a file, named as the program spells it, as
 * the SDK's Directory creates the ancestors one by one.
 */
function rejectFileAncestors(runtime: Runtime, path: string, withPath: boolean): void {
  const names = path.split('/');
  for (let count = 1; count < names.length + (withPath ? 1 : 0); count++) {
    const ancestor = names.slice(0, count).join('/');
    if (ancestor !== '' && runtime.io.files.kindOf(ancestor) === 'file') throw new FileSystemError('ENOTDIR', ancestor);
  }
}

define('_Directory._list', (runtime, _self, [path, recursive]) => {
  const { files } = runtime.io;
  const text = stringArg(runtime, path, 'path');
  const entries: string[] = [];
  // The VM lists a directory depth first, each subdirectory's entries right after it.
  const visit = (directory: string, prefix: string): void => {
    for (const name of files.list(directory)) {
      const child = `${directory.endsWith('/') ? directory : `${directory}/`}${name}`;
      const isDirectory = files.kindOf(child) === 'directory';
      entries.push(`${isDirectory ? 'd' : 'f'}:${prefix}${name}`);
      if (isDirectory && recursive === true) visit(child, `${prefix}${name}/`);
    }
  };
  withFileErrors(runtime, 'Directory listing failed', () => visit(text, ''), text.endsWith('/') ? text : `${text}/`);
  return runtime.links.newList(runtime, interfaceType(coreTypes.string), entries, true);
});

define('_rename', (runtime, _self, [from, to, failure]) => {
  const source = stringArg(runtime, from, 'path');
  withFileErrors(
    runtime,
    failure as string,
    () => runtime.io.files.rename(source, stringArg(runtime, to, 'newPath')),
    source
  );
  return;
});

define('_delete', (runtime, _self, [path, isDirectory, recursive, failure]) => {
  const { files } = runtime.io;
  const text = stringArg(runtime, path, 'path');
  const removeTree = (target: string): void => {
    if (files.kindOf(target) === 'directory') {
      for (const name of files.list(target)) removeTree(`${target.endsWith('/') ? target : `${target}/`}${name}`);
    }
    files.remove(target);
  };
  withFileErrors(
    runtime,
    failure as string,
    () => {
      if (recursive === true) removeTree(text);
      else files.remove(text, isDirectory === true ? 'directory' : 'file');
    },
    text
  );
  return;
});
