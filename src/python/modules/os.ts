import { newBytes, PyBytes } from '../bytesValues';
import { decodeBytes, encodeString } from '../codecs';
import { registerModule, registerModuleAlias } from '../modules';
import { callValue, lookupSpecial, toArray } from '../objects';
import { lessThan } from '../operators';
import { currentRuntime } from '../runtimeContext';
import { nativeFunction, newList, None, typeError, typeName, valueError } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import { PyError, PyInstance, type PyValue } from '../values';
import { bindArguments } from './numberSupport';

// os ----------------------------------------------------------------------------------------------------------------

const FILE_FUNCTIONS = [
  'getcwd',
  'getcwdb',
  'chdir',
  'listdir',
  'scandir',
  'walk',
  'fwalk',
  'mkdir',
  'makedirs',
  'remove',
  'unlink',
  'rmdir',
  'removedirs',
  'rename',
  'renames',
  'replace',
  'stat',
  'lstat',
  'chmod',
  'chown',
  'access',
  'open',
  'close',
  'read',
  'write',
  'link',
  'symlink',
  'readlink',
  'utime',
  'truncate',
  'umask',
  'pipe',
];

/** The functions of os that reach the file system, the environment, or other processes, which this grader lacks. */
const SYSTEM_FUNCTIONS: Record<string, string> = Object.fromEntries(
  [
    ['ファイルやディレクトリの操作', FILE_FUNCTIONS],
    ['環境変数', ['environ', 'environb', 'getenv', 'getenvb', 'putenv', 'unsetenv']],
    [
      'プロセスやシステムの情報',
      ['getpid', 'getppid', 'getuid', 'getgid', 'geteuid', 'getegid', 'getlogin', 'uname', 'cpu_count', 'times'],
    ],
    ['ほかのプログラムの実行', ['system', 'popen', 'fork', 'kill', 'abort', '_exit', 'startfile', 'execv', 'execl']],
    ['乱数のバイト列（os.urandom()）', ['urandom']],
    ['端末の大きさ（os.get_terminal_size()）', ['get_terminal_size']],
  ].flatMap(([feature, names]) =>
    (names as string[]).map((name) => [name, `os.${name}（${feature as string}）`] as const)
  )
);

registerModule(
  'os',
  (runtime) =>
    new Map<string, PyValue>([
      ['name', 'posix'],
      ['sep', '/'],
      ['altsep', None],
      ['extsep', '.'],
      ['pathsep', ':'],
      ['linesep', '\n'],
      ['curdir', '.'],
      ['pardir', '..'],
      ['defpath', '/bin:/usr/bin'],
      ['devnull', '/dev/null'],
      ['fspath', pathFunction('fspath', ['path'], 1, ([path]) => fspath(path as PyValue))],
      ['fsencode', pathFunction('fsencode', ['filename'], 1, ([filename]) => fsencode(filename as PyValue))],
      ['fsdecode', pathFunction('fsdecode', ['filename'], 1, ([filename]) => fsdecode(filename as PyValue))],
      ['path', runtime.importModule('posixpath')],
    ]),
  SYSTEM_FUNCTIONS
);

/** `os.fspath`: a path as a str or bytes, asking any other object for its `__fspath__`. */
function fspath(value: PyValue): PyValue {
  if (typeof value === 'string' || value instanceof PyBytes) return value;
  if (value instanceof PyInstance && typeof value.primitive === 'string') return value;
  const method = lookupSpecial(value, '__fspath__');
  if (method === undefined) {
    throw typeError(`expected str, bytes or os.PathLike object, not ${typeName(value)}`);
  }
  const result = callValue(method, [value]);
  if (typeof result === 'string' || result instanceof PyBytes) return result;
  throw typeError(`expected ${typeName(value)}.__fspath__() to return str or bytes, not ${typeName(result)}`);
}

/** `os.fsencode`: a path as bytes in the file system encoding of macOS, UTF-8 with surrogateescape. */
function fsencode(value: PyValue): PyValue {
  const path = fspath(value);
  return typeof path === 'string' ? newBytes(encodeString(path, 'utf8', 'surrogateescape')) : path;
}

/** `os.fsdecode`: a path as str, decoded as `os.fsencode` encodes it. */
function fsdecode(value: PyValue): PyValue {
  const path = fspath(value);
  return path instanceof PyBytes ? decodeBytes(path.data, 'utf8', 'surrogateescape') : path;
}

