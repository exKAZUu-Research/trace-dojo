import { type FileHandle as FileWriter, FileSystemError, resolvePath, type TextReader } from '../interpreter/programIo';
import { CONS_CON } from './builtinTypes';
import type { GlobalDef } from './core';
import type { ConInfo } from './entities';
import { cons, NIL, nullary, RunNext, TailCall, unpackString } from './machine';
import { bool, define, forceString, unit } from './primitives';
import type { Runtime } from './runtime';
import { type Dict,ConValue,HaskellException,IOPrim,RefValue,type Slot,Thunk,type Value } from './values';

/** The library's values that primitives and the program's run call: exceptions' values and messages. */
export const ioSupport: {
  maybe?: { nothing: ConInfo; just: ConInfo };
  /** `primException kind message ioType location file`, the exception value of a built-in failure. */
  exception?: GlobalDef;
  /** `primDisplayException`, the message of an exception the program throws. */
  display?: GlobalDef;
  /** `primExitCode`, the code an `ExitCode` exception ends the program with, or -1 for other exceptions. */
  exitCode?: GlobalDef;
} = {};

/** The handles a run has: its standard streams and the files it opened, by the id a file handle holds. */
interface OpenHandle {
  /** The name messages give the handle: `<stdin>`, or the file's path. */
  name: string;
  path?: string;
  reader?: TextReader;
  writer?: FileWriter;
  /** `semiClosed` after `hGetContents`, which reads the rest lazily. */
  state: 'open' | 'semiClosed' | 'closed';
}

interface HandleTable {
  stdin: OpenHandle;
  stdout: OpenHandle;
  stderr: OpenHandle;
  files: Map<number, OpenHandle>;
  nextId: number;
}

const tables = new WeakMap<Runtime, HandleTable>();

function tableOf(runtime: Runtime): HandleTable {
  let table = tables.get(runtime);
  if (!table) {
    table = {
      stdin: { name: '<stdin>', reader: runtime.io.stdin.reader, state: 'open' },
      stdout: { name: '<stdout>', state: 'open' },
      stderr: { name: '<stderr>', state: 'open' },
      files: new Map(),
      nextId: 0,
    };
    tables.set(runtime, table);
  }
  return table;
}

/** The constructors of `Handle` in order: `HandleStdout`, `HandleStderr`, `HandleStdin`, `HandleFile id path`. */
function handleOf(slot: Slot, runtime: Runtime): { entry: OpenHandle; channel?: 'stdout' | 'stderr' } {
  const value = runtime.machine.force(slot) as ConValue;
  const table = tableOf(runtime);
  switch (value.con.tag) {
    case 0: {
      return { entry: table.stdout, channel: 'stdout' };
    }
    case 1: {
      return { entry: table.stderr, channel: 'stderr' };
    }
    case 2: {
      return { entry: table.stdin };
    }
    default: {
      const id = Number(runtime.machine.force(value.fields[0]) as bigint);
      return { entry: table.files.get(id) as OpenHandle };
    }
  }
}

function ioError(type: string, location: string, file: string | undefined, description: string): HaskellException {
  const message = `${file ? `${file}: ` : ''}${location ? `${location}: ` : ''}${IO_ERROR_TEXT[type] ?? 'failed'}${description ? ` (${description})` : ''}`;
  return new HaskellException(message, { kind: 'io', type, location, file, description });
}

const IO_ERROR_TEXT: Record<string, string> = {
  AlreadyExists: 'already exists',
  NoSuchThing: 'does not exist',
  ResourceBusy: 'resource busy',
  EOF: 'end of file',
  IllegalOperation: 'illegal operation',
  PermissionDenied: 'permission denied',
  UserError: 'user error',
  InappropriateType: 'inappropriate type',
  InvalidArgument: 'invalid argument',
};

/** Fails as GHC does for an operation on a handle that is closed or, for reading, semi-closed. */
function checkUsable(entry: OpenHandle, location: string, reading: boolean): void {
  if (entry.state === 'closed') throw ioError('IllegalOperation', location, entry.name, 'handle is closed');
  if (reading && entry.state === 'semiClosed') {
    throw ioError('IllegalOperation', location, entry.name, 'handle is semi-closed');
  }
}

function fileSystemError(error: unknown, location: string, path: string): never {
  if (!(error instanceof FileSystemError)) throw error;
  switch (error.code) {
    case 'ENOENT': {
      throw ioError('NoSuchThing', location, path, 'No such file or directory');
    }
    case 'EISDIR': {
      throw ioError('InappropriateType', location, path, 'is a directory');
    }
    case 'ENOTDIR': {
      throw ioError('InappropriateType', location, path, 'Not a directory');
    }
    default: {
      throw ioError('InvalidArgument', location, path, 'Invalid argument');
    }
  }
}

/**
 * Opens a file. As GHC does, a file open for writing is locked against every other handle, and one open for reading
 * against handles that write.
 */
