import { FileSystemError, type FileSystemErrorCode, type OpenMode } from '../interpreter/programIo';
import { inspect } from './inspect';
import type { RealmBuilder } from './realm';
import type { Runtime } from './runtime';
import { isObject, JsObject, JsThrow, type Value } from './values';

/** Node.js's descriptions and Linux's numbers of the errors that file system calls report. */
const ERRORS: Record<FileSystemErrorCode, { description: string; errno: number }> = {
  ENOENT: { description: 'no such file or directory', errno: -2 },
  EEXIST: { description: 'file already exists', errno: -17 },
  EISDIR: { description: 'illegal operation on a directory', errno: -21 },
  ENOTDIR: { description: 'not a directory', errno: -20 },
  ENOTEMPTY: { description: 'directory not empty', errno: -39 },
  EINVAL: { description: 'invalid argument', errno: -22 },
};

/** The modules `require` returns, by the names Node.js accepts for them. */
const MODULE_NAMES = { fs: 'fs', 'node:fs': 'fs' } as const;

/** Node.js's `require('fs')` and `process` streams, which read and write the run's standard streams and files. */
export function defineNodeBuiltins(builder: RealmBuilder): void {
  const fs = new JsObject(builder.realm.objectPrototype);
  defineFileSystem(builder, fs);
  const modules = { fs };
  builder.global(
    'require',
    builder.function('require', 1, ({ runtime, args }) => {
      const name = runtime.toString(args[0]);
      if (!Object.hasOwn(MODULE_NAMES, name)) return runtime.throwError('Error', `Cannot find module '${name}'`);
      return modules[MODULE_NAMES[name as keyof typeof MODULE_NAMES]];
    })
  );
  const process = builder.namespace('process');
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = new JsObject(builder.realm.objectPrototype);
    builder.method(stream, 'write', 1, ({ runtime, args }) => {
      runtime.io[name].write(requireText(runtime, args[0], 'chunk'));
      return true;
    });
    builder.constant(process, name, stream);
  }
}

// code-gauge-allow functionNcss 40 -- Lists the builtin methods, each a small closure of its own.
function defineFileSystem(builder: RealmBuilder, fs: JsObject): void {
  builder.method(fs, 'readFileSync', 2, ({ runtime, args }) => {
    // File descriptor 0 is standard input.
    if (args[0] === 0) return runtime.io.openReader('/dev/stdin').readRest();
    const path = requirePath(runtime, args[0]);
    // Node.js names no path when reading a directory fails, since it reads from a file descriptor it opened.
    if (path !== '' && runtime.io.files.kindOf(path) === 'directory') throwNodeError(runtime, 'EISDIR', 'read');
    return withErrors(runtime, 'open', path, () => runtime.io.openReader(path).readRest());
  });
  for (const [name, defaultFlag] of [
    ['writeFileSync', 'w'],
    ['appendFileSync', 'a'],
  ] as const) {
    builder.method(fs, name, 3, ({ runtime, args }) => {
      writeFile(runtime, args, defaultFlag);
      return;
    });
  }
  builder.method(
    fs,
    'existsSync',
    1,
    ({ runtime, args }) =>
      typeof args[0] === 'string' && args[0] !== '' && runtime.io.files.kindOf(args[0]) !== undefined
  );
  builder.method(fs, 'mkdirSync', 2, ({ runtime, args }) => {
    const path = requirePath(runtime, args[0]);
    const options = args[1];
    const recursive = isObject(options) && runtime.get(options, 'recursive') === true;
    const created = withErrors(runtime, 'mkdir', path, () => runtime.io.files.createDirectory(path, recursive));
    // A recursive call returns the first directory it created, spelled as the path given spells it.
    return recursive && created !== undefined ? spelledPrefixOf(runtime, path, created) : undefined;
  });
  builder.method(fs, 'readdirSync', 2, ({ runtime, args }) => {
    const path = requirePath(runtime, args[0]);
    return runtime.newArray(withErrors(runtime, 'scandir', path, () => runtime.io.files.list(path)));
  });
  for (const [name, syscall, kind] of [
    ['unlinkSync', 'unlink', 'file'],
    ['rmdirSync', 'rmdir', 'directory'],
  ] as const) {
    builder.method(fs, name, 1, ({ runtime, args }) => {
      const path = requirePath(runtime, args[0]);
      withErrors(runtime, syscall, path, () => runtime.io.files.remove(path, kind));
      return;
    });
  }
  builder.method(fs, 'renameSync', 2, ({ runtime, args }) => {
    const [from, to] = [requirePath(runtime, args[0]), requirePath(runtime, args[1])];
    withErrors(runtime, 'rename', from, () => runtime.io.files.rename(from, to), to);
    return;
  });
}

