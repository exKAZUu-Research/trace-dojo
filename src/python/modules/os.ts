import { newBytes, PyBytes } from '../bytesValues';
import { decodeBytes, encodeString } from '../codecs';
import { registerExtraAttributes, registerModule, registerModuleAlias, setBuiltinFunctionModule } from '../modules';
import { bindValue, callValue, lookupSpecial } from '../objects';
import { registerSourceModule } from '../sourceModules';
import { nativeFunction, None, typeError, typeName, unbox } from '../types';
import type { PyValue } from '../values';
import { clinicFunction } from './clinicArgs';
import { bindArguments } from './numberSupport';
import { POSIXPATH_SOURCE } from './posixpathSource';

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
      ['SEEK_SET', 0n],
      ['SEEK_CUR', 1n],
      ['SEEK_END', 2n],
      ['fspath', osFunction('fspath', ['path'], 1, ([path]) => fspath(path as PyValue))],
      ['fsencode', osFunction('fsencode', ['filename'], 1, ([filename]) => fsencode(filename as PyValue))],
      ['fsdecode', osFunction('fsdecode', ['filename'], 1, ([filename]) => fsdecode(filename as PyValue))],
      ['PathLike', runtime.importModule('_os_pathlike').dict.get('PathLike') as PyValue],
    ]),
  SYSTEM_FUNCTIONS
);

// CPython's `os.PathLike`, as `Lib/os.py` defines it, with `_collections_abc._check_methods`, since modules that
// collections.abc imports import os.
registerSourceModule(
  '_os_pathlike',
  String.raw`
import abc

GenericAlias = type(list[int])


def _check_methods(C, *methods):
    mro = C.__mro__
    for method in methods:
        for B in mro:
            if method in B.__dict__:
                if B.__dict__[method] is None:
                    return NotImplemented
                break
        else:
            return NotImplemented
    return True


class PathLike(abc.ABC):

    '''Abstract base class for implementing the file system path protocol.'''

    __slots__ = ()

    @abc.abstractmethod
    def __fspath__(self):
        '''Return the file system path representation of the object.'''
        raise NotImplementedError

    @classmethod
    def __subclasshook__(cls, subclass):
        if cls is PathLike:
            return _check_methods(subclass, '__fspath__')
        return NotImplemented

    __class_getitem__ = classmethod(GenericAlias)


PathLike.__module__ = 'os'
`
);

/** `os.fspath`: a path as a str or bytes, asking any other object for its `__fspath__`. */
function fspath(value: PyValue): PyValue {
  if (isPath(value)) return value;
  const method = lookupSpecial(value, '__fspath__');
  if (method === undefined) {
    throw typeError(`expected str, bytes or os.PathLike object, not ${typeName(value)}`);
  }
  const result = callValue(bindValue(method, value), []);
  if (isPath(result)) return result;
  throw typeError(`expected ${typeName(value)}.__fspath__() to return str or bytes, not ${typeName(result)}`);
}

function isPath(value: PyValue): boolean {
  const payload = unbox(value);
  return typeof payload === 'string' || (payload instanceof PyBytes && !payload.isMutable);
}

/** `os.fsencode`: a path as bytes in the file system encoding of macOS, UTF-8 with surrogateescape. */
function fsencode(value: PyValue): PyValue {
  const path = fspath(value);
  const payload = unbox(path);
  return typeof payload === 'string' ? newBytes(encodeString(payload, 'utf8', 'surrogateescape')) : path;
}

/** `os.fsdecode`: a path as str, decoded as `os.fsencode` encodes it. */
function fsdecode(value: PyValue): PyValue {
  const path = fspath(value);
  const payload = unbox(path);
  return payload instanceof PyBytes ? decodeBytes(payload.data, 'utf8', 'surrogateescape') : path;
}

registerSourceModule('posixpath', POSIXPATH_SOURCE);
registerExtraAttributes('posixpath', (_runtime, namespace) => {
  for (const [name, nativeName, parameter] of [
    ['normpath', '_path_normpath', 'path'],
    ['splitroot', '_path_splitroot_ex', 'p'],
  ] as const) {
    const implementation = namespace.get(name) as PyValue;
    const wrapper = clinicFunction(
      { name: nativeName, params: [parameter], positionalOnly: 0, required: 1 },
      ([value]) => callValue(implementation, [value as PyValue])
    );
    setBuiltinFunctionModule(wrapper, 'posix');
    namespace.set(name, wrapper);
  }
  return [];
});
registerModuleAlias('os.path', 'posixpath');

function osFunction(
  name: string,
  params: string[],
  required: number,
  run: (args: (PyValue | undefined)[]) => PyValue
): PyValue {
  return nativeFunction(name, (args, kwargs) =>
    run(bindArguments({ qualified: name, params, required, isFunction: true }, args, kwargs))
  );
}
