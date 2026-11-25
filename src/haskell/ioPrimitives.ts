import {
  type FileHandle as FileWriter,
  FileSystemError,
  type OutputChannel,
  resolvePath,
  type TextReader,
} from '../interpreter/programIo';
import type { GlobalDef } from './core';
import type { ConInfo } from './entities';
import { cons, NIL, nullary, RunNext, TailCall, unpackString } from './machine';
import { bool, define, forceString, showSignedInt, unit, writeString } from './primitives';
import type { Runtime } from './runtime';
import { ConValue, type Dict, HaskellException, IOPrim, RefValue, type Slot, Thunk, type Value } from './values';

/** The library's values that primitives and the program's run call: exceptions' values and messages. */
export const ioSupport: {
  maybe?: { nothing: ConInfo; just: ConInfo };
  /** `primException kind message ioType location file`, the exception value of a built-in failure. */
  exception?: GlobalDef;
  /** `primDisplayException`, the message of an exception the program throws. */
  display?: GlobalDef;
  /** `primIsExit`, whether an exception is an `ExitCode`, which ends the program without a message. */
  isExit?: GlobalDef;
} = {};

type BufferMode = { kind: 'NoBuffering' | 'LineBuffering' } | { kind: 'BlockBuffering'; size?: bigint };

/** Where a handle's text goes or comes from; a file open for reading and writing has both a reader and a writer. */
interface HandleStreams {
  output?: OutputChannel;
  reader?: TextReader;
  writer?: FileWriter;
}

/**
 * A handle of a run, one of its standard streams or a file it opened, which decides as GHC's does whether each
 * operation is legal. A handle that both reads and writes has one position, its reader's, which writes advance too.
 */
class Handle {
  /** `semiClosed` after `hGetContents`, which reads the rest lazily. */
  private state: 'open' | 'semiClosed' | 'closed' = 'open';

  constructor(
    /** The name messages give the handle: `<stdin>`, or the file's path as the program gave it. */
    readonly name: string,
    private readonly streams: HandleStreams,
    private buffering: BufferMode,
    /** The absolute path of the file, which `openFile` locks. */
    readonly path?: string
  ) {}

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** Whether `hClose` closed the handle, or a lazy read reached its end; a semi-closed handle is neither open nor closed. */
  get isClosed(): boolean {
    return this.state === 'closed';
  }

  get isWritable(): boolean {
    return this.streams.output !== undefined || this.streams.writer !== undefined;
  }

  close(): void {
    this.state = 'closed';
  }

  getBuffering(): BufferMode {
    this.checkNotClosed('hGetBuffering');
    return this.buffering;
  }

  setBuffering(mode: BufferMode): void {
    this.checkNotClosed('hSetBuffering');
    if (mode.kind === 'BlockBuffering' && mode.size !== undefined && mode.size <= 0n) {
      throw ioError('InvalidArgument', 'hSetBuffering', undefined, `illegal buffer size ${showSignedInt(mode.size)}`);
    }
    this.buffering = mode;
  }

  /** Writes a string as it is evaluated, ending it with a newline only when all of it was written. */
  write(text: Slot, runtime: Runtime, location: string, newline = false): void {
    const sink = this.sink(location);
    writeString(text, runtime, sink);
    if (newline) sink('\n');
  }

  flush(): void {
    this.sink('hFlush');
  }

  readLine(runtime: Runtime): Value {
    const reader = this.reader('hGetLine');
    if (reader.isAtEnd) throw ioError('EOF', 'hGetLine', this.name, '');
    // GHC ends a line at `\n` alone, keeping a `\r` before it.
    const { text } = reader;
    const end = text.indexOf('\n', reader.position);
    const line = text.slice(reader.position, end === -1 ? text.length : end);
    reader.position = end === -1 ? text.length : end + 1;
    runtime.spend(Math.ceil((line.length + 1) / 64));
    return unpackString(line, 0);
  }

  readChar(): string {
    const character = readCharacter(this.reader('hGetChar'));
    if (character === undefined) throw ioError('EOF', 'hGetChar', this.name, '');
    return character;
  }

  isAtEnd(): boolean {
    return this.reader('hIsEOF').isAtEnd;
  }

  /** Whether input is available, which a handle with none left to read answers with GHC's end-of-file error. */
  waitForInput(): boolean {
    if (this.reader('hWaitForInput').isAtEnd) throw ioError('EOF', 'hWaitForInput', this.name, '');
    return true;
  }

  /**
   * Reads the rest lazily, as GHC's `hGetContents` does: the handle is semi-closed until the string's end is reached,
   * which closes it; closing it earlier makes reading further fail.
   */
  readContents(runtime: Runtime): Thunk {
    const reader = this.reader('hGetContents');
    this.state = 'semiClosed';
    // Nothing is read until the string is forced, the first character included.
    return new Thunk(undefined, undefined, () => this.lazyContents(reader, runtime));
  }

