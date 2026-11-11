import { registerModule } from '../modules';
import { checkArgs } from '../nativeArgs';
import { toIndex } from '../numbers';
import { nativeFunction, pyError } from '../types';
import type { PyValue } from '../values';

/** The file type tests of CPython's `_stat`, with the `S_IF*` bits of macOS each one checks. */
const TYPE_TESTS: [string, number][] = [
  ['S_ISDIR', 0o04_0000],
  ['S_ISCHR', 0o02_0000],
  ['S_ISBLK', 0o06_0000],
  ['S_ISREG', 0o10_0000],
  ['S_ISFIFO', 0o01_0000],
  ['S_ISLNK', 0o12_0000],
  ['S_ISSOCK', 0o14_0000],
  ['S_ISDOOR', -1],
  ['S_ISPORT', -1],
  ['S_ISWHT', 0o16_0000],
];

/** The constants of CPython's `_stat` on macOS. */
const CONSTANTS: [string, bigint][] = [
  ['SF_APPEND', 262_144n],
  ['SF_ARCHIVED', 65_536n],
  ['SF_DATALESS', 1_073_741_824n],
  ['SF_FIRMLINK', 8_388_608n],
  ['SF_IMMUTABLE', 131_072n],
  ['SF_NOUNLINK', 1_048_576n],
  ['SF_SETTABLE', 1_073_676_288n],
  ['SF_SNAPSHOT', 2_097_152n],
  ['SF_SUPPORTED', 10_420_224n],
  ['SF_SYNTHETIC', 3_221_225_472n],
  ['ST_ATIME', 7n],
  ['ST_CTIME', 9n],
  ['ST_DEV', 2n],
  ['ST_GID', 5n],
  ['ST_INO', 1n],
  ['ST_MODE', 0n],
  ['ST_MTIME', 8n],
  ['ST_NLINK', 3n],
  ['ST_SIZE', 6n],
  ['ST_UID', 4n],
  ['S_ENFMT', 1024n],
  ['S_IEXEC', 64n],
  ['S_IFBLK', 24_576n],
  ['S_IFCHR', 8192n],
  ['S_IFDIR', 16_384n],
  ['S_IFDOOR', 0n],
  ['S_IFIFO', 4096n],
  ['S_IFLNK', 40_960n],
  ['S_IFPORT', 0n],
  ['S_IFREG', 32_768n],
  ['S_IFSOCK', 49_152n],
  ['S_IFWHT', 57_344n],
  ['S_IREAD', 256n],
  ['S_IRGRP', 32n],
  ['S_IROTH', 4n],
  ['S_IRUSR', 256n],
  ['S_IRWXG', 56n],
  ['S_IRWXO', 7n],
  ['S_IRWXU', 448n],
  ['S_ISGID', 1024n],
  ['S_ISUID', 2048n],
  ['S_ISVTX', 512n],
  ['S_IWGRP', 16n],
  ['S_IWOTH', 2n],
  ['S_IWRITE', 128n],
  ['S_IWUSR', 128n],
  ['S_IXGRP', 8n],
  ['S_IXOTH', 1n],
  ['S_IXUSR', 64n],
  ['UF_APPEND', 4n],
  ['UF_COMPRESSED', 32n],
  ['UF_DATAVAULT', 128n],
  ['UF_HIDDEN', 32_768n],
  ['UF_IMMUTABLE', 2n],
  ['UF_NODUMP', 1n],
  ['UF_NOUNLINK', 16n],
  ['UF_OPAQUE', 8n],
  ['UF_SETTABLE', 65_535n],
  ['UF_TRACKED', 64n],
];

/** The type letters of `filemode`, in the order `_stat.c`'s `filetype` tests them. */
const TYPE_LETTERS: [number, string][] = [
  [0o10_0000, '-'],
  [0o04_0000, 'd'],
  [0o12_0000, 'l'],
  [0o02_0000, 'c'],
  [0o06_0000, 'b'],
  [0o01_0000, 'p'],
  [0o14_0000, 's'],
  [0o16_0000, 'w'],
];

// CPython's `_stat` module, which `stat.py` imports over its own definitions.
registerModule('_stat', () => {
  const entries = new Map<string, PyValue>();
  const define = (name: string, run: (mode: number) => PyValue): void => {
    const spec = { qualified: `_stat.${name}`, min: 1, max: 1, style: 'one' } as const;
    entries.set(
      name,
      nativeFunction(name, (args, kwargs) => {
        checkArgs(spec, args, kwargs);
        return run(modeOf(args[0] as PyValue));
      })
    );
  };
  for (const [name, type] of TYPE_TESTS) define(name, (mode) => (mode & 0o17_0000) === type);
  define('S_IMODE', (mode) => BigInt(mode & 0o7777));
  define('S_IFMT', (mode) => BigInt(mode & 0o17_0000));
  define('filemode', fileMode);
  for (const [name, value] of CONSTANTS) entries.set(name, value);
  return entries;
});

/** `_PyLong_AsMode_t`: the argument as macOS's 16-bit `mode_t`. */
function modeOf(value: PyValue): number {
  const mode = toIndex(value);
  if (mode < 0n) throw pyError('OverflowError', "can't convert negative value to unsigned int");
  if (mode > 0xff_ff_ff_ff_ff_ff_ff_ffn) {
    throw pyError('OverflowError', 'Python int too large to convert to C unsigned long');
  }
  if (mode > 0xff_ffn) throw pyError('OverflowError', 'mode out of range');
  return Number(mode);
}

/** `_stat.filemode`: the type letter, then the permission letters with the set-id and sticky bits. */
function fileMode(mode: number): string {
  const type = TYPE_LETTERS.find(([bits]) => (mode & 0o17_0000) === bits)?.[1] ?? '?';
  return `${type}${permissions(mode >> 6, mode & 0o4000, 's')}${permissions(mode >> 3, mode & 0o2000, 's')}${permissions(mode, mode & 0o1000, 't')}`;
}

function permissions(bits: number, special: number, mark: string): string {
  const executable = (bits & 1) === 1;
  let execute = executable ? 'x' : '-';
  if (special !== 0) execute = executable ? mark : mark.toUpperCase();
  return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${execute}`;
}