define('openFile', 2, [], ([pathSlot, modeSlot], runtime) =>
  ioAction('openFile', [pathSlot, modeSlot], () => {
    const path = forceString(pathSlot, runtime);
    const mode = Number(runtime.machine.force(modeSlot) as bigint);
    const table = tableOf(runtime);
    const resolved = resolvePath(path);
    const writing = mode !== 0;
    for (const other of table.files.values()) {
      if (other.state === 'closed' || other.path !== resolved) continue;
      if (writing || other.writer) throw ioError('ResourceBusy', 'openFile', path, 'file is locked');
    }
    const entry: OpenHandle = { name: path, path: resolved, state: 'open' };
    try {
      if (mode === 0) entry.reader = runtime.io.openReader(path);
      else {
        entry.writer = runtime.io.files.open(path, {
          create: 'always',
          truncate: mode === 1,
          append: mode === 2,
        });
        if (mode === 3) entry.reader = runtime.io.openReader(path);
      }
    } catch (error) {
      fileSystemError(error, 'openFile', path);
    }
    const id = table.nextId++;
    table.files.set(id, entry);
    return new ConValue(fileHandleCon as ConInfo, [BigInt(id), pathSlot]);
  })
);

let fileHandleCon: ConInfo | undefined;

/** Registers the library's constructors that primitives build: `Handle`'s file handle and `Maybe`'s. */
export function setIOConstructors(fileHandle: ConInfo, maybe: { nothing: ConInfo; just: ConInfo }): void {
  fileHandleCon = fileHandle;
  ioSupport.maybe = maybe;
}

define('hClose', 1, [], ([handle], runtime) =>
  ioAction('hClose', [handle], () => {
    const { entry } = handleOf(handle, runtime);
    entry.state = 'closed';
    return unit();
  })
);

define('hIsOpen', 1, [], ([handle], runtime) =>
  ioAction('hIsOpen', [handle], () => bool(handleOf(handle, runtime).entry.state === 'open'))
);

define('hPutStr', 2, [], ([handle, text], runtime) =>
  ioAction('hPutStr', [handle, text], () => {
    const { entry, channel } = handleOf(handle, runtime);
    checkUsable(entry, 'hPutStr', false);
    if (channel) writeString(text, runtime, (chunk) => runtime.io[channel].write(chunk));
    else if (entry.writer) {
      const writer = entry.writer;
      writeString(text, runtime, (chunk) => writer.write(chunk));
    } else throw ioError('IllegalOperation', 'hPutStr', entry.name, 'handle is not open for writing');
    return unit();
  })
);

/** Writes a string as it is evaluated, so that what precedes an error in it is still written. */
function writeString(slot: Slot, runtime: Runtime, write: (chunk: string) => void): void {
  let buffer = '';
  try {
    let current = runtime.machine.force(slot) as ConValue;
    while (current.con === CONS_CON) {
      const character = runtime.machine.force(current.fields[0]) as string;
      const codePoint = character.codePointAt(0)!;
      buffer += codePoint >= 0xd8_00 && codePoint <= 0xdf_ff ? '?' : character;
      if (buffer.length >= 256) {
        write(buffer);
        buffer = '';
      }
      current = runtime.machine.force(current.fields[1]) as ConValue;
      runtime.spend();
    }
  } finally {
    write(buffer);
  }
}

function readerOf(entry: OpenHandle, location: string): TextReader {
  checkUsable(entry, location, true);
  if (!entry.reader) throw ioError('IllegalOperation', location, entry.name, 'handle is not open for reading');
  return entry.reader;
}

/** Reads one character, joining a surrogate pair into the code point it encodes. */
function readCharacter(reader: TextReader): string | undefined {
  const first = reader.read();
  if (first === undefined) return undefined;
  const code = first.codePointAt(0) as number;
  if (code >= 0xd8_00 && code <= 0xdb_ff && !reader.isAtEnd) {
    const second = reader.text[reader.position];
    const next = second.codePointAt(0) as number;
    if (next >= 0xdc_00 && next <= 0xdf_ff) {
      reader.position++;
      return first + second;
    }
  }
  return first;
}

define('hGetLine', 1, [], ([handle], runtime) =>
  ioAction('hGetLine', [handle], () => {
    const { entry } = handleOf(handle, runtime);
    const reader = readerOf(entry, 'hGetLine');
    if (reader.isAtEnd) throw ioError('EOF', 'hGetLine', entry.name, '');
    // GHC ends a line at `\n` alone, keeping a `\r` before it.
    const { text } = reader;
    const end = text.indexOf('\n', reader.position);
    const line = text.slice(reader.position, end === -1 ? text.length : end);
    reader.position = end === -1 ? text.length : end + 1;
    runtime.spend(Math.ceil((line.length + 1) / 64));
    return unpackString(line, 0);
  })
);