  private lazyContents(reader: TextReader, runtime: Runtime): Value {
    runtime.beginEffect();
    if (this.state === 'closed') {
      throw ioError('IllegalOperation', 'hGetContents', this.name, 'delayed read on closed handle');
    }
    runtime.spend();
    const character = readCharacter(reader);
    if (character === undefined) {
      this.state = 'closed';
      return NIL();
    }
    return cons(character, new Thunk(undefined, undefined, () => this.lazyContents(reader, runtime)));
  }

  private sink(location: string): (chunk: string) => void {
    this.checkUsable(location);
    const { output, reader, writer } = this.streams;
    if (output) return (chunk) => output.write(chunk);
    if (!writer) throw ioError('IllegalOperation', location, this.name, 'handle is not open for writing');
    if (!reader) return (chunk) => writer.write(chunk);
    return (chunk) => {
      writer.writeAt(reader.position, chunk);
      reader.position += chunk.length;
    };
  }

  private reader(location: string): TextReader {
    this.checkUsable(location);
    const { reader } = this.streams;
    if (!reader) throw ioError('IllegalOperation', location, this.name, 'handle is not open for reading');
    return reader;
  }

  /** Fails as GHC does for reading or writing a handle that is closed, or semi-closed after `hGetContents`. */
  private checkUsable(location: string): void {
    this.checkNotClosed(location);
    if (this.state === 'semiClosed') throw ioError('IllegalOperation', location, this.name, 'handle is semi-closed');
  }

  private checkNotClosed(location: string): void {
    if (this.state === 'closed') throw ioError('IllegalOperation', location, this.name, 'handle is closed');
  }
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

interface HandleTable {
  stdin: Handle;
  stdout: Handle;
  stderr: Handle;
  /** The files the run opened, by the id their `Handle` value holds. */
  files: Map<number, Handle>;
  nextId: number;
}

const tables = new WeakMap<Runtime, HandleTable>();

function tableOf(runtime: Runtime): HandleTable {
  let table = tables.get(runtime);
  if (!table) {
    const { io } = runtime;
    table = {
      stdin: new Handle('<stdin>', { reader: io.stdin.reader }, { kind: 'LineBuffering' }),
      stdout: new Handle('<stdout>', { output: io.stdout }, { kind: 'LineBuffering' }),
      stderr: new Handle('<stderr>', { output: io.stderr }, { kind: 'NoBuffering' }),
      files: new Map(),
      nextId: 0,
    };
    tables.set(runtime, table);
  }
  return table;
}

/** The constructors of `Handle` in order: `HandleStdout`, `HandleStderr`, `HandleStdin`, `HandleFile id path`. */
function handleOf(slot: Slot, runtime: Runtime): Handle {
  const value = runtime.machine.force(slot) as ConValue;
  const table = tableOf(runtime);
  switch (value.con.tag) {
    case 0: {
      return table.stdout;
    }
    case 1: {
      return table.stderr;
    }
    case 2: {
      return table.stdin;
    }
    default: {
      const id = Number(runtime.machine.force(value.fields[0]) as bigint);
      return table.files.get(id) as Handle;
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
      if (other.isClosed || other.path !== resolved) continue;
      if (writing || other.isWritable) throw ioError('ResourceBusy', 'openFile', path, 'file is locked');
    }
    const id = table.nextId++;
    table.files.set(id, new Handle(path, openStreams(path, mode, runtime), { kind: 'BlockBuffering' }, resolved));
    return new ConValue(fileHandleCon as ConInfo, [BigInt(id), pathSlot]);
  })
);

/** Opens a file's streams for an `IOMode`, given by its constructor's tag. */
function openStreams(path: string, mode: number, runtime: Runtime): HandleStreams {
  try {
    const writer =
      mode === 0
        ? undefined
        : runtime.io.files.open(path, { create: 'always', truncate: mode === 1, append: mode === 2 });
    const reader = mode === 0 || mode === 3 ? runtime.io.openReader(path) : undefined;
    return { reader, writer };
  } catch (error) {
    fileSystemError(error, 'openFile', path);
  }
}

let fileHandleCon: ConInfo | undefined;

/** Registers the library's constructors that primitives build: `Handle`'s file handle and `Maybe`'s. */
export function setIOConstructors(fileHandle: ConInfo, maybe: { nothing: ConInfo; just: ConInfo }): void {
  fileHandleCon = fileHandle;
  ioSupport.maybe = maybe;
}

define('hClose', 1, [], ([handle], runtime) =>
  ioAction('hClose', [handle], () => {
    handleOf(handle, runtime).close();
    return unit();
  })
);

define('hSetBuffering', 2, [], ([handle, mode], runtime) =>
  ioAction('hSetBuffering', [handle, mode], () => {
    const target = handleOf(handle, runtime);
    const value = runtime.machine.force(mode) as ConValue;
    const kind = value.con.name as BufferMode['kind'];
    if (kind !== 'BlockBuffering') target.setBuffering({ kind });
    else {
      const size = runtime.machine.force(value.fields[0]) as ConValue;
      const count = size.con.name === 'Just' ? (runtime.machine.force(size.fields[0]) as bigint) : undefined;
      target.setBuffering({ kind, size: count });
    }
    return unit();
  })
);

