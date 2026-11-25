import { FileSystemError } from '../../interpreter/programIo';
import type { Frame } from '../runtime';
import { known, mergeErrorSets, type NativeCall, runtime, type SemaApi, type TExpr } from '../semaBase';
import {
  BOOL,
  CONST_U8_SLICE,
  type EnumType,
  errorSetOf,
  type ErrorSetType,
  errorUnionOf,
  fnType,
  type StructField,
  type StructType,
  type Type,
  typeName,
  U32,
  U64,
  VOID,
} from '../types';
import { decodeUtf8 } from '../utf8';
import { ErrorValue, type NativeHandle, type Pointer, Slice, type Value, ZStruct } from '../values';
import { allocatorArg } from './common';
import {
  attempt,
  FILE_SYSTEM_ERROR_NAMES,
  IO_TYPE,
  LIMIT,
  LIMITED_ALLOC_ERROR,
  limitOf,
  ownBytes,
  READ_FAILED,
  ReadError,
  readerValue,
  ReaderView,
  receiverMethod,
  SLICE,
  UNLIMITED,
} from './files';
import { nativeEnum } from './heap';
import { addMembers, compileArgs, expectArgs, fnMember, handle, type Member, nativeStruct, typeMember } from './native';

/** `std.Io.Dir` and the types of `std.Io.File` it returns, over the run's virtual file system. */

// std.Io.File types ----------------------------------------------------------------------------------------------------

export const FILE_OPEN_ERROR: ErrorSetType = errorSetOf([
  'SharingViolation',
  'PipeBusy',
  'NoDevice',
  'PathAlreadyExists',
  'FileNotFound',
  'AccessDenied',
  'PermissionDenied',
  'FileTooBig',
  'IsDir',
  'SymLinkLoop',
  'ProcessFdQuotaExceeded',
  'SystemFdQuotaExceeded',
  'NameTooLong',
  'SystemResources',
  'NoSpaceLeft',
  'NotDir',
  'DeviceBusy',
  'FileLocksUnsupported',
  'FileBusy',
  'WouldBlock',
  'BadPathName',
  'NetworkNotFound',
  'Unexpected',
  'Canceled',
]);

export const FILE_KIND: EnumType = nativeEnum('Io.File.Kind', [
  'block_device',
  'character_device',
  'directory',
  'named_pipe',
  'sym_link',
  'file',
  'unix_domain_socket',
  'whiteout',
  'door',
  'event_port',
  'unknown',
]);

export const FILE_STAT: StructType = nativeStruct('Io.File.Stat', {}, [
  { name: 'size', type: U64, hasDefault: false },
  { name: 'kind', type: FILE_KIND, hasDefault: false },
]);

function kindValue(name: 'directory' | 'file' | 'unknown'): bigint {
  return (FILE_KIND.fields?.find((field) => field.name === name) as { value: bigint }).value;
}

// std.Io.Dir ----------------------------------------------------------------------------------------------------------

const FS_ERROR = errorSetOf(Object.values(FILE_SYSTEM_ERROR_NAMES));
const DIR_ERROR = mergeErrorSets(FS_ERROR, FILE_OPEN_ERROR);

/** `std.Io.Dir`, whose value holds the path of the directory it names. */
export const DIR: StructType = nativeStruct('Io.Dir', {}, [], { kind: 'dir', args: [], storageSlots: 1, byteSize: 4 });

const OPEN_MODE: EnumType = nativeEnum('Io.Dir.OpenFileOptions.Mode', ['read_only', 'write_only', 'read_write']);

const OPEN_FILE_OPTIONS: StructType = optionsStruct('Io.Dir.OpenFileOptions', [
  { name: 'mode', type: OPEN_MODE, hasDefault: true, defaultValue: 0n },
]);
addMembers(OPEN_FILE_OPTIONS, { Mode: typeMember(() => OPEN_MODE) });

const CREATE_FILE_OPTIONS: StructType = optionsStruct('Io.Dir.CreateFileOptions', [
  { name: 'read', type: BOOL, hasDefault: true, defaultValue: false },
  { name: 'truncate', type: BOOL, hasDefault: true, defaultValue: true },
  { name: 'exclusive', type: BOOL, hasDefault: true, defaultValue: false },
]);