define('hGetChar', 1, [], ([handle], runtime) =>
  ioAction('hGetChar', [handle], () => {
    const { entry } = handleOf(handle, runtime);
    const character = readCharacter(readerOf(entry, 'hGetChar'));
    if (character === undefined) throw ioError('EOF', 'hGetChar', entry.name, '');
    return character;
  })
);

define('hIsEOF', 1, [], ([handle], runtime) =>
  ioAction('hIsEOF', [handle], () => {
    const { entry } = handleOf(handle, runtime);
    return bool(readerOf(entry, 'hIsEOF').isAtEnd);
  })
);

/**
 * Reads the rest of a handle lazily, as GHC's `hGetContents` does: the handle is semi-closed until the string's end
 * is reached, which closes it; closing it earlier makes reading further fail.
 */
define('hGetContents', 1, [], ([handle], runtime) =>
  ioAction('hGetContents', [handle], () => {
    const { entry } = handleOf(handle, runtime);
    const reader = readerOf(entry, 'hGetContents');
    entry.state = 'semiClosed';
    return lazyContents(entry, reader, runtime);
  })
);

function lazyContents(entry: OpenHandle, reader: TextReader, runtime: Runtime): Value {
  if (entry.state === 'closed') {
    throw ioError('IllegalOperation', 'hGetContents', entry.name, 'delayed read on closed handle');
  }
  runtime.spend();
  const character = readCharacter(reader);
  if (character === undefined) {
    entry.state = 'closed';
    return NIL();
  }
  return cons(character, new Thunk(undefined, undefined, () => lazyContents(entry, reader, runtime)));
}

// Exceptions

define('throwSome', 1, [], ([exception]) => {
  throw new HaskellException('', { kind: 'value', value: exception });
});

/** Runs an action, and if an exception escapes it, the handler with the exception's value. */
define('catchSome', 2, [], ([action, handler], runtime) =>
  ioAction('catch', [action, handler], () => {
    try {
      return runtime.machine.runIOValue(action);
    } catch (error) {
      if (!(error instanceof HaskellException)) throw error;
      const exception = exceptionValue(error, runtime);
      return new RunNext(
        new Thunk(undefined, undefined, () => new TailCall(runtime.machine.force(handler), [exception]))
      );
    }
  })
);

/** The `SomeException` value of an exception: the one the program threw, or one for a built-in failure. */
export function exceptionValue(error: HaskellException, runtime: Runtime): Slot {
  const { cause } = error;
  if (cause?.kind === 'value') return cause.value;
  const strings =
    cause?.kind === 'io'
      ? ['io', cause.description, cause.type, cause.location, cause.file ?? '']
      : [cause?.kind ?? 'error', error.display, '', '', ''];
  return new Thunk(
    undefined,
    undefined,
    () =>
      new TailCall(
        runtime.machine.force(runtime.global(ioSupport.exception as GlobalDef)),
        strings.map((text) => unpackString(text, 0))
      )
  );
}

/** Casts an exception to another type when its `Exception` instance is that type's. */
define('castException', 3, [0, 1], ([from, to, value], runtime) => {
  const maybe = ioSupport.maybe as { nothing: ConInfo; just: ConInfo };
  const same = (runtime.machine.force(from) as Dict).instance === (runtime.machine.force(to) as Dict).instance;
  return same ? new ConValue(maybe.just, [value]) : nullary(maybe.nothing);
});

// Mutable references and the ST monad

define('newIORef', 1, [], ([value]) => ioAction('newIORef', [value], () => new RefValue(value)));
define('readIORef', 1, [], ([ref], runtime) =>
  ioAction('readIORef', [ref], () => (runtime.machine.force(ref) as RefValue).value)
);
define('writeIORef', 2, [], ([ref, value], runtime) =>
  ioAction('writeIORef', [ref, value], () => {
    (runtime.machine.force(ref) as RefValue).value = value;
    return unit();
  })
);
define('sameRef', 2, 'all', ([a, b]) => bool(a === b));

/** Defers an action until its result is used, as `unsafeInterleaveIO` does for `fixIO`. */
define('interleaveIO', 1, [], ([action], runtime) =>
  ioAction(
    'unsafeInterleaveIO',
    [action],
    () => new Thunk(undefined, undefined, () => runtime.machine.runIOValue(action))
  )
);

/** Runs an action whose effects only its own references see, as `runST` does. */
define('runIOPure', 1, [], ([action], runtime) => runtime.machine.runIOValue(action));

// Debugging

define('trace', 2, [], ([message, value], runtime) => {
  writeString(message, runtime, (chunk) => runtime.io.stderr.write(chunk));
  runtime.io.stderr.write('\n');
  return value;
});

function ioAction(name: string, refs: Slot[], run: () => Slot | RunNext): IOPrim {
  return new IOPrim(name, run, refs);
}
