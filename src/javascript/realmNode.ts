import {
  FileSystemError,
  type FileSystemErrorCode,
  type OpenMode,
  UTF8_DECODER,
  UTF8_ENCODER,
} from '../interpreter/programIo';
import { inspect } from './inspect';
import type { RealmBuilder } from './realm';
import type { Runtime } from './runtime';
import { rejectUnavailableMember } from './unavailableMembers';
import { isObject, JsObject, JsThrow, ProgramExit, toBoolean, type Value } from './values';

type NodeErrorCode = FileSystemErrorCode | 'EBADF';

/** Node.js's descriptions and Linux's numbers of the errors that file system calls report. */
const ERRORS: Record<NodeErrorCode, { description: string; errno: number }> = {
  ENOENT: { description: 'no such file or directory', errno: -2 },
  EEXIST: { description: 'file already exists', errno: -17 },
  EISDIR: { description: 'illegal operation on a directory', errno: -21 },
  ENOTDIR: { description: 'not a directory', errno: -20 },
  ENOTEMPTY: { description: 'directory not empty', errno: -39 },
  EINVAL: { description: 'invalid argument', errno: -22 },
  EBADF: { description: 'bad file descriptor', errno: -9 },
};

/** The modules `require` returns, by the names Node.js accepts for them. */
const MODULE_NAMES = { fs: 'fs', 'node:fs': 'fs' } as const;

/** Node.js's `require('fs')` and `process` streams, which read and write the run's standard streams and files. */
export function defineNodeBuiltins(builder: RealmBuilder): void {
  const fs = new JsObject(builder.realm.objectPrototype);
  defineFileSystem(builder, fs);
  for (const property of fs.properties.values()) property.enumerable = true;
  builder.realm.fsModule = fs;
  builder.realm.fsObjects = new WeakSet([fs]);
  builder.realm.loadNodeModule = loadNodeModule;
  builder.realm.importNodeModule = importNodeModule;
  builder.global(
    'require',
    builder.function('require', 1, ({ runtime, args }) => loadNodeModule(runtime, runtime.toString(args[0])))
  );
  const process = builder.namespace('process');
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = new JsObject(builder.realm.objectPrototype);
    builder.method(stream, 'write', 1, ({ runtime, args }) => {
      const unavailable = unavailableWriteArgument(`process.${name}.write`, args.slice(1));
      if (runtime.unavailableMember && unavailable) rejectUnavailableMember(unavailable, runtime.currentRow);
      runtime.io[name].write(normalizeUtf8(requireText(runtime, args[0], 'chunk')));
      return true;
    });
    builder.constant(process, name, stream);
  }
  defineProcessExit(builder, process);
}

function defineProcessExit(builder: RealmBuilder, process: JsObject): void {
  let exitCode: number | undefined;
  process.properties.set('exitCode', {
    get: builder.function('get exitCode', 0, () => exitCode),
    set: builder.function('set exitCode', 1, ({ runtime, args }) => {
      exitCode = parseExitCode(runtime, args[0]);
      return;
    }),
    enumerable: true,
    configurable: true,
  });
  builder.method(process, 'exit', 1, ({ runtime, args }) => {
    if (args[0] !== undefined && args[0] !== null) exitCode = parseExitCode(runtime, args[0]);
    throw new ProgramExit();
  });
}

function parseExitCode(runtime: Runtime, code: Value): number | undefined {
  if (code === undefined || code === null) return undefined;
  if (typeof code === 'string') {
    const parsed = code === '' ? Number.NaN : Number(code);
    if (!Number.isNaN(parsed)) return validateIntegerExitCode(runtime, parsed);
    return throwCodedError(
      runtime,
      'TypeError',
      'ERR_INVALID_ARG_TYPE',
      `The "code" argument must be of type number. Received type string (${inspect(runtime, code)})`
    );
  }
  if (typeof code === 'number') return validateIntegerExitCode(runtime, code);
  return throwCodedError(
    runtime,
    'TypeError',
    'ERR_INVALID_ARG_TYPE',
    `The "code" argument must be of type number. Received ${inspect(runtime, code)}`
  );
}