const WRITE_FILE_OPTIONS: StructType = optionsStruct('Io.Dir.WriteFileOptions', [
  { name: 'sub_path', type: CONST_U8_SLICE, hasDefault: false },
  { name: 'data', type: CONST_U8_SLICE, hasDefault: false },
  { name: 'flags', type: CREATE_FILE_OPTIONS, hasDefault: true, defaultValue: new ZStruct([false, true, false]) },
]);

const STAT_FILE_OPTIONS: StructType = optionsStruct('Io.Dir.StatFileOptions', [
  { name: 'follow_symlinks', type: BOOL, hasDefault: true, defaultValue: true },
]);

/** `std.Io.Dir.Permissions`, the mode of a new file or directory, as POSIX systems number it. */
const PERMISSIONS: EnumType = {
  kind: 'enum',
  namespace: { name: 'Io.Dir.Permissions', decls: new Map() },
  tagType: U32,
  fields: [
    { name: 'default_file', value: 0o666n },
    { name: 'default_dir', value: 0o777n },
  ],
  exhaustive: false,
};
addMembers(PERMISSIONS, { executable_file: () => ({ type: PERMISSIONS, value: 0o777n }) });

function optionsStruct(name: string, fields: StructField[]): StructType {
  return nativeStruct(name, {}, fields);
}

/** The path that a `std.Io.Dir` names. */
function dirPath(value: Value): string {
  return (value as NativeHandle).state.path as string;
}

function dirValue(path: string): Value {
  return handle('dir', { path });
}

function text(value: Value, frame: Frame): string {
  const slice = value as Slice;
  frame.runtime.spend(slice.length);
  return decodeUtf8(slice.values().map(Number));
}

function joined(directory: string, path: string): string {
  return path.startsWith('/') || directory === '.' ? path : `${directory}/${path}`;
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}

/** A method of `std.Io.Dir`, whose receiver is the directory; `io` is the first argument where Zig's takes it. */
function dirMethod(
  name: string,
  params: readonly Type[],
  result: Type,
  run: (frame: Frame, directory: string, values: Value[]) => Value
): () => Member {
  return receiverMethod(`Dir.${name}`, DIR, dirReceiver, params, result, (frame, directory, values) =>
    run(frame, dirPath(directory), values)
  );
}

function dirReceiver(sema: SemaApi, call: NativeCall): TExpr {
  const receiver = call.receiver;
  if (receiver?.type === DIR) return receiver;
  if (receiver?.type.kind === 'pointer' && receiver.type.child === DIR) {
    const evaluate = receiver.eval;
    return runtime(DIR, (frame) => (evaluate(frame) as Pointer).load(), receiver.span);
  }
  return sema.error(call.span, `${typeName(DIR)} の値に対して呼び出してください。`);
}

/**
 * Opens a file for `std.Io.File`: to read when `mode` is 0, to write when 1, and both when 2, creating it with
 * `create`, as `openFile` and `createFile` do. A directory opens for reading, as Zig's open allows by default, and
 * its first read fails.
 */
function openPath(
  frame: Frame,
  target: string,
  mode: number,
  flags: { create: boolean; truncate: boolean; exclusive: boolean }
): Value {
  const files = frame.runtime.io.files;
  const writes = mode !== 0;
  const directory = files.kindOf(target) === 'directory';
  if (directory && (writes || flags.create)) throw new FileSystemError('EISDIR', target);
  if (directory) {
    const descriptor = frame.runtime.openFile({ content: noText, directory: true });
    return handle('file', { fd: descriptor });
  }
  const create = flags.create ? (flags.exclusive ? 'exclusive' : 'always') : 'never';
  const write = writes
    ? files.open(target, { create, truncate: flags.create && flags.truncate, append: false })
    : undefined;
  const content = files.openForReading(target);
  const descriptor = frame.runtime.openFile({ content, read: mode === 1 ? undefined : content, write });
  return handle('file', { fd: descriptor });
}

function noText(): string {
  return '';
}

