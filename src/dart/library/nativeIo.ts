import { type FileHandle, FileSystemError, type FileSystemErrorCode, parentOf } from '../../interpreter/programIo';
import type { Runtime } from '../runtime';
import { coreTypes, interfaceType } from '../types';
import type { DartObject, NativeState, Value } from '../values';
import { define, intArg, stringArg, throwUnavailable } from './nativeSupport';

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

/**
 * Rejects a path one of whose ancestors is a file: the OS fails it at the first such ancestor, which the shared file
 * system, resolving the whole path at once, does not name.
 */
function rejectFileAncestor(runtime: Runtime, path: string): void {
  const ends = [...path.replace(/\/+$/u, '').matchAll(/\/+/gu)]
    .map((match) => match.index)
    .filter((index) => index > 0);
  if (ends.some((end) => runtime.io.files.kindOf(path.slice(0, end)) === 'file')) {
    throwUnavailable(runtime, '途中にファイルがあるパスでのファイル操作の失敗');
  }
}

/**
 * Runs a file system operation, turning its failure into the exception dart:io throws, with the path shown: the
 * error code gives the OS error and the exception's class. A failure at a path written as a directory (`a.txt/`) or
 * under a file is rejected, as the OS decides its error from what the shared file system does not tell.
 */
function withFileErrors<T>(runtime: Runtime, failure: string, run: () => T, shownPath?: string): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    const { code: reported, path: errorPath } = error;
    if (/[^/]\/+$/u.test(errorPath)) throwUnavailable(runtime, '末尾が区切り文字のパスでのファイル操作の失敗');
    rejectFileAncestor(runtime, errorPath);
    const [message, errno] = OS_ERRORS[reported];
    const osError = runtime.links.construct(runtime, 'OSError', '', [message, errno]);
    const path = shownPath ?? errorPath;
    if (reported === 'ENOENT') runtime.throwError('PathNotFoundException', '', [path, osError, failure]);
    if (reported === 'EEXIST') runtime.throwError('PathExistsException', '', [path, osError, failure]);
    return runtime.throwError('FileSystemException', '', [failure, path, osError]);
  }
}

function intList(runtime: Runtime, values: number[]): Value {
  return runtime.links.newList(runtime, interfaceType(coreTypes.int), values.map(BigInt), true);
}

/**
 * What Dart's standard input has of its own, the one place it is kept: whether its stream has a listener, and the
 * UTF-8 bytes of the character `readByteSync` has read part of the encoding of. Whether the stream has read the
 * input to its end, after which the VM's descriptor is closed, is the shared StandardInput's isClosed.
 */
interface StdinState {
  isListened: boolean;
  pendingBytes: number[];
}

const stdinStates = new WeakMap<Runtime, StdinState>();

function stdinStateOf(runtime: Runtime): StdinState {
  let state = stdinStates.get(runtime);
  if (!state) {
    state = { isListened: false, pendingBytes: [] };
    stdinStates.set(runtime, state);
  }
  return state;
}

function readOpenStdin(runtime: Runtime): StdinState {
  const state = stdinStateOf(runtime);
  if (!runtime.io.stdin.isClosed) return state;
  const osError = runtime.links.construct(runtime, 'OSError', '', ['Bad file descriptor', 9n]);
  return runtime.throwError('StdinException', '', ['Error reading byte from stdin', osError]);
}

define('Stdin._listen', (runtime) => {
  const state = stdinStateOf(runtime);
  if (state.isListened) runtime.throwError('StateError', '', ['Stream has already been listened to.']);
  state.isListened = true;
  return;
});

define('Stdin._readLine', (runtime, _self, [retainNewlines]) => {
  const state = readOpenStdin(runtime);
  const { reader } = runtime.io.stdin;
  if (state.pendingBytes.length > 0) {
    // The line starts inside the character readByteSync began, which the VM fails to decode, dropping the line.
    state.pendingBytes = [];
    for (let character = reader.read(); character !== undefined && character !== '\n'; character = reader.read()) {
      // Each character of the line is dropped.
    }
    return runtime.throwError('FormatException', '', ['Unexpected extension byte', undefined, 0n]);
  }
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
  const state = readOpenStdin(runtime);
  if (state.pendingBytes.length === 0) {
    const { reader } = runtime.io.stdin;
    let character = reader.read();
    if (character === undefined) return -1n;
    if (/[\uD800-\uDBFF]/u.test(character) && !reader.isAtEnd) character += reader.read() ?? '';
    state.pendingBytes = [...new TextEncoder().encode(character)];
  }
  return BigInt(state.pendingBytes.shift() as number);
});

define('Stdin._readRest', (runtime) => {
  const state = stdinStateOf(runtime);
  runtime.io.stdin.isClosed = true;
  const pending = state.pendingBytes;
  state.pendingBytes = [];
  return intList(runtime, [...pending, ...new TextEncoder().encode(runtime.io.stdin.reader.readRest())]);
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

/** The open file an `_OpenedFile` writes to. */
class SinkFile implements NativeState {
  [key: string]: unknown;

  constructor(readonly handle: FileHandle) {}

  *values(): Iterable<Value> {
    // A file holds no values.
  }
}

define('_OpenedFile._open', (runtime, self, [path, appends]) => {
  const text = stringArg(runtime, path, 'path');
  const handle = withFileErrors(runtime, 'Cannot open file', () =>
    runtime.io.files.open(text, { create: 'always', truncate: appends !== true, append: false })
  );
  if (appends === true) handle.seekToEnd();
  (self as DartObject).native = new SinkFile(handle);
  return;
});

define('_OpenedFile._writeOpened', (_runtime, self, [contents]) => {
  ((self as DartObject).native as SinkFile).handle.write(contents as string);
  return;
});

define('_File._create', (runtime, _self, [path, recursive, exclusive]) => {
  const { files } = runtime.io;
  const text = stringArg(runtime, path, 'path');
  if (recursive === true) {
    rejectFileAncestor(runtime, text);
    withFileErrors(runtime, 'Creation failed', () => files.createDirectory(parentOf(text), true));
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
    files.createDirectory(text, recursive === true);
  });
  return;
});

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