function validateIntegerExitCode(runtime: Runtime, value: number): number {
  if (!Number.isInteger(value)) {
    return throwCodedError(
      runtime,
      'RangeError',
      'ERR_OUT_OF_RANGE',
      `The value of "code" is out of range. It must be an integer. Received ${value}`
    );
  }
  if (!Number.isSafeInteger(value)) {
    const formatted = Math.abs(value) < 1e21 ? String(value).replaceAll(/\B(?=(\d{3})+(?!\d))/g, '_') : String(value);
    return throwCodedError(
      runtime,
      'RangeError',
      'ERR_OUT_OF_RANGE',
      `The value of "code" is out of range. It must be >= -9007199254740991 && <= 9007199254740991. Received ${formatted}`
    );
  }
  return value === 0 ? 0 : value;
}

/** Loads a built-in Node.js module by specifier, for `require` and lowered ECMAScript `import` declarations. */
function loadNodeModule(runtime: Runtime, name: string): Value {
  if (!Object.hasOwn(MODULE_NAMES, name) || !runtime.realm.fsModule) {
    return runtime.throwError('Error', `Cannot find module '${name}'`);
  }
  return runtime.realm.fsModule;
}

/** Wraps a CommonJS built-in module as tsx's `__toESM` helper does for ECMAScript `import` declarations. */
function importNodeModule(runtime: Runtime, name: string): Value {
  const mod = loadNodeModule(runtime, name);
  if (!(mod instanceof JsObject)) return mod;
  const isEsModule = toBoolean(runtime.get(mod, '__esModule'));
  const target = new JsObject(mod.proto);
  runtime.realm.fsObjects?.add(target);
  if (!isEsModule) {
    target.properties.set('default', { value: mod, writable: false, enumerable: true, configurable: false });
  }
  for (const [key, descriptor] of mod.properties) {
    if (typeof key !== 'string' || target.properties.has(key)) continue;
    target.properties.set(key, {
      get: runtime.newNativeFunction('get', 0, () => runtime.get(mod, key)),
      set: undefined,
      enumerable: descriptor.enumerable,
      configurable: false,
    });
  }
  return target;
}

/**
 * What a stream's `write` is given after its text that this interpreter does not run, if anything: an encoding other
 * than UTF-8, which Node.js decodes the text with, or the callback Node.js calls once the text is written.
 */
function unavailableWriteArgument(method: string, rest: Value[]): string | undefined {
  const [encoding, callback] = isObject(rest[0]) ? [undefined, rest[0]] : rest;
  if (encoding !== undefined && encoding !== null && !isUtf8(encoding)) return `${method} のエンコーディング指定`;
  return callback === undefined ? undefined : `${method} のコールバック`;
}

function defineFileSystem(builder: RealmBuilder, fs: JsObject): void {
  builder.method(fs, 'readFileSync', 2, ({ runtime, args }) => readFileSync(runtime, args));
  for (const [name, defaultFlag] of [
    ['writeFileSync', 'w'],
    ['appendFileSync', 'a'],
  ] as const) {
    builder.method(fs, name, 3, ({ runtime, args }) => {
      writeFile(runtime, name, args, defaultFlag);
      return;
    });
  }
  builder.method(fs, 'existsSync', 1, ({ runtime, args }) => {
    if (typeof args[0] !== 'string' || args[0] === '') return false;
    try {
      if (runtime.io.files.resolveStreamPath(args[0]) !== undefined) return true;
    } catch (error) {
      if (error instanceof FileSystemError) return false;
      throw error;
    }
    return runtime.io.files.kindOf(args[0]) !== undefined;
  });
  defineDirectoryMethods(builder, fs);
}

