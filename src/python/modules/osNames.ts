import { CONFSTR_NAMES, ERROR_MESSAGES, OS_ALL, OS_CONSTANTS, PATHCONF_NAMES, SYSCONF_NAMES } from '../data/osValues';
import { builtin } from '../define';
import {
  registerExtraAttributes,
  registerModuleAll,
  registerSharedAttributes,
  registerUnsupportedAttributes,
} from '../modules';
import { argument } from '../nativeArgs';
import { toIndex } from '../numbers';
import { intClass, isInstanceOf, newDict, pyError, typeError, typeName, valueError } from '../types';
import type { Kwargs, PyValue } from '../values';

// The names of os that need no file system, environment, or process: its constants and tables, the wait status
// macros, the device number functions, and strerror, with macOS's values. The others raise the unsupported error.

registerExtraAttributes('os', () => [
  ...OS_CONSTANTS,
  ['confstr_names', table(CONFSTR_NAMES)],
  ['pathconf_names', table(PATHCONF_NAMES)],
  ['sysconf_names', table(SYSCONF_NAMES)],
  ['supports_bytes_environ', true],
  ...WAIT_MACROS.map(([name, read]): [string, PyValue] => [name, statusFunction(name, read)]),
  ['waitstatus_to_exitcode', statusFunction('waitstatus_to_exitcode', (status) => BigInt(exitCode(status)))],
  ['major', builtin('major', 'takes', 0, 1, (args, kwargs) => BigInt((device(args, kwargs) >>> 24) & 0xff), DEVICE)],
  ['minor', builtin('minor', 'takes', 0, 1, (args, kwargs) => BigInt(device(args, kwargs) & 0xff_ff_ff), DEVICE)],
  ['makedev', builtin('makedev', 'expected', 2, 2, ([major, minor]) => makedev(major, minor))],
  ['strerror', builtin('strerror', 'one', 1, 1, ([code]) => strerror(code))],
]);
registerSharedAttributes('os', {
  error: 'builtins:OSError',
  GenericAlias: 'types:GenericAlias',
  Mapping: 'collections.abc:Mapping',
  MutableMapping: 'collections.abc:MutableMapping',
});
registerModuleAll('os', OS_ALL);

const DEVICE = { keywords: ['device'] };

function table(entries: [string, bigint][]): PyValue {
  const dict = newDict();
  for (const [key, value] of entries) dict.store.set(key, value);
  return dict;
}

// Wait statuses ------------------------------------------------------------------------------------------------------

/** The `<sys/wait.h>` macros of macOS, on a status as a C int. */
const WAIT_MACROS: [string, (status: number) => PyValue][] = [
  ['WIFEXITED', (status) => (status & 0x7f) === 0],
  ['WEXITSTATUS', (status) => BigInt((status >> 8) & 0xff)],
  ['WIFSIGNALED', (status) => (status & 0x7f) !== 0x7f && (status & 0x7f) !== 0],
  ['WTERMSIG', (status) => BigInt(status & 0x7f)],
  ['WIFSTOPPED', (status) => (status & 0x7f) === 0x7f && status >> 8 !== 0x13],
  ['WSTOPSIG', (status) => BigInt(status >> 8)],
  ['WIFCONTINUED', (status) => (status & 0x7f) === 0x7f && status >> 8 === 0x13],
  ['WCOREDUMP', (status) => (status & 0x80) !== 0],
];

function statusFunction(name: string, read: (status: number) => PyValue): PyValue {
  return builtin(
    name,
    'takes',
    0,
    1,
    (args, kwargs) => {
      const status = argument(args, kwargs, 0, 'status');
      if (status === undefined) throw typeError(`${name}() missing required argument 'status' (pos 1)`);
      return read(cInt(status));
    },
    { keywords: ['status'] }
  );
}

function exitCode(status: number): number {
  if ((status & 0x7f) === 0) return (status >> 8) & 0xff;
  if ((status & 0x7f) !== 0x7f) return -(status & 0x7f);
  if (status >> 8 !== 0x13) throw valueError(`process stopped by delivery of signal ${status >> 8}`);
  throw valueError(`invalid wait status: ${status}`);
}

function cInt(value: PyValue): number {
  const integer = index(value);
  if (integer < -(2n ** 31n) || integer >= 2n ** 31n) {
    throw pyError('OverflowError', 'Python int too large to convert to C int');
  }
  return Number(integer);
}