/** Gives a handle's `BufferMode`, built with the constructors the library passes. */
define('hGetBuffering', 4, [], ([handle, noBuffering, lineBuffering, blockBuffering], runtime) =>
  ioAction('hGetBuffering', [handle, noBuffering, lineBuffering, blockBuffering], () => {
    const mode = handleOf(handle, runtime).getBuffering();
    if (mode.kind !== 'BlockBuffering') return mode.kind === 'NoBuffering' ? noBuffering : lineBuffering;
    const maybe = ioSupport.maybe as { nothing: ConInfo; just: ConInfo };
    const size = mode.size === undefined ? nullary(maybe.nothing) : new ConValue(maybe.just, [mode.size]);
    return new Thunk(undefined, undefined, () => new TailCall(runtime.machine.force(blockBuffering), [size]));
  })
);

define('hIsOpen', 1, [], ([handle], runtime) =>
  ioAction('hIsOpen', [handle], () => bool(handleOf(handle, runtime).isOpen))
);

define('hIsClosed', 1, [], ([handle], runtime) =>
  ioAction('hIsClosed', [handle], () => bool(handleOf(handle, runtime).isClosed))
);

define('putStr', 1, [], ([text], runtime) =>
  ioAction('putStr', [text], () => {
    tableOf(runtime).stdout.write(text, runtime, 'hPutStr');
    return unit();
  })
);

define('putStrLn', 1, [], ([text], runtime) =>
  ioAction('putStrLn', [text], () => {
    tableOf(runtime).stdout.write(text, runtime, 'hPutStr', true);
    return unit();
  })
);

define('hPutStr', 2, [], ([handle, text], runtime) =>
  ioAction('hPutStr', [handle, text], () => {
    handleOf(handle, runtime).write(text, runtime, 'hPutStr');
    return unit();
  })
);

define('hFlush', 1, [], ([handle], runtime) =>
  ioAction('hFlush', [handle], () => {
    handleOf(handle, runtime).flush();
    return unit();
  })
);

define('hGetLine', 1, [], ([handle], runtime) =>
  ioAction('hGetLine', [handle], () => handleOf(handle, runtime).readLine(runtime))
);

define('hGetChar', 1, [], ([handle], runtime) =>
  ioAction('hGetChar', [handle], () => handleOf(handle, runtime).readChar())
);

define('hWaitForInput', 1, [], ([handle], runtime) =>
  ioAction('hWaitForInput', [handle], () => bool(handleOf(handle, runtime).waitForInput()))
);

define('hIsEOF', 1, [], ([handle], runtime) =>
  ioAction('hIsEOF', [handle], () => bool(handleOf(handle, runtime).isAtEnd()))
);

define('hGetContents', 1, [], ([handle], runtime) =>
  ioAction('hGetContents', [handle], () => handleOf(handle, runtime).readContents(runtime))
);

// Program arguments

/** The arguments `getArgs` gives while `withArgs` runs an action, by run; a run starts with none. */
const programArgs = new WeakMap<Runtime, Slot>();

define('getArgs', 0, [], (_, runtime) => ioAction('getArgs', [], () => programArgs.get(runtime) ?? NIL()));

define('setArgs', 1, [], ([args], runtime) =>
  ioAction('withArgs', [args], () => {
    programArgs.set(runtime, args);
    return unit();
  })
);

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
      : cause?.kind === 'arith'
        ? ['arith', error.display, cause.error, '', '']
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

// Type-level literals, whose evidence is their value, and fields, whose evidence is their selector

define('literalOf', 2, [0], ([value], runtime) => runtime.machine.force(value));
define('applyField', 2, [0], ([selector, record], runtime) => new TailCall(runtime.machine.force(selector), [record]));

// Template Haskell's unique numbers, which newName gives names, counting up through a run.

const uniques = new WeakMap<Runtime, number>();
define('thNewUnique', 1, [], (_, runtime) =>
  ioAction('thNewUnique', [], () => {
    const next = uniques.get(runtime) ?? 0;
    uniques.set(runtime, next + 1);
    return BigInt(next);
  })
);

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
    () =>
      new Thunk(undefined, undefined, () => {
        runtime.beginEffect();
        return runtime.machine.runIOValue(action);
      })
  )
);

/** Runs an action whose effects only its own references see, as `runST` does. */
define('runIOPure', 1, [], ([action], runtime) => runtime.machine.runIOValue(action));

// Debugging

define('trace', 2, [], ([message, value], runtime) => {
  runtime.beginEffect();
  writeString(message, runtime, (chunk) => runtime.io.stderr.write(chunk));
  runtime.io.stderr.write('\n');
  return value;
});

function ioAction(name: string, refs: Slot[], run: () => Slot | RunNext): IOPrim {
  return new IOPrim(name, run, refs);
}