/** Adds the `std.Io.Dir` members, which need the `std.Io` and `std.Io.File` types that std.ts declares. */
// code-gauge-allow functionNcss -- Declares the members of one library type, each a short closure.
export function addDirMembers(io: Type, file: StructType, fileWriteError: ErrorSetType): void {
  const openError = errorUnionOf(DIR_ERROR, file);
  addMembers(DIR, {
    OpenFileOptions: typeMember(() => OPEN_FILE_OPTIONS),
    CreateFileOptions: typeMember(() => CREATE_FILE_OPTIONS),
    WriteFileOptions: typeMember(() => WRITE_FILE_OPTIONS),
    Permissions: typeMember(() => PERMISSIONS),
    cwd: fnMember(
      'std.Io.Dir.cwd',
      (sema, call) => {
        expectArgs(sema, call, 0, 'std.Io.Dir.cwd');
        return known(DIR, dirValue('.'), call.span);
      },
      () => ({ type: fnType([], DIR) })
    ),
    close: dirMethod('close', [io], VOID, () => {}),
    openFile: dirMethod(
      'openFile',
      [io, CONST_U8_SLICE, OPEN_FILE_OPTIONS],
      openError,
      (frame, dir, [, path, options]) =>
        openPath(frame, joined(dir, text(path, frame)), Number((options as ZStruct).slots[0] as bigint), {
          create: false,
          truncate: false,
          exclusive: false,
        })
    ),
    createFile: dirMethod(
      'createFile',
      [io, CONST_U8_SLICE, CREATE_FILE_OPTIONS],
      openError,
      (frame, dir, [, path, flags]) => createFile(frame, joined(dir, text(path, frame)), flags as ZStruct)
    ),
    writeFile: dirMethod(
      'writeFile',
      [io, WRITE_FILE_OPTIONS],
      errorUnionOf(mergeErrorSets(DIR_ERROR, fileWriteError), VOID),
      (frame, dir, [, options]) => {
        const [path, data, flags] = (options as ZStruct).slots;
        const opened = createFile(frame, joined(dir, text(path, frame)), flags as ZStruct);
        const descriptor = (opened as NativeHandle).state.fd as number;
        try {
          const bytes = (data as Slice).readBytes((cost) => frame.runtime.spend(cost));
          frame.runtime.writeOutput(descriptor, [...bytes]);
        } finally {
          frame.runtime.closeDescriptor(descriptor);
        }
        return;
      }
    ),
    readFileAlloc: fnMember('Dir.readFileAlloc', (sema, call) => readFileAlloc(sema, call)),
    readFile: dirMethod(
      'readFile',
      [io, CONST_U8_SLICE, SLICE],
      errorUnionOf(mergeErrorSets(DIR_ERROR, READ_FAILED), SLICE),
      (frame, dir, [, path, buffer]) => {
        const opened = openPath(frame, joined(dir, text(path, frame)), 0, {
          create: false,
          truncate: false,
          exclusive: false,
        });
        const descriptor = (opened as NativeHandle).state.fd as number;
        try {
          const reader = new ReaderView(readerValue(new Slice({ slots: [] }, 0, 0), descriptor), frame);
          const destination = buffer as Slice;
          return new Slice(destination.target, destination.start, reader.readSliceShort(destination));
        } finally {
          frame.runtime.closeDescriptor(descriptor);
        }
      }
    ),
    deleteFile: dirMethod('deleteFile', [io, CONST_U8_SLICE], errorUnionOf(FS_ERROR, VOID), (frame, dir, [, path]) => {
      frame.runtime.io.files.remove(joined(dir, text(path, frame)), 'file');
      return;
    }),
    deleteDir: dirMethod('deleteDir', [io, CONST_U8_SLICE], errorUnionOf(FS_ERROR, VOID), (frame, dir, [, path]) => {
      frame.runtime.io.files.remove(joined(dir, text(path, frame)), 'directory');
      return;
    }),
    createDir: dirMethod(
      'createDir',
      [io, CONST_U8_SLICE, PERMISSIONS],
      errorUnionOf(FS_ERROR, VOID),
      (frame, dir, [, path]) => makeDirectory(frame, joined(dir, text(path, frame)), false)
    ),
    createDirPath: dirMethod(
      'createDirPath',
      [io, CONST_U8_SLICE],
      errorUnionOf(FS_ERROR, VOID),
      (frame, dir, [, path]) => makeDirectory(frame, joined(dir, text(path, frame)), true)
    ),
    StatFileOptions: typeMember(() => STAT_FILE_OPTIONS),
    statFile: dirMethod(
      'statFile',
      [io, CONST_U8_SLICE, STAT_FILE_OPTIONS],
      errorUnionOf(FS_ERROR, FILE_STAT),
      (frame, dir, [, path]) => {
        const target = joined(dir, text(path, frame));
        const files = frame.runtime.io.files;
        const kind = files.kindOf(target);
        if (!kind) return ErrorValue.of('FileNotFound');
        const size = kind === 'file' ? byteLength(files.readFile(target)) : 0;
        return new ZStruct([BigInt(size), kindValue(kind === 'directory' ? 'directory' : 'file')]);
      }
    ),
  });
}

