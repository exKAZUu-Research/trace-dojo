import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, definePackage, fn, namedType, nativeFunction } from '../native';
import { ProgramExit } from '../runtime';
import { BASIC, ERROR_TYPE, pointerTo, sliceOf } from '../types';
import { Cell, GoStruct, Pointer, type Value } from '../values';
import { bytesOf, writeStderr, writeStdout } from './support';

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