/** The shortest prefix of a path, as the program spelled it, that names a directory given by its absolute path. */
function spelledPrefixOf(runtime: Runtime, path: string, directory: string): string {
  const target = directory.split('/').filter((name) => name !== '');
  const parts = path.split('/');
  const names: string[] = [];
  for (const [index, part] of parts.entries()) {
    runtime.scan(names.length + 1);
    if (part === '' || part === '.') continue;
    if (part === '..') names.pop();
    else names.push(part);
    if (names.length === target.length && names.every((name, depth) => name === target[depth])) {
      return parts.slice(0, index + 1).join('/');
    }
  }
  return path;
}

/** `writeFileSync` and `appendFileSync`, which open the file with the flag of their options or else `defaultFlag`. */
function writeFile(runtime: Runtime, [file, content, options]: Value[], defaultFlag: string): void {
  const path = requirePath(runtime, file);
  const data = requireText(runtime, content, 'data');
  const flag = isObject(options) ? runtime.get(options, 'flag') : undefined;
  const mode = openModeOf(runtime, flag === undefined ? defaultFlag : runtime.toString(flag));
  withErrors(runtime, 'open', path, () => runtime.io.files.open(path, mode).write(data));
}

/** Runs a file system call, throwing the error Node.js throws for its failure. */
function withErrors<T>(runtime: Runtime, syscall: string, path: string, run: () => T, destination?: string): T {
  // Node.js names no file by the empty path, though the file system takes it for the working directory.
  if (path === '' || destination === '') return throwNodeError(runtime, 'ENOENT', syscall, path, destination);
  try {
    return run();
  } catch (error) {
    if (!(error instanceof FileSystemError)) throw error;
    return throwNodeError(runtime, error.code, syscall, path, destination);
  }
}

function throwNodeError(
  runtime: Runtime,
  code: FileSystemErrorCode,
  syscall: string,
  path?: string,
  destination?: string
): never {
  const { description, errno } = ERRORS[code];
  const target = path === undefined ? '' : destination === undefined ? ` '${path}'` : ` '${path}' -> '${destination}'`;
  const error = runtime.newError('Error', `${code}: ${description}, ${syscall}${target}`);
  runtime.set(error, 'errno', errno);
  runtime.set(error, 'code', code);
  runtime.set(error, 'syscall', syscall);
  if (path !== undefined) runtime.set(error, 'path', path);
  if (destination !== undefined) runtime.set(error, 'dest', destination);
  throw new JsThrow(error);
}

/** How Node.js opens a file to write with a file system flag such as `w`, `wx`, `a`, or `r+`. */
function openModeOf(runtime: Runtime, flag: string): OpenMode {
  const match = /^(?:(?<append>a|as|ax|xa)|(?<write>w|wx|xw)|(?<update>r|rs))\+?$/.exec(flag);
  if (!match?.groups || (match.groups.update && !flag.endsWith('+'))) {
    return runtime.throwError('TypeError', `The argument 'flags' is invalid. Received '${flag}'`);
  }
  const { append, write } = match.groups;
  const create = flag.includes('x') ? 'exclusive' : append || write ? 'always' : 'never';
  return { create, truncate: write !== undefined, append: append !== undefined };
}

function requirePath(runtime: Runtime, value: Value): string {
  if (typeof value === 'string') return value;
  return runtime.throwError(
    'TypeError',
    `The "path" argument must be of type string or an instance of Buffer or URL. Received ${inspect(runtime, value)}`
  );
}

function requireText(runtime: Runtime, value: Value, name: string): string {
  if (typeof value === 'string') return value;
  return runtime.throwError(
    'TypeError',
    `The "${name}" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${inspect(runtime, value)}`
  );
}