function defineDirectoryMethods(builder: RealmBuilder, fs: JsObject): void {
  builder.method(fs, 'mkdirSync', 2, ({ runtime, args }) => {
    const path = requirePath(runtime, args[0]);
    const options = args[1];
    const recursive = isObject(options) && runtime.get(options, 'recursive') === true;
    const created = withErrors(runtime, 'mkdir', path, () => runtime.io.files.createDirectory(path, recursive));
    // A recursive call returns the first directory it created, spelled as the path given spells it.
    return recursive && created !== undefined ? spelledPrefixOf(runtime, path, created) : undefined;
  });
  builder.method(fs, 'readdirSync', 2, ({ runtime, args }) => {
    const unavailable = unavailableReaddirOption(runtime, args[1]);
    if (runtime.unavailableMember && unavailable) rejectUnavailableMember(unavailable, runtime.currentRow);
    const path = requirePath(runtime, args[0]);
    return runtime.newArray(
      withErrors(runtime, 'scandir', path, () => runtime.io.files.list(path)).toSorted(compareUtf8)
    );
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

function readFileSync(runtime: Runtime, args: Value[]): Value {
  const options = args[1];
  checkReadEncoding(runtime, options);
  const flag = isObject(options) ? runtime.get(options, 'flag') : undefined;
  const parsed = parseOpenFlag(runtime, flag === undefined ? 'r' : runtime.toString(flag));
  // File descriptor 0 is standard input.
  if (args[0] === 0) return runtime.io.stdin.reader.readRest();
  const path = requirePath(runtime, args[0]);
  if (withErrors(runtime, 'open', path, () => runtime.io.files.resolveStreamPath(path)) === 'stdin') {
    if (parsed.mode.create === 'exclusive') throwNodeError(runtime, 'EEXIST', 'open', path);
    if (!parsed.readable) throwNodeError(runtime, 'EBADF', 'read');
    return runtime.io.stdin.reader.readRest();
  }
  // Node.js names no path when reading a directory opened read-only fails, since it fails on `read(fd)` rather than `open`.
  if (!parsed.writable && path !== '' && runtime.io.files.kindOf(path) === 'directory')
    throwNodeError(runtime, 'EISDIR', 'read');
  const handle = withErrors(runtime, 'open', path, () => runtime.io.files.open(path, parsed.mode));
  if (!parsed.readable) throwNodeError(runtime, 'EBADF', 'read');
  return handle.read();
}

function checkReadEncoding(runtime: Runtime, options: Value): void {
  if (!runtime.unavailableMember) return;
  const encoding = encodingOption(runtime, options);
  // Node.js reads into a Buffer without an encoding, which a TypeScript program sees as unavailable.
  if (encoding === undefined || encoding === null)
    rejectUnavailableMember('エンコーディングを指定しない readFileSync（Buffer）', runtime.currentRow);
  if (!isUtf8(encoding))
    rejectUnavailableMember(`readFileSync の encoding: ${encodingLabel(runtime, encoding)}`, runtime.currentRow);
}

/**
 * The `readdirSync` option this interpreter does not run, if one is given: it lists names as UTF-8 strings only, not
 * recursively, as Dirent objects, or in another encoding.
 */
function unavailableReaddirOption(runtime: Runtime, options: Value): string | undefined {
  const encoding = encodingOption(runtime, options);
  if (encoding !== undefined && encoding !== null && !isUtf8(encoding))
    return `readdirSync の encoding: ${encodingLabel(runtime, encoding)}`;
  if (!isObject(options)) return undefined;
  for (const name of ['recursive', 'withFileTypes']) {
    const value = runtime.get(options, name);
    if (value !== undefined && value !== false) return `readdirSync の ${name}`;
  }
  return undefined;
}

/** The encoding an `fs` function's options give, as a string or an options object's `encoding`. */
function encodingOption(runtime: Runtime, options: Value): Value {
  if (typeof options === 'string') return options;
  return isObject(options) ? runtime.get(options, 'encoding') : undefined;
}

/** An encoding as a message names it: a string in double quotes, or another value as Node.js shows it. */
function encodingLabel(runtime: Runtime, encoding: Value): string {
  return typeof encoding === 'string' ? `"${encoding}"` : runtime.describePlain(encoding);
}

/** Whether an encoding is UTF-8, the one this interpreter reads and lists text in. */
function isUtf8(encoding: Value): boolean {
  // Node.js spells UTF-8 with or without the hyphen, in any case.
  return typeof encoding === 'string' && encoding.toLowerCase().replace('-', '') === 'utf8';
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
function writeFile(runtime: Runtime, method: string, [file, content, options]: Value[], defaultFlag: string): void {
  // Node.js decodes the data with the encoding before writing it, which this interpreter does only for UTF-8.
  const encoding = encodingOption(runtime, options);
  if (runtime.unavailableMember && encoding !== undefined && encoding !== null && !isUtf8(encoding))
    rejectUnavailableMember(`${method} の encoding: ${encodingLabel(runtime, encoding)}`, runtime.currentRow);
  const flag = isObject(options) ? runtime.get(options, 'flag') : undefined;
  const isStreamDescriptor = file === 1 || file === 2;
  const path = isStreamDescriptor ? '' : requirePath(runtime, file);
  const bytes = UTF8_ENCODER.encode(requireText(runtime, content, 'data'));
  if (isStreamDescriptor) {
    runtime.io[file === 1 ? 'stdout' : 'stderr'].write(UTF8_DECODER.decode(bytes));
    return;
  }
  const parsed = parseOpenFlag(runtime, flag === undefined ? defaultFlag : runtime.toString(flag));
  if (writeStandardStreamPath(runtime, path, bytes, parsed)) return;
  const handle = withErrors(runtime, 'open', path, () => runtime.io.files.open(path, parsed.mode));
  if (!parsed.writable) throwNodeError(runtime, 'EBADF', 'write');
  handle.writeBytes(bytes);
}

function writeStandardStreamPath(runtime: Runtime, path: string, bytes: Uint8Array, parsed: ParsedOpenFlag): boolean {
  const stream = withErrors(runtime, 'open', path, () => runtime.io.files.resolveStreamPath(path));
  if (stream !== 'stdout' && stream !== 'stderr') return false;
  if (parsed.mode.create === 'exclusive') throwNodeError(runtime, 'EEXIST', 'open', path);
  if (!parsed.writable) throwNodeError(runtime, 'EBADF', 'write');
  runtime.io[stream].write(UTF8_DECODER.decode(bytes));
  return true;
}

function normalizeUtf8(text: string): string {
  return UTF8_DECODER.decode(UTF8_ENCODER.encode(text));
}

function compareUtf8(a: string, b: string): number {
  const [bytesA, bytesB] = [UTF8_ENCODER.encode(a), UTF8_ENCODER.encode(b)];
  const length = Math.min(bytesA.length, bytesB.length);
  for (let index = 0; index < length; index++) {
    if (bytesA[index] !== bytesB[index]) return bytesA[index] - bytesB[index];
  }
  return bytesA.length - bytesB.length;
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
  code: NodeErrorCode,
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

interface ParsedOpenFlag {
  mode: OpenMode;
  readable: boolean;
  writable: boolean;
}

/** Parses any of Node.js's file system opening flags (`r`, `rs+`, `w`, `wx+`, `a+`, etc.). */
function parseOpenFlag(runtime: Runtime, flag: string): ParsedOpenFlag {
  const match = /^(?:(?<read>r|rs|sr)|(?<write>w|wx|xw)|(?<append>a|as|sa|ax|xa))(?<plus>\+)?$/.exec(flag);
  if (!match?.groups) {
    return throwCodedError(
      runtime,
      'TypeError',
      'ERR_INVALID_ARG_VALUE',
      `The argument 'flags' is invalid. Received '${flag}'`
    );
  }
  const { read, write, append, plus } = match.groups;
  const hasPlus = plus === '+';
  const create = flag.includes('x') ? 'exclusive' : append || write ? 'always' : 'never';
  return {
    mode: { create, truncate: write !== undefined, append: append !== undefined },
    readable: read !== undefined || hasPlus,
    writable: write !== undefined || append !== undefined || hasPlus,
  };
}

function throwCodedError(runtime: Runtime, kind: 'TypeError' | 'RangeError', code: string, message: string): never {
  const error = runtime.newError(kind, message);
  runtime.set(error, 'code', code);
  throw new JsThrow(error);
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