function createFile(frame: Frame, target: string, flags: ZStruct): Value {
  const [read, truncate, exclusive] = flags.slots;
  return openPath(frame, target, read === true ? 2 : 1, {
    create: true,
    truncate: truncate === true,
    exclusive: exclusive === true,
  });
}

function makeDirectory(frame: Frame, target: string, recursive: boolean): Value {
  const files = frame.runtime.io.files;
  // A trailing slash names the same last directory.
  const kind = files.kindOf(target.replace(/(?<=.)\/+$/, ''));
  // `createDirPath` succeeds when the directory exists already, as `mkdir -p` does.
  if (recursive && kind === 'directory') return undefined;
  // A file where the last directory would go is not one, as Zig's createDirPath reports.
  if (recursive && kind === 'file') throw new FileSystemError('ENOTDIR', target);
  files.createDirectory(target, recursive);
  return undefined;
}

/** `dir.readFileAlloc(io, path, gpa, limit)`: a whole file in memory, which reaching the limit fails. */
function readFileAlloc(sema: SemaApi, call: NativeCall): TExpr {
  const receiver = dirReceiver(sema, call);
  const [ioArg, pathArg, allocatorArgument, limitArg] = expectArgs(sema, call, 4, 'readFileAlloc');
  const [io, path] = compileArgs(sema, [ioArg, pathArg], [IO_TYPE(), CONST_U8_SLICE]);
  const allocator = allocatorArg(sema, allocatorArgument);
  const [limit] = compileArgs(sema, [limitArg], [LIMIT]);
  const evaluators = [receiver, io, path, allocator, limit].map((arg) => arg.eval);
  return runtime(
    errorUnionOf(mergeErrorSets(DIR_ERROR, LIMITED_ALLOC_ERROR), SLICE),
    (frame) => {
      const [directory, , name, gpa, count] = evaluators.map((evaluate) => evaluate(frame));
      return attempt(() => {
        const opened = openPath(frame, joined(dirPath(directory), text(name, frame)), 0, {
          create: false,
          truncate: false,
          exclusive: false,
        });
        const descriptor = (opened as NativeHandle).state.fd as number;
        try {
          const reader = new ReaderView(readerValue(new Slice({ slots: [] }, 0, 0), descriptor), frame);
          let bytes: number[];
          try {
            bytes = reader.remaining((count as bigint) === UNLIMITED ? Number.POSITIVE_INFINITY : limitOf(count));
          } catch (error) {
            // Zig reports the reason a read failed, which in the run's files is only that the path is a directory.
            if (error instanceof ReadError && error.error === 'ReadFailed') return ErrorValue.of('IsDir');
            throw error;
          }
          return ownBytes(frame, gpa, bytes);
        } finally {
          frame.runtime.closeDescriptor(descriptor);
        }
      });
    },
    call.span
  );
}

// Descriptors ---------------------------------------------------------------------------------------------------------

/** The descriptor of a `std.Io.File`: 0 to 2 for the standard streams, and more for the files the program opened. */
export function fileDescriptor(value: Value): number {
  return (value as NativeHandle).state.fd as number;
}

/** The length of an open file in bytes. */
export function openFileLength(frame: Frame, descriptor: number): bigint {
  const file = frame.runtime.openFileAt(descriptor);
  return BigInt(file ? byteLength(file.content()) : 0);
}
