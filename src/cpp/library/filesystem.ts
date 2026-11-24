import { ERROR_NUMBERS, errorMessage } from '../../c/library/appleErrno';
import { FileSystemError, type VirtualFileSystem } from '../../interpreter/programIo';
import { byteArray } from '../bytes';
import type { Frame } from '../runtime';
import { BOOL, CONST_CHAR, type FunctionInfo, INT, LLONG, pointerTo, type Type, ULLONG } from '../types';
import type { Ptr } from '../values';
import type { Library } from './registry';
import { makeString } from './string';
import { native, readCString } from './support';

/**
 * The natives `<filesystem>` works on the run's files with, which return a negative `errno` for an error that the
 * library's C++ source reports with a `std::filesystem::filesystem_error`.
 */
export function filesystemFunctions(library: Library): Map<string, FunctionInfo[]> {
  const path = pointerTo(CONST_CHAR);
  const define = (
    name: string,
    params: Type[],
    ret: Type,
    run: (files: VirtualFileSystem, args: string[], frame: Frame, raw: unknown[]) => unknown
  ): [string, FunctionInfo[]] => [
    name,
    [
      native(name, params, ret, (args, { frame }) => {
        const paths = args.map((arg, index) => (params[index] === path ? pathOf(arg, frame) : ''));
        try {
          return run(frame.runtime.io.files, paths, frame, args);
        } catch (error) {
          if (!(error instanceof FileSystemError)) throw error;
          const code = -(ERROR_NUMBERS[error.code] as number);
          return ret === ULLONG || ret === LLONG ? BigInt(code) : code;
        }
      }),
    ],
  ];
  return new Map([
    define('__builtin_fs_status', [path], INT, (files, [p]) => {
      const kind = files.kindOf(p as string);
      return kind === 'file' ? 1 : kind === 'directory' ? 2 : 0;
    }),
    define('__builtin_fs_file_size', [path], LLONG, (files, [p]) => {
      if (files.kindOf(p as string) === 'directory') throw new FileSystemError('EISDIR', p as string);
      return BigInt(files.readFile(p as string).length);
    }),
    define('__builtin_fs_create_directory', [path, BOOL], INT, (files, [p], _frame, [, recursive]) => {
      const target = p as string;
      if (recursive) return files.createDirectory(target, true) === undefined ? 0 : 1;
      const kind = files.kindOf(target);
      if (kind === 'directory') return 0;
      if (kind === 'file') throw new FileSystemError('EEXIST', target);
      files.createDirectory(target, false);
      return 1;
    }),
    define('__builtin_fs_remove', [path], INT, (files, [p]) => {
      if (!files.kindOf(p as string)) return 0;
      files.remove(p as string);
      return 1;
    }),
    define('__builtin_fs_remove_all', [path], LLONG, (files, [p]) => BigInt(removeAll(files, p as string))),
    define('__builtin_fs_rename', [path, path], INT, (files, [from, to]) => {
      files.rename(from as string, to as string);
      return 0;
    }),
    define('__builtin_fs_copy_file', [path, path, INT], INT, (files, [from, to], _frame, raw) => {
      const option = raw[2];
      const source = from as string;
      const target = to as string;
      if (files.kindOf(source) !== 'file')
        throw new FileSystemError(files.kindOf(source) ? 'EINVAL' : 'ENOENT', source);
      const existing = files.kindOf(target);
      if (existing === 'directory') throw new FileSystemError('EISDIR', target);
      if (existing === 'file') {
        // `copy_options::skip_existing` skips it, `overwrite_existing` replaces it, and otherwise it is an error.
        if (option === 1) return 0;
        if (option !== 2 || files.isSameFile(source, target)) throw new FileSystemError('EEXIST', target);
      }
      const content = files.readFile(source);
      files.open(target, { create: 'always', truncate: true, append: false }).write(content);
      return 1;
    }),
    define('__builtin_fs_resize_file', [path, ULLONG], INT, (files, [p], _frame, [, size]) => {
      const target = p as string;
      if (files.kindOf(target) !== 'file')
        throw new FileSystemError(files.kindOf(target) ? 'EISDIR' : 'ENOENT', target);
      const content = files.readFile(target);
      const length = Number(size);
      const resized = length <= content.length ? content.slice(0, length) : content.padEnd(length, '\0');
      files.open(target, { create: 'never', truncate: true, append: false }).write(resized);
      return 0;
    }),
    [
      '__builtin_fs_list',
      [
        native('__builtin_fs_list', [path], library.stringType, ([p], { frame }) =>
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
