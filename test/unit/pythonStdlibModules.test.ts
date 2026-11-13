import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a computed text differs from the one CPython 3.14.10 gives. */
function expectSameTexts(setup: string, actual: string, expected: string[]): void {
  const program = `${setup}
actual = ${actual}
expected = ${JSON.stringify(expected)}
for a, e in zip(actual, expected):
    if a != e:
        raise ValueError(repr(a) + ' != ' + repr(e))
if len(actual) != len(expected):
    raise ValueError('lengths differ')`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

test('datetime computes, formats, and parses as CPython does', () => {
  expectSameTexts(
    `import datetime as dt
d = dt.datetime(2024, 1, 2, 3, 4, 5, 6789)
jst = dt.timezone(dt.timedelta(hours=9), 'JST')`,
    `[repr(d), str(d - dt.datetime(2023, 12, 31)), d.strftime('%a %b %e %j %U %W %V %G %I%p %c'),
  repr(dt.timedelta(days=1.5, seconds=2.25, microseconds=3.125, milliseconds=4.5, minutes=5.5, hours=6.5, weeks=7.5)),
  repr(dt.timedelta(seconds=1) / 7), str(dt.timedelta(days=-2, microseconds=-100)),
  str(dt.datetime(2024, 1, 2, 3, 4, 5, tzinfo=dt.timezone.utc).astimezone(jst)),
  repr(dt.datetime.fromisoformat('2024-W01-2T10:20:30.5+05:30')), repr(dt.datetime.strptime('02/01/24 3PM', '%d/%m/%y %I%p')),
  str(dt.date(2024, 1, 2).isocalendar()), str(dt.datetime.fromtimestamp(0)), str(dt.datetime(1970, 1, 1, 9).timestamp()),
  str(hash(dt.timedelta(days=1))), str(hash(d.replace(tzinfo=jst))), str(hash(dt.time(1, tzinfo=jst)))]`,
    [
      'datetime.datetime(2024, 1, 2, 3, 4, 5, 6789)',
      '2 days, 3:04:05.006789',
      'Tue Jan  2 002 00 01 01 2024 03AM Tue Jan  2 03:04:05 2024',
      'datetime.timedelta(days=54, seconds=23732, microseconds=254503)',
      'datetime.timedelta(microseconds=142857)',
      '-3 days, 23:59:59.999900',
      '2024-01-02 12:04:05+09:00',
      'datetime.datetime(2024, 1, 2, 10, 20, 30, 500000, tzinfo=datetime.timezone(datetime.timedelta(seconds=19800)))',
      'datetime.datetime(2024, 1, 2, 15, 0)',
      'datetime.IsoCalendarDate(year=2024, week=1, weekday=2)',
      '1970-01-01 09:00:00',
      '0.0',
      '7839147235533974352',
      '-7021615908039106033',
      '-2753564851575319543',
    ]
  );
});

test('clocks are deterministic across runs, advance monotonically, and exclude sleep from CPU time', () => {
  const program = `import datetime, io, time, zipfile
t0_ns, t1_ns = time.time_ns(), time.time_ns()
m0, m1 = time.monotonic(), time.monotonic()
p0, cpu0 = time.perf_counter_ns(), time.process_time_ns()
for _ in range(200):
    pass
cpu1 = time.process_time_ns()
time.sleep(30)
cpu2 = time.process_time_ns()
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as zf:
    zf.writestr('note.txt', 'ok')
if not (t0_ns < t1_ns and m0 < m1 and cpu0 < cpu1 and cpu2 - cpu1 < 1_000_000_000):
    raise ValueError((t0_ns, t1_ns, m0, m1, cpu0, cpu1, cpu2))
if not (30 <= (time.time_ns() - t1_ns) / 1e9 < 31 and 30 <= time.monotonic() - m1 < 31):
    raise ValueError('the clocks did not advance')
print(
    t0_ns, m0, p0, cpu0,
    time.clock_gettime_ns(time.CLOCK_REALTIME),
    time.clock_gettime_ns(time.CLOCK_MONOTONIC),
    time.clock_gettime_ns(time.CLOCK_PROCESS_CPUTIME_ID),
    time.thread_time_ns(),
    datetime.datetime.now().isoformat(),
    datetime.date.today().isoformat(),
    buf.getvalue().hex(),
)`;
  const started = performance.now();
  const first = executeProgram('python', program);
  const second = executeProgram('python', program);
  expect(performance.now() - started).toBeLessThan(5000);
  expect(first).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  expect(second).toEqual(first);
});

test('pprint, textwrap, calendar, and string.Template lay out text as CPython does', () => {
  expectSameTexts(
    `import pprint, textwrap, calendar, string`,
    `[pprint.pformat({'b': list(range(12)), 'a': {'x': 'The quick brown fox jumps over the lazy dog'}}, width=30),
  textwrap.fill('Hello-world well-known e-mail -- dash! It is a test.', 15, initial_indent='* '),
  textwrap.shorten('Hello  world, this is long', width=15), calendar.month(2024, 2),
  string.Template('$who likes \${what}').safe_substitute(who='tim')]`,
    [
      "{'a': {'x': 'The quick brown '\n            'fox jumps over '\n            'the lazy dog'},\n 'b': [0,\n       1,\n       2,\n       3,\n       4,\n       5,\n       6,\n       7,\n       8,\n       9,\n       10,\n       11]}",
      '* Hello-world\nwell-known\ne-mail -- dash!\nIt is a test.',
      'Hello [...]',
      '   February 2024\nMo Tu We Th Fr Sa Su\n          1  2  3  4\n 5  6  7  8  9 10 11\n12 13 14 15 16 17 18\n19 20 21 22 23 24 25\n26 27 28 29\n',
      'tim likes ${what}',
    ]
  );
});

test.each([
  [
    'an abstract method left unimplemented',
    'from abc import ABC, abstractmethod\nclass Shape(ABC):\n    @abstractmethod\n    def area(self): ...\n    @abstractmethod\n    def name(self): ...\nShape()',
    "TypeError: Can't instantiate abstract class Shape without an implementation for abstract methods 'area', 'name'",
  ],
  [
    'a warning turned into an error',
    "import warnings\nwarnings.simplefilter('error')\nwarnings.warn('old', DeprecationWarning)",
    'DeprecationWarning: old',
  ],
  [
    'a Flag value without members',
    'from enum import Flag\nclass P(Flag):\n    R = 1\n    W = 2\nP(8)',
    "ValueError: <flag 'P'> invalid value 8\n    given 0b0 1000\n  allowed 0b0 0011",
  ],
])('%s ends the program as CPython does', (_name, program, uncaughtException) => {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException });
});

test('the program functions a module written in Python calls show as called from the program', () => {
  const program = `from contextlib import contextmanager
@contextmanager
def tag():
    x = 1
    yield x
with tag() as t:
    y = t`;
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ line, callLines }) => [line, callLines])).toEqual([
    [0, []],
    [4, [6]],
    [6, []],
    [7, []],
    [5, [6]],
  ]);
});