function index(value: PyValue): bigint {
  if (!isInstanceOf(value, intClass)) {
    throw typeError(`'${typeName(value)}' object cannot be interpreted as an integer`);
  }
  return toIndex(value);
}

// Device numbers -----------------------------------------------------------------------------------------------------

/** A `dev_t` argument, a 32-bit int on macOS, of which -1 is the only negative value accepted. */
function devT(value: PyValue): number {
  const integer = index(value);
  if (integer === -1n) return -1;
  if (integer < 0n) throw pyError('OverflowError', "can't convert negative int to unsigned");
  if (integer >= 2n ** 31n) throw pyError('OverflowError', 'Python int too large to convert to C dev_t');
  return Number(integer);
}

function device(args: PyValue[], kwargs: Kwargs): number {
  const value = argument(args, kwargs, 0, 'device');
  if (value === undefined) throw typeError("missing required argument 'device' (pos 1)");
  return devT(value);
}

/** `makedev(major, minor)`, a dev_t that CPython converts as unsigned, except -1. */
function makedev(major: PyValue, minor: PyValue): PyValue {
  const dev = (devT(major) << 24) | devT(minor);
  return dev === -1 ? -1n : BigInt.asUintN(64, BigInt(dev));
}

function strerror(code: PyValue): string {
  const number = cInt(code);
  return ERROR_MESSAGES[number] ?? `Unknown error: ${number}`;
}

// The names that need the file system, the environment, or processes -------------------------------------------------

const UNSUPPORTED: [string, string[]][] = [
  [
    'ファイルやディレクトリの操作',
    [
      'DirEntry',
      'chflags',
      'chroot',
      'closerange',
      'dup',
      'dup2',
      'fchdir',
      'fchmod',
      'fchown',
      'fdopen',
      'fpathconf',
      'fstat',
      'fstatvfs',
      'fsync',
      'ftruncate',
      'get_blocking',
      'get_inheritable',
      'lchflags',
      'lchmod',
      'lchown',
      'lockf',
      'lseek',
      'mkfifo',
      'mknod',
      'pathconf',
      'pread',
      'preadv',
      'pwrite',
      'pwritev',
      'readinto',
      'readv',
      'sendfile',
      'set_blocking',
      'set_inheritable',
      'stat_result',
      'statvfs',
      'statvfs_result',
      'supports_dir_fd',
      'supports_fd',
      'supports_follow_symlinks',
      'sync',
      'writev',
    ],
  ],
  ['環境変数', ['get_exec_path', 'reload_environ']],
  [
    'プロセスやシステムの情報',
    [
      'confstr',
      'getgrouplist',
      'getgroups',
      'getloadavg',
      'getpgid',
      'getpgrp',
      'getpriority',
      'getsid',
      'initgroups',
      'nice',
      'process_cpu_count',
      'sched_get_priority_max',
      'sched_get_priority_min',
      'sched_yield',
      'setegid',
      'seteuid',
      'setgid',
      'setgroups',
      'setpgid',
      'setpgrp',
      'setpriority',
      'setregid',
      'setreuid',
      'setsid',
      'setuid',
      'supports_effective_ids',
      'sysconf',
      'times_result',
      'uname_result',
    ],
  ],
  [
    'ほかのプログラムの実行',
    [
      'execle',
      'execlp',
      'execlpe',
      'execve',
      'execvp',
      'execvpe',
      'forkpty',
      'posix_spawn',
      'posix_spawnp',
      'register_at_fork',
      'spawnl',
      'spawnle',
      'spawnlp',
      'spawnlpe',
      'spawnv',
      'spawnve',
      'spawnvp',
      'spawnvpe',
      'wait',
      'wait3',
      'wait4',
      'waitid',
      'waitid_result',
      'waitpid',
    ],
  ],
  [
    '端末',
    [
      'ctermid',
      'device_encoding',
      'grantpt',
      'isatty',
      'login_tty',
      'openpty',
      'posix_openpt',
      'ptsname',
      'tcgetpgrp',
      'tcsetpgrp',
      'terminal_size',
      'ttyname',
      'unlockpt',
    ],
  ],
  ['シグナル', ['killpg']],
];

registerUnsupportedAttributes(
  'os',
  Object.fromEntries(
    UNSUPPORTED.flatMap(([feature, names]) => names.map((name) => [name, `os.${name}（${feature}）`] as const))
  )
);
