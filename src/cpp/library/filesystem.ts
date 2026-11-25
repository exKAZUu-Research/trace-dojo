import { ERROR_NUMBERS, errorMessage } from '../../c/library/appleErrno';
import { FileSystemError, type VirtualFileSystem } from '../../interpreter/programIo';
import { byteArray } from '../bytes';
import type { Frame } from '../runtime';
import { BOOL, CONST_CHAR, type FunctionInfo, INT, LLONG, pointerTo, type Type, ULLONG } from '../types';
import type { Ptr } from '../values';
import type { Library } from './registry';
import { makeString } from './string';
import { native, readCString } from './support';

const PATH = pointerTo(CONST_CHAR);

/** A native's work on the run's files, given the paths its `const char*` arguments hold and its other arguments. */
type FileOperation = (files: VirtualFileSystem, paths: string[], args: unknown[]) => unknown;

/**
 * The natives `<filesystem>` works on the run's files with, which return a negative `errno` for an error that the
 * library's C++ source reports with a `std::filesystem::filesystem_error`.
 */
export function filesystemFunctions(library: Library): Map<string, FunctionInfo[]> {
  return new Map([
    fileNative('__builtin_fs_status', [PATH], INT, (files, [p]) => {
      const kind = files.kindOf(p as string);
      return kind === 'file' ? 1 : kind === 'directory' ? 2 : 0;
    }),
    fileNative('__builtin_fs_file_size', [PATH], LLONG, (files, [p]) => {
      if (files.kindOf(p as string) === 'directory') throw new FileSystemError('EISDIR', p as string);
      return BigInt(files.readFile(p as string).length);
    }),
    fileNative('__builtin_fs_create_directory', [PATH, BOOL], INT, (files, [p], [, recursive]) =>
      createDirectory(files, p as string, recursive !== 0)
    ),
    fileNative('__builtin_fs_remove', [PATH], INT, (files, [p]) => {
      if (!files.kindOf(p as string)) return 0;
      files.remove(p as string);
      return 1;
    }),
    fileNative('__builtin_fs_remove_all', [PATH], LLONG, (files, [p]) => BigInt(removeAll(files, p as string))),
    fileNative('__builtin_fs_rename', [PATH, PATH], INT, (files, [from, to]) => {
      files.rename(from as string, to as string);
      return 0;
    }),
    fileNative('__builtin_fs_copy_file', [PATH, PATH, INT], INT, (files, [from, to], args) =>
      copyFile(files, from as string, to as string, args[2] as number)
    ),
    fileNative('__builtin_fs_resize_file', [PATH, ULLONG], INT, (files, [p], [, size]) =>
      resizeFile(files, p as string, Number(size))
    ),
    [
      '__builtin_fs_list',
      [
        native('__builtin_fs_list', [PATH], library.stringType, ([p], { frame }) =>
          makeString(frame, frame.runtime.io.files.list(pathOf(p, frame)).map(encode).join('/'))
        ),
      ],
    ],
    [
      '__builtin_fs_error_message',
      [
        native('__builtin_fs_error_message', [INT], library.stringType, ([code], { frame }) =>
          makeString(frame, errorMessage(Number(code)))
        ),
      ],
    ],
  ]);
}

/** A native that works on the run's files, returning the negative `errno` of an error. */
function fileNative(name: string, params: Type[], ret: Type, run: FileOperation): [string, FunctionInfo[]] {
  const returnsBigInt = ret === LLONG || ret === ULLONG;
  return [
    name,
    [
      native(name, params, ret, (args, { frame }) => {
        const paths = args.map((arg, index) => (params[index] === PATH ? pathOf(arg, frame) : ''));
        try {
          return run(frame.runtime.io.files, paths, args);
        } catch (error) {
          if (!(error instanceof FileSystemError)) throw error;
          const code = -(ERROR_NUMBERS[error.code] as number);
          return returnsBigInt ? BigInt(code) : code;
        }
      }),
    ],
  ];
}

/** Creates a directory, with its missing ancestors when `recursive`, telling whether it created one. */
function createDirectory(files: VirtualFileSystem, path: string, recursive: boolean): number {
  if (recursive) return files.createDirectory(path, true) === undefined ? 0 : 1;
  const kind = files.kindOf(path);
  if (kind === 'directory') return 0;
  if (kind === 'file') throw new FileSystemError('EEXIST', path);
  files.createDirectory(path, false);
  return 1;
}

/**
 * Copies a file, which `copy_options::skip_existing` (1) skips when the target exists and `overwrite_existing` (2)
 * replaces, telling whether it copied the file.
 */
function copyFile(files: VirtualFileSystem, source: string, target: string, option: number): number {
  const kind = files.kindOf(source);
  if (kind !== 'file') throw new FileSystemError(kind ? 'EINVAL' : 'ENOENT', source);
  const existing = files.kindOf(target);
  if (existing === 'directory') throw new FileSystemError('EISDIR', target);
  if (existing === 'file') {
    if (option === 1) return 0;
    if (option !== 2 || files.isSameFile(source, target)) throw new FileSystemError('EEXIST', target);
  }
  const content = files.readFile(source);
  files.open(target, { create: 'always', truncate: true, append: false }).write(content);
  return 1;
}

function resizeFile(files: VirtualFileSystem, path: string, length: number): number {
  const kind = files.kindOf(path);
  if (kind !== 'file') throw new FileSystemError(kind ? 'EISDIR' : 'ENOENT', path);
  const content = files.readFile(path);
  const resized = length <= content.length ? content.slice(0, length) : content.padEnd(length, '\0');
  files.open(path, { create: 'never', truncate: true, append: false }).write(resized);
  return 0;
}

/** Removes a file or a directory with what it holds, counting what it removed, the deepest first. */
function removeAll(files: VirtualFileSystem, path: string): number {
  const kind = files.kindOf(path);
  if (!kind) return 0;
  let count = 0;
  if (kind === 'directory') {
    for (const name of files.list(path)) count += removeAll(files, `${path.replace(/\/$/, '')}/${name}`);
  }
  files.remove(path);
  return count + 1;
}

/** A path the program gives in UTF-8 bytes. */
function pathOf(pointer: unknown, frame: Frame): string {
  return new TextDecoder().decode(byteArray(readCString(pointer as Ptr, frame.runtime)));
}

function encode(name: string): string {
  return String.fromCodePoint(...new TextEncoder().encode(name));
}
