import { pyStr } from '../conversions';
import { builtin } from '../define';
import { registerUnsupportedAttributes } from '../modules';
import { registerSourceModule } from '../sourceModules';
import { newList, newTuple, typeName } from '../types';
import { PyInstance, type PyValue } from '../values';

// The parts of CPython's `traceback` module that do not show the program's file: a traceback names the path of the
// program's file, which differs on every machine, so printing one goes only to stderr, which learners do not see, and
// formatting one as a string stops the program.
const SOURCE = String.raw`
import sys

__all__ = ['print_exc', 'format_exception_only', 'print_exception', 'print_stack']

_sentinel = object()


def format_exception_only(exc, /, value=_sentinel, *, show_group=False, **kwargs):
    if value is _sentinel:
        value = exc
    if value is None:
        return ['NoneType: None\n']
    return _format_exception_only(value, show_group, 0)


def _format_exception_only(value, show_group, depth):
    head, notes = _describe(value)
    indent = 3 * depth * ' '
    if depth > 0:
        lines = [indent + line + '\n' for line in head.split('\n')]
    else:
        lines = [head + '\n']
    for note in notes:
        lines.extend(indent + line + '\n' for line in note.split('\n'))
    if show_group and isinstance(value, BaseExceptionGroup):
        for exception in value.exceptions:
            lines.extend(_format_exception_only(exception, show_group, depth + 1))
    return lines


def _print_lines(lines, file):
    if file is None:
        file = sys.stderr
    if file is not _standard_stderr():
        _unsupported('プログラムのファイル名を含むトレースバックを標準エラー出力以外に書くこと')
    for line in lines:
        print(line, file=file, end='')


def print_exception(exc, /, value=_sentinel, tb=_sentinel, limit=None, file=None, chain=True, **kwargs):
    if value is _sentinel:
        value = exc
    lines = []
    if value is not None:
        lines.append('Traceback (most recent call last):\n')
    lines.extend(format_exception_only(value))
    _print_lines(lines, file)


def print_exc(limit=None, file=None, chain=True):
    print_exception(_handled_exception(), limit=limit, file=file, chain=chain)


def print_stack(f=None, limit=None, file=None):
    _print_lines(['Traceback (most recent call last):\n'], file)
`;

registerSourceModule(
  'traceback',
  SOURCE,
  () =>
    new Map<string, PyValue>([
      [
        '_describe',
        builtin('_describe', 'one', 1, 1, ([value]) => {
          if (!(value instanceof PyInstance) || !value.exception) {
            return newTuple([`${typeName(value)}: ${pyStr(value)}`, newList([])]);
          }
          // Without a traceback to search, CPython suggests no names here.
          const { cls } = value;
          const name = ['__main__', 'builtins'].includes(cls.module)
            ? cls.qualifiedName
            : `${cls.module}.${cls.qualifiedName}`;
          const text = pyStr(value);
          const notes =
            value.exception.notes?.items.map((note) => (typeof note === 'string' ? note : pyStr(note))) ?? [];
          return newTuple([text === '' ? name : `${name}: ${text}`, newList(notes)]);
        }),
      ],
    ])
);

const FORMATTED = 'プログラムのファイル名を含むトレースバックの文字列';
registerUnsupportedAttributes('traceback', {
  format_exc: `${FORMATTED}（traceback.format_exc）`,
  format_exception: `${FORMATTED}（traceback.format_exception）`,
  format_tb: `${FORMATTED}（traceback.format_tb）`,
  format_stack: `${FORMATTED}（traceback.format_stack）`,
  format_list: `${FORMATTED}（traceback.format_list）`,
  extract_tb: 'トレースバックの情報（traceback.extract_tb）',
  extract_stack: 'トレースバックの情報（traceback.extract_stack）',
  walk_tb: 'トレースバックの情報（traceback.walk_tb）',
  walk_stack: 'トレースバックの情報（traceback.walk_stack）',
  print_tb: 'トレースバックの情報（traceback.print_tb）',
  print_list: 'トレースバックの情報（traceback.print_list）',
  print_last: 'traceback.print_last',
  clear_frames: 'traceback.clear_frames',
  TracebackException: 'traceback.TracebackException',
  StackSummary: 'traceback.StackSummary',
  FrameSummary: 'traceback.FrameSummary',
});