// posixpath ---------------------------------------------------------------------------------------------------------

registerModule(
  'posixpath',
  () =>
    new Map<string, PyValue>([
      ['sep', '/'],
      ['altsep', None],
      ['extsep', '.'],
      ['pathsep', ':'],
      ['curdir', '.'],
      ['pardir', '..'],
      ['devnull', '/dev/null'],
      ['join', nativeFunction('join', join)],
      ['split', pathFunction('split', ['p'], 1, ([p]) => tuple(splitPath(text(p))))],
      ['basename', pathFunction('basename', ['p'], 1, ([p]) => splitPath(text(p))[1])],
      ['dirname', pathFunction('dirname', ['p'], 1, ([p]) => splitPath(text(p))[0])],
      ['splitext', pathFunction('splitext', ['p'], 1, ([p]) => tuple(splitext(text(p))))],
      ['splitdrive', pathFunction('splitdrive', ['p'], 1, ([p]) => tuple(['', text(p)]))],
      ['splitroot', pathFunction('splitroot', ['p'], 1, ([p]) => tuple(splitroot(text(p))))],
      ['normpath', pathFunction('normpath', ['path'], 1, ([p]) => normpath(text(p)))],
      ['normcase', pathFunction('normcase', ['s'], 1, ([s]) => text(s))],
      ['isabs', pathFunction('isabs', ['s'], 1, ([s]) => text(s).startsWith('/'))],
      ['abspath', pathFunction('abspath', ['path'], 1, ([p]) => abspath(text(p)))],
      ['relpath', pathFunction('relpath', ['path', 'start'], 1, ([p, start]) => relpath(p as PyValue, start))],
      ['commonprefix', pathFunction('commonprefix', ['m'], 1, ([m]) => commonprefix(m as PyValue))],
      ['commonpath', pathFunction('commonpath', ['paths'], 1, ([paths]) => commonpath(paths as PyValue))],
    ]),
  Object.fromEntries(
    [
      'exists',
      'lexists',
      'isfile',
      'isdir',
      'islink',
      'ismount',
      'isjunction',
      'isdevdrive',
      'getsize',
      'getmtime',
      'getatime',
      'getctime',
      'samefile',
      'sameopenfile',
      'samestat',
      'realpath',
      'expanduser',
      'expandvars',
    ].map((name) => [name, `os.path.${name}()（ファイルシステムや環境変数を参照する関数）`])
  )
);
registerModuleAlias('os.path', 'posixpath');

function pathFunction(
  name: string,
  params: string[],
  required: number,
  run: (args: (PyValue | undefined)[]) => PyValue
): PyValue {
  return nativeFunction(name, (args, kwargs) =>
    run(bindArguments({ qualified: name, params, required, isFunction: true }, args, kwargs))
  );
}

/** The text of a path argument; bytes paths are not supported. */
function text(value: PyValue | undefined): string {
  const path = fspath(value as PyValue);
  if (typeof path === 'string') return path;
  if (path instanceof PyInstance) return path.primitive as string;
  throw new UnsupportedFeatureError('os.path の関数に bytes のパスを渡すこと');
}

function tuple(items: PyValue[]): PyValue {
  return currentRuntime().tuple(items);
}

function join(args: PyValue[], kwargs: Map<string, PyValue> | undefined): PyValue {
  const [first, ...rest] = bindJoin(args, kwargs);
  const start = fspath(first);
  let parts: PyValue[];
  try {
    parts = rest.map((part) => fspath(part));
    checkArgTypes('join', [start, ...parts]);
  } catch (error) {
    if (error instanceof PyError && error.exception.cls.name === 'TypeError') checkArgTypes('join', [start, ...rest]);
    throw error;
  }
  let path = text(start);
  for (const part of parts.map((each) => text(each))) {
    if (part.startsWith('/') || path === '') path = part;
    else if (path.endsWith('/')) path += part;
    else path += `/${part}`;
  }
  currentRuntime().buildString(path.length);
  return path;
}

function bindJoin(args: PyValue[], kwargs: Map<string, PyValue> | undefined): PyValue[] {
  if (kwargs && kwargs.size > 0) {
    throw typeError(`join() got an unexpected keyword argument '${[...kwargs.keys()][0]}'`);
  }
  if (args.length === 0) throw typeError("join() missing 1 required positional argument: 'a'");
  return args;
}

