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

/** The macOS values of `_stat`'s constants that `stat.py` gives other values or lacks. */
const CONSTANTS: [string, bigint][] = [
  ['SF_SETTABLE', 0x3f_ff_00_00n],
  ['SF_SUPPORTED', 0x9f_00_00n],
  ['SF_SYNTHETIC', 0xc0_00_00_00n],
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
