import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, currentRuntime, definePackage, fn, namedType, nativeFunction } from '../native';
import { ProgramExit } from '../runtime';
import { BASIC, ERROR_TYPE, pointerTo, sliceOf } from '../types';
import { Cell, GoStruct, Pointer, Slice, type Value } from '../values';
import { EOF, IO_READER, sameError } from './io';
import { bytesOf, callMethod, writeStderr, writeStdout } from './support';

/** `*os.File`, of which this environment has standard output and standard error. */
const FILE = namedType('os', 'File', { kind: 'struct', fields: [] });
const ERR_INVALID = newError('invalid argument');

function write(receiver: Value, bytes: string): Value[] {
  if (!(receiver instanceof Pointer)) return [0n, ERR_INVALID];
  const descriptor = (receiver.load() as GoStruct).native?.descriptor;
  if (descriptor === 1) writeStdout(bytes);
  else if (descriptor === 2) writeStderr(bytes);
  else return [0n, ERR_INVALID];
  return [BigInt(bytes.length), undefined];
}

addMethod(
  FILE,
  'Write',
  fn([sliceOf(BASIC.uint8)], [BASIC.int, ERROR_TYPE]),
  (receiver, [bytes]) => write(receiver, bytesOf(bytes)),
  true
);
addMethod(
  FILE,
  'WriteString',
  fn([BASIC.string], [BASIC.int, ERROR_TYPE]),
  (receiver, [text]) => write(receiver, text as string),
  true
);

/** `ReadFrom`, which bufio.Writer and io.Copy prefer over buffering when the destination is a file. */
addMethod(
  FILE,
  'ReadFrom',
  fn([IO_READER], [BASIC.int64, ERROR_TYPE]),
  (receiver, [reader]) => {
    const size = 32 * 1024;
    currentRuntime().allocate(size);
    const buffer = new Slice(
      Array.from({ length: size }, (): Value => 0n),
      0,
      size,
      size
    );
    let total = 0n;
    for (;;) {
      currentRuntime().spend();
      const [count, readError] = callMethod(reader, 'Read', [buffer]) as [bigint, Value];
      if (count > 0n) {
        const [written, writeError] = write(receiver, bytesOf(buffer).slice(0, Number(count))) as [bigint, Value];
        total += written;
        if (writeError !== undefined) return [total, writeError];
      }
      if (readError !== undefined) return [total, sameError(readError, EOF) ? undefined : readError];
    }
  },
  true
);

const STDOUT = new Pointer(new Cell(new GoStruct([], { descriptor: 1 })), 'v');
const STDERR = new Pointer(new Cell(new GoStruct([], { descriptor: 2 })), 'v');

function fileVariable(name: string, value: Value): Entity {
  return {
    kind: 'var',
    name,
    type: pointerTo(FILE),
    span: { row: 0, column: 0 },
    used: true,
    boxed: false,
    owner: undefined,
    slot: -1,
    library: () => value,
  };
}

const members: Record<string, Entity> = {
  Stdout: fileVariable('Stdout', STDOUT),
  Stderr: fileVariable('Stderr', STDERR),
  Exit: nativeFunction('Exit', fn([BASIC.int], []), ([code]) => {
    throw new ProgramExit(Number(code as bigint));
  }),
};

export const OS_PACKAGE = definePackage('os', members, [
  'Stdin',
  'Args',
  'Open',
  'OpenFile',
  'Create',
  'ReadFile',
  'WriteFile',
  'Remove',
  'RemoveAll',
  'Mkdir',
  'MkdirAll',
  'ReadDir',
  'Getenv',
  'Setenv',
  'LookupEnv',
  'Environ',
  'Getwd',
  'Chdir',
  'Hostname',
  'Getpid',
  'Executable',
  'Stat',
  'Lstat',
  'Rename',
  'TempDir',
  'UserHomeDir',
  'File',
  'FileInfo',
  'FileMode',
  'DirEntry',
  'Process',
  'StartProcess',
  'FindProcess',
  'Signal',
  'Interrupt',
  'Kill',
  'ErrNotExist',
  'ErrExist',
  'ErrPermission',
  'IsNotExist',
  'IsExist',
  'Pipe',
  'Truncate',
  'Chmod',
  'Chown',
  'Link',
  'Symlink',
  'Readlink',
  'DirFS',
  'CopyFS',
  'MkdirTemp',
  'CreateTemp',
  'Getuid',
  'Getgid',
  'ExpandEnv',
  'Expand',
]);