/** `genericpath._check_arg_types`, which words a path component of the wrong type. */
function checkArgTypes(name: string, values: PyValue[]): void {
  let hasString = false;
  let hasBytes = false;
  for (const value of values) {
    if (typeof value === 'string' || (value instanceof PyInstance && typeof value.primitive === 'string')) {
      hasString = true;
    } else if (value instanceof PyBytes) {
      hasBytes = true;
    } else {
      throw typeError(`${name}() argument must be str, bytes, or os.PathLike object, not '${typeName(value)}'`);
    }
  }
  if (hasString && hasBytes) throw typeError("Can't mix strings and bytes in path components");
}

function splitPath(path: string): [string, string] {
  const index = path.lastIndexOf('/') + 1;
  let head = path.slice(0, index);
  if (head !== '' && head !== '/'.repeat(head.length)) head = head.replace(/\/+$/, '');
  return [head, path.slice(index)];
}

function splitext(path: string): [string, string] {
  const sepIndex = path.lastIndexOf('/');
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex > sepIndex) {
    for (let index = sepIndex + 1; index < dotIndex; index++) {
      if (path[index] !== '.') return [path.slice(0, dotIndex), path.slice(dotIndex)];
    }
  }
  return [path, ''];
}

function splitroot(path: string): [string, string, string] {
  if (!path.startsWith('/')) return ['', '', path];
  if (path[1] !== '/' || path[2] === '/') return ['', '/', path.slice(1)];
  return ['', path.slice(0, 2), path.slice(2)];
}

function normpath(path: string): string {
  if (path === '') return '.';
  const initialSlashes = path.startsWith('//') && !path.startsWith('///') ? 2 : path.startsWith('/') ? 1 : 0;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..' || (initialSlashes === 0 && parts.length === 0) || parts.at(-1) === '..') parts.push(part);
    else if (parts.length > 0) parts.pop();
  }
  return '/'.repeat(initialSlashes) + parts.join('/') || '.';
}

/** `os.path.abspath`, which resolves a relative path against the working directory this grader does not have. */
function abspath(path: string): string {
  if (!path.startsWith('/')) throw new UnsupportedFeatureError('相対パスを絶対パスにすること（作業ディレクトリ）');
  return normpath(path);
}

function relpath(pathValue: PyValue, startValue: PyValue | undefined): string {
  const path = text(pathValue);
  if (path === '') throw valueError('no path specified');
  const start = startValue === undefined || startValue === None ? '.' : text(startValue);
  const startParts = abspath(start).split('/').filter(Boolean);
  const pathParts = abspath(path).split('/').filter(Boolean);
  let common = 0;
  while (common < startParts.length && common < pathParts.length && startParts[common] === pathParts[common]) common++;
  const parts = [...Array.from({ length: startParts.length - common }, () => '..'), ...pathParts.slice(common)];
  return parts.length === 0 ? '.' : parts.join('/');
}

function commonprefix(value: PyValue): PyValue {
  const items = toArray(value);
  if (items.length === 0) return '';
  const paths = items.map((item) => text(item));
  const sorted = paths.toSorted(pythonOrder);
  const [first, last] = [sorted[0], sorted.at(-1) as string];
  let index = 0;
  while (index < first.length && first[index] === last[index]) index++;
  return first.slice(0, index);
}

function commonpath(value: PyValue): PyValue {
  const paths = toArray(value).map((item) => text(item));
  if (paths.length === 0) throw valueError('commonpath() arg is an empty sequence');
  const absolute = new Set(paths.map((path) => path.startsWith('/')));
  if (absolute.size > 1) throw valueError("Can't mix absolute and relative paths");
  const split = paths.map((path) => path.split('/').filter((part) => part !== '' && part !== '.'));
  const sorted = split.toSorted((a, b) => pythonOrder(newList(a), newList(b)));
  const [first, last] = [sorted[0], sorted.at(-1) as string[]];
  let index = 0;
  while (index < first.length && first[index] === last[index]) index++;
  return (absolute.has(true) ? '/' : '') + first.slice(0, index).join('/');
}

/** Orders values as Python's `<` does, as `min` and `max` would pick them. */
function pythonOrder(a: PyValue, b: PyValue): number {
  if (lessThan(a, b)) return -1;
  return lessThan(b, a) ? 1 : 0;
}
