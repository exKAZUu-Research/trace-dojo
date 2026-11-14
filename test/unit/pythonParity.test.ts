import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'pythonParity');

// Each fixture checks its own results and raises on a difference; CPython 3.14.10 runs all of them without raising.
test.each(fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.py')))('%s runs as in CPython', (name) => {
  const program = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['a set updated from an endless iterator', 'import itertools\nset().update(itertools.repeat(0))'],
  ['a set difference with an endless iterator', 'import itertools\nset().difference_update(itertools.repeat(0))'],
  ['a rejection loop that never accepts', 'import random\nrandom.gammavariate(float("nan"), 1)'],
  [
    'counting copies equal to a long string',
    's = "a" * 999999\nl = [s] * 200000\nt = "a" * 999998 + "a"\nx = l.count(t)',
  ],
  [
    'comparing deeply shared dicts',
    "a = {'v': 0}\nb = {'v': 0}\nfor i in range(27):\n    a = {'x': a, 'y': a}\n    b = {'x': b, 'y': b}\na == b",
  ],
  [
    'repeated decimal conversions of a huge int with the digit limit off',
    'import sys\nsys.set_int_max_str_digits(0)\nn = 1 << 3000000\nfor i in range(100):\n    x = str(n)',
  ],
  ['a print of many long strings', 'print(*(["x" * 1000000] * 1000))'],
  [
    'a modular inverse of huge integers',
    'import random\nrandom.seed(1)\na = random.getrandbits(1000000)\nb = random.getrandbits(1000000)\npow(a, -1, b)',
  ],
  ['a dict built from endless pairs', 'import itertools\ndict(itertools.repeat([1, 2]))'],
  ['a dict updated from endless pairs', 'import itertools\n{}.update(itertools.repeat((1, 2)))'],
  [
    'a dict view tested against an endless disjoint iterator',
    'import itertools\n{1: 2}.keys().isdisjoint(itertools.repeat(3))',
  ],
  [
    'the gcd of huge integers',
    'import math, random\nmath.gcd(random.getrandbits(1000000), random.getrandbits(1000000))',
  ],
  [
    'the lcm of huge integers',
    'import math, random\nmath.lcm(random.getrandbits(1000000), random.getrandbits(1000000))',
  ],
  ['a dict of keys with one hash', 'd = dict.fromkeys([i * 2305843009213693951 for i in range(50000)])'],
  ['a set of items with one hash', 's = set([i * 2305843009213693951 for i in range(50000)])'],
  [
    'the mode of values with one hash',
    'import statistics\nstatistics.mode([i * 2305843009213693951 for i in range(50000)])',
  ],
  ['the mean of huge integers', 'import statistics\nstatistics.mean([2**1000000] * 500000)'],
  ['a slice far into an endless iterator', 'import itertools\nnext(itertools.islice(itertools.count(), 10**12, None))'],
  ['a filterfalse that rejects every item', 'import itertools\nnext(itertools.filterfalse(None, itertools.repeat(1)))'],
  ['a dropwhile that drops every item', 'import itertools\nnext(itertools.dropwhile(bool, itertools.repeat(1)))'],
  [
    'a compress that selects nothing',
    'import itertools\nnext(itertools.compress(itertools.repeat(1), itertools.repeat(0)))',
  ],
  ['a group that never ends', 'import itertools\ng = itertools.groupby(itertools.repeat(0))\nnext(g)\nnext(g)'],
  ['a chain of endless empty iterables', 'import itertools\nnext(itertools.chain.from_iterable(itertools.repeat([])))'],
  ['a batch of an endless iterator', 'import itertools\nnext(itertools.batched(itertools.repeat(0), 10**9))'],
  [
    'a sum of products of endless iterators',
    'import itertools, math\nmath.sumprod(itertools.repeat(1), itertools.repeat(1))',
  ],
  ['a sequence pattern matched against a huge range', 'match range(10**12):\n    case [a, *b]:\n        pass'],
  ['the elements of a huge count', 'from collections import Counter\nx = list(Counter(a=10**12).elements())'],
  ['a generator seeded with a long string over and over', 'import random\nwhile True:\n    random.seed("x" * 1000000)'],
  [
    'a generator seeded with a huge int over and over',
    'import random\nx = 1 << 7999999\nwhile True:\n    random.seed(x)',
  ],
  [
    'a backward search for a long needle over and over',
    "s = 'a' * 1000000\nt = 'a' * 500000 + 'b'\nwhile True:\n    s.rfind(t)",
  ],
  ['a prefix test of many long candidates', "s = 'x' * 500000\np = ('x' * 499999 + 'y',) * 5000\ns.startswith(p)"],
  ['a suffix test of many long candidates', "s = 'x' * 500000\np = ('x' * 499999 + 'y',) * 5000\ns.endswith(p)"],
  ['a binomial coefficient of a huge size', 'import math\nmath.comb(10**6, 5 * 10**5)'],
  [
    'inserting and popping at the front of a long list over and over',
    'a = list(range(100000))\nfor i in range(400):\n    a.insert(0, i)\n    a.pop(0)',
  ],
  [
    'deleting and inserting at the front of a long list over and over',
    'a = list(range(100000))\nfor i in range(400):\n    del a[0]\n    a.insert(0, 1)',
  ],
  [
    'reversing a long deque over and over',
    'from collections import deque\na = deque(range(100000))\nfor i in range(700):\n    a.reverse()',
  ],
  [
    'the most common item of a large counter over and over',
    'from collections import Counter\nc = Counter(range(10000))\nfor i in range(120):\n    c.most_common(1)',
  ],
])('%s ends at the execution limit', (_name, program) => {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'limitExceeded' });
});

// Each search repeats a prefix of the needle throughout the text, the worst case of a naive search and of V8's
// lastIndexOf, which take time growing with the product of the lengths.
test.each([
  [
    'a search among supplementary characters',
    "s = '😀' * 100000 + 'a'\nt = '😀' * 50000 + 'b'\nr = [s.find(t), s.rfind(t), s.count(t), t in s, s.rsplit(t), s.rpartition(t)[1]]\nif r != [-1, -1, 0, False, [s], '']:\n    raise AssertionError(r)",
  ],
  [
    'a search for a repetitive needle',
    "s = 'a' * 1000000\nt = 'a' * 500000 + 'b'\nr = [s.find(t), s.rfind(t), s.index(t[:-1]), s.rfind(t[:-1]), s.count(t), s.replace(t, '') == s, s.rsplit(t)[0] == s]\nif r != [-1, -1, 0, 500000, 0, True, True]:\n    raise AssertionError(r)",
  ],
  [
    'a backward search for a needle that starts with a mismatch',
    "s = 'a' * 1000000\nt = 'b' + 'a' * 500000\nr = [s.rfind(t), s.rpartition(t)[0], t in s]\nif r != [-1, '', False]:\n    raise AssertionError(r)",
  ],
  [
    'a search for a periodic needle',
    "s = '😀a' * 300000\nt = '😀a' * 100000 + '😀b'\nr = [s.find(t), s.rfind(t), s.rfind(t, 3, 500000), s.count(t)]\nif r != [-1, -1, -1, 0]:\n    raise AssertionError(r)",
  ],
  [
    'a precision applied to a long string by many fields',
    "s = 'x' * 500000\nr = [len(('{0:.1}' * 5000).format(s)), len('%.1s' * 5000 % ((s,) * 5000))]\nif r != [5000, 5000]:\n    raise AssertionError(r)",
  ],
])('%s finishes within the limits', (_name, program) => {
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['a huge random.choices result', 'import random\nx = random.choices([1], k=1000001)'],
  ['a huge random integer', 'import random\nx = random.getrandbits(9000000)'],
  ['a huge format width', 'format(1, "01000000000000,")'],
  [
    'arguments bound by functools.partial beside a list beyond the slot limit',
    'from functools import partial\ndef f(*args):\n    pass\np = partial(f, *([0] * 400000))\na = [0] * 500000',
  ],
  // A list of 960000 items leaves room for 25000 more items, or 45000 dict entries, only when what they hold is free.
  ['ranges kept beside a list beyond the slot limit', 'b = [0] * 960000\na = list(map(range, range(25000)))'],
  ['slices kept beside a list beyond the slot limit', 'b = [0] * 960000\na = [slice(i) for i in range(25000)]'],
  [
    'complex numbers kept beside a list beyond the slot limit',
    'b = [0] * 960000\na = [complex(i, 1) for i in range(25000)]',
  ],
  [
    'a dict comprehension and a list beyond the slot limit together',
    'a = [0] * 960000\nd = {i: i for i in range(45000)}',
  ],
  [
    'a dict filled by assignment and a list beyond the slot limit together',
    'a = [0] * 960000\nd = {}\nfor i in range(45000):\n    d[i] = i',
  ],
  ['a copy of a list beyond the slot limit together', 'a = [0] * 800000\nb = a.copy()'],
  ['a copy.copy of a list beyond the slot limit together', 'import copy\na = [0] * 800000\nb = copy.copy(a)'],
  ['a deep copy of a list beyond the slot limit together', 'import copy\na = [0] * 800000\nb = copy.deepcopy(a)'],
  ['a slice of a list beyond the slot limit together', 'a = [0] * 800000\nb = a[:]'],
  ['copies of a bytearray beyond the slot limit together', 'b = bytearray(1000000)\nx = [bytes(b) for _ in range(32)]'],
  ['slices of a bytes beyond the slot limit together', 'b = bytes(1000000)\nx = [b[1:] for _ in range(32)]'],
  ['a list repeated in place beyond memory', 'x = [1]\nx *= 100000000'],
  ['a deque repeated in place beyond memory', 'from collections import deque\nd = deque([1])\nd *= 1000000000'],
  ['a product with a huge repeat', 'import itertools\nitertools.product([1], repeat=10**12)'],
  ['a product of an empty pool with a huge repeat', 'import itertools\nitertools.product([], repeat=10**12)'],
  ['a huge number of tee iterators', 'import itertools\nitertools.tee([], 10**12)'],
  ['more tee iterators than slots', 'import itertools\nitertools.tee([], 1000001)'],
  [
    'combinations with replacement of a huge size',
    'import itertools\nnext(itertools.combinations_with_replacement([1], 10**12))',
  ],
  ['a JSON text of many long strings', 'import json\nx = json.dumps(["x" * 100000] * 2000)'],
  [
    'a JSON text of long dict values',
    'import json\ns = "x" * 100000\nx = json.dumps({str(i): s for i in range(2000)})',
  ],
  ['a JSON text with a huge indent', 'import json\nx = json.dumps([[[[1]]]] * 1000, indent=100000)'],
  ['a str filled with zeros to a huge width', 'x = "x".zfill(1000000000)'],
  ['a str filled with zeros beyond what the host can hold', 'x = "x".zfill(10000000000)'],
  ['a tab expanded to a huge size', String.raw`x = "\t".expandtabs(1000000000)`],
  ['a tab expanded beyond what the host can hold', String.raw`x = "\t".expandtabs(10000000000)`],
  ['a str justified to a huge width', 'x = "x".rjust(10000000000, "*")'],
  ['a translation that grows a str beyond the limit', 'x = ("x" * 1000).translate({120: "y" * 1001})'],
  ['a replacement that grows a str beyond the limit', 'x = ("x" * 1000).replace("", "y" * 1001)'],
  ['a repr that grows a str beyond the limit', String.raw`x = repr("\0" * 300000)`],
  ['an upper-casing that grows a str beyond the limit', 'x = ("ß" * 600000).upper()'],
  ['the binary digits of a huge int', 'x = bin(1 << 1000000)'],
  ['a complex number padded to a huge width', 'x = format(complex(1, 2), ">1000000000")'],
  ['a bytes zero-filled to a huge width', "x = b'x'.zfill(1000001)"],
  ['a StringIO written far past its end', "from io import StringIO\ns = StringIO()\ns.seek(2000000)\ns.write('x')"],
  ['a BytesIO written far past its end', "from io import BytesIO\nb = BytesIO()\nb.seek(10 ** 12)\nb.write(b'x')"],
  [
    'a Decimal quantized to a huge exponent',
    "from decimal import Decimal, Context\nx = Decimal(1).quantize(Decimal('1e-2000000'), context=Context(prec=2000001))",
  ],
  ['a bytearray zero-filled to a huge width', "x = bytearray(b'-x').zfill(10 ** 12)"],
  ['a bytes percent field padded to a huge width', "x = b'%1000000000s' % b'x'"],
  ['a Decimal formatted with a huge exponent', "from decimal import Decimal\nx = format(Decimal('1e-1000001'), 'f')"],
  ['the repr of a deque of long strings', 'from collections import deque\nx = repr(deque(["x" * 1000] * 1001))'],
  ['a long string padded by many fields', "s = 'x' * 500000\nx = ('{0:>3}' * 5000).format(s)"],
  ['a long string formatted by many percent fields', "s = 'x' * 500000\nx = '%5s' * 5000 % ((s,) * 5000)"],
  ['the permutations of a huge int', 'import math\nx = math.perm(1 << 4000000, 100)'],
  ['the permutations of a large int', 'import math\nx = math.perm(1 << 1000000, 10)'],
  ['the combinations of a large int', 'import math\nx = math.comb(1 << 1000000, 10)'],
  [
    'the items a cycle saves and a list beyond the slot limit together',
    'import itertools\nc = itertools.cycle(range(300000))\ns = sum(itertools.islice(c, 300000))\na = [0] * 800000',
  ],
  [
    'the pool of a product and a list beyond the slot limit together',
    'import itertools\np = itertools.product(range(300000))\na = [0] * 800000',
  ],
  [
    'the pool of permutations and a list beyond the slot limit together',
    'import itertools\np = itertools.permutations(range(300000))\na = [0] * 800000',
  ],
  [
    'the pool of combinations and a list beyond the slot limit together',
    'import itertools\np = itertools.combinations(range(300000), 1)\na = [0] * 800000',
  ],
])('%s raises MemoryError', (_name, program) => {
  expect(executeOnStillClock(program)).toMatchObject({ uncaughtException: 'MemoryError' });
});

test('a long text built from many pieces is charged for its length, not for each piece', () => {
  const program = `lengths = [
    len(str(list(range(100000)))),
    len(str({i: i for i in range(20000)})),
    len(("x" * 400000).replace("x", "yy")),
    len(("x\\t" * 100000).expandtabs(4)),
    len(("x" * 400000).translate({120: "yy"})),
    len(bytes(400000).hex()),
]
if lengths != [688890, 257780, 800000, 400000, 800000, 800000]:
    raise AssertionError(str(lengths))`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('containers built in different ways are each charged once', () => {
  // Ten containers of 99,000 items fit in the slot limit only when none of them is charged twice.
  const program = `import copy
from collections import deque
a = [0] * 99000
containers = [a.copy(), copy.copy(a), copy.deepcopy(a), a[:], list(a), tuple(a), sorted(a), a + [], deque(a)]
if [len(container) for container in containers] != [99000] * 9:
    raise AssertionError("wrong length")`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a bounded deque repeated a billion times keeps its last items without running the rounds', () => {
  const program = `from collections import deque
d = deque([1, 2], maxlen=3)
d *= 1000000000
if list(d) != [2, 1, 2] or list(deque([1, 2, 3], maxlen=2) * 1000000001) != [2, 3]:
    raise AssertionError(str(d))`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a huge int is refused before its decimal conversion', () => {
  const program = `n = 1 << 7999999
for i in range(100):
    try:
        x = str(n)
    except ValueError:
        pass`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['sorting many references to one long string', 's = "x" * 100000\nx = sorted([s] * 10000)'],
  ['counting equal copies of a long string', 'a = "a" * 100000\nl = [a] * 30000\nx = l.count("a" * 99999 + "a")'],
  [
    'draining a deque from the left',
    'from collections import deque\nq = deque(range(100000))\nwhile q:\n    q.popleft()',
  ],
  [
    'filling a deque from the left',
    'from collections import deque\nr = deque()\nfor i in range(100000):\n    r.appendleft(i)',
  ],
  [
    'alternating both ends of a deque',
    'from collections import deque\nq = deque(range(1000))\nfor i in range(100000):\n    q.appendleft(i)\n    q.pop()',
  ],
  [
    'sorting long strings that differ at their first character',
    'a = "a" + "x" * 9999\nb = "b" + "x" * 9999\nx = sorted([a, b] * 5000)',
  ],
  [
    'sorting long strings outside the BMP that differ at their first character',
    'a = "a" + "😀" * 5000\nb = "b" + "😀" * 5000\nx = sorted([a, b] * 5000)',
  ],
  ['building an int from many bytes', 'x = int.from_bytes([255] * 300000, byteorder="big")'],
  [
    'peeking and draining a deque',
    'from collections import deque\nq = deque(range(50000))\ns = 0\nwhile q:\n    s += q[0]\n    q.popleft()',
  ],
  [
    'rotating a large deque one place at a time both ways',
    'from collections import deque\nd = deque(range(100000))\nfor i in range(10000):\n    d.rotate(1)\n    d.rotate(-1)\nif d[0] != 0:\n    raise ValueError(d[0])',
  ],
])('%s runs within the limits', (_name, program) => {
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('JSON output up to the string limit is allowed', () => {
  const program = `import json
class Wrapped:
    pass
lengths = [
    len(json.dumps(['a' * 999996])),
    len(json.dumps({'k': 'a' * 999991})),
    len(json.dumps(Wrapped(), default=lambda value: 'a' * 999998)),
]
if lengths != [1000000, 1000000, 1000000]:
    raise ValueError(str(lengths))`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a misspelled name in from-import gets the suggestion CPython gives', () => {
  expect(executeProgram('python', 'from sys import maxsiz')).toMatchObject({
    uncaughtException:
      "ImportError: cannot import name 'maxsiz' from 'sys' (unknown location). Did you mean: 'maxsize'?",
  });
});

test.each([
  {
    name: 'a key function called by sorted and map',
    program: 'def kf(x):\n    r = x * 2\n    return r\na = sorted([3, 1, 2], key=kf)\nb = list(map(kf, [1, 2]))',
    steps: ['0:', '2:4', '2:4', '2:4', '4:', '2:5', '2:5', '5:'],
  },
  {
    name: 'a generator consumed by sum',
    program: 'def gen(n):\n    for i in range(n):\n        v = i * 2\n        yield v\ntotal = sum(gen(3))',
    steps: ['0:', '2:5', '3:5', '4:5', '2:5', '3:5', '4:5', '2:5', '3:5', '4:5', '5:'],
  },
])('steps of $name are called from the line of the call that runs them', ({ program, steps }) => {
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ line, callLines }) => `${line}:${callLines.join(',')}`)).toEqual(steps);
});

// Each text passes the predicate, so it reads every character; one failing at the first character reads one.
test.each([
  ['isascii', "'x' * 1000000", "'é' + 'x' * 999999"],
  ['isprintable', "'x' * 1000000", String.raw`'\0' + 'x' * 999999`],
  ['isidentifier', "'x' * 1000000", "'!' + 'x' * 999999"],
  ['isupper', "'X' * 1000000", "'x' + 'X' * 999999"],
  ['islower', "'x' * 1000000", "'X' + 'x' * 999999"],
  ['istitle', "'X' + 'x' * 999999", "'x' * 1000000"],
  ['isalpha', "'x' * 1000000", "'1' + 'x' * 999999"],
  ['isdecimal', "'1' * 1000000", "'x' + '1' * 999999"],
  ['isdigit', "'1' * 1000000", "'x' + '1' * 999999"],
  ['isnumeric', "'1' * 1000000", "'x' + '1' * 999999"],
  ['isalnum', "'x' * 1000000", "'!' + 'x' * 999999"],
  ['isspace', "' ' * 1000000", "'x' + ' ' * 999999"],
])('str.%s is charged for the characters it reads', (method, passing, failing) => {
  const program = (text: string): string => `s = ${text}\nfor i in range(70):\n    s.${method}()`;
  expect(executeOnStillClock(program(passing))).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  expect(executeOnStillClock(program(failing))).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['startswith', "'a'", "'a'"],
  ['endswith', "'a'", "'a'"],
  ['startswith', "'😀'", "'😀', len(s) - 1"],
  ['endswith', "'😀'", "'😀'"],
])('str.%s of a short candidate in %s text is charged for the candidate only', (method, letter, args) => {
  const program = `s = ${letter} * 250000\nfor i in range(10000):\n    v = s.${method}(${args})`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each(['s[::-1]', 's[::2]', 's[1:]'])(
  'slicing a long text, %s, over and over ends at the operation limit',
  (slice) => {
    const program = `s = 'a' * 500000\nfor i in range(300):\n    v = ${slice}`;
    expect(executeOnStillClock(program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test.each([
  "s.find('a')",
  "s.rfind('a')",
  "'a' in s",
  "s.split('a', 0)",
  "s.rsplit('a', 0)",
  'u.find(s)',
  'u.count(s)',
  's in u',
])('a search of a long text that stops at once, %s, is charged for what it reads', (search) => {
  const program = `s = 'a' * 500000\nu = 'a'\nfor i in range(10000):\n    v = ${search}`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['a list', 'a = list(range(100000))', '0 in a'],
  ['a tuple', 'a = tuple(range(100000))', '0 in a'],
  ['a larger set under a smaller one', 'a = set(range(100000))\nb = set()', 'a <= b'],
  ['issubset of a larger set', 'a = set(range(100000))\nb = set()', 'a.issubset(b)'],
  ['issuperset of a larger set', 'a = set(range(50000))\nb = set(range(100000))', 'a.issuperset(b)'],
  ['isdisjoint of a small set and a large one', 'a = {-1}\nb = set(range(100000))', 'a.isdisjoint(b)'],
  ['isdisjoint of a small keys view and a large set', 'd = {-1: 0}\nb = set(range(100000))', 'd.keys().isdisjoint(b)'],
  ['a keys view under a set', 'd = dict.fromkeys(range(100000))\ns = set(range(1, 100001))', 'd.keys() <= s'],
  [
    'a keys view under a keys view',
    'd = dict.fromkeys(range(100000))\ne = dict.fromkeys(range(1, 100001))',
    'd.keys() <= e.keys()',
  ],
])('a test of %s decided at once is charged only for what it reads', (_name, setup, test) => {
  const program = `${setup}\nfor i in range(5000):\n    x = ${test}`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each(['startswith', 'endswith'])('str.%s of a long candidate that differs at once compares no more', (method) => {
  const program = `s = 'b' + 'a' * 499999\nt = 'a' * 500000\nfor i in range(10000):\n    v = s.${method}(t)`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each(['upper', 'lower', 'casefold', 'swapcase', 'capitalize', 'title'])(
  'str.%s of a long text over and over ends at the operation limit',
  (method) => {
    const program = `s = 'x' * 100000\nfor i in range(700):\n    s.${method}()`;
    expect(executeOnStillClock(program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  }
);

test.each([
  [
    'a long tuple looked up as a key over and over',
    't = tuple(range(10000))\nd = {t: 1}\nfor i in range(3000):\n    x = d[t]',
  ],
  ['a deeply shared tuple', 't = (0,)\nfor i in range(28):\n    t = (t, t)\nx = hash(t)'],
])('%s is hashed once', (_name, program) => {
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('str.splitlines over a long text over and over ends at the operation limit', () => {
  const program = `s = 'x' * 1000000\nfor i in range(70):\n    s.splitlines()`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each([
  ['reversing a long list in place', 'a.reverse()'],
  ['deleting an extended slice of a long list', 'del a[::100000]\n    a.append(i)'],
])('%s over and over ends at the operation limit', (_name, body) => {
  const program = `a = list(range(100000))\nfor i in range(700):\n    ${body}`;
  expect(executeOnStillClock(program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
});

test.each([
  ['the length', "'a' * 500000", 'len(s)'],
  ['an item', "'a' * 500000", 's[0]'],
  ['the length of a text outside the BMP', "'😀' * 500000", 'len(s)'],
  ['an item of a text outside the BMP', "'😀' * 500000", 's[-1]'],
  ['the hash', "'a' * 500000", 'hash(s)'],
  ['a dict entry', "'a' * 500000", '{s: 1}.get(s)'],
])('%s of a long unchanged text read over and over is found without scanning it each time', (_name, text, read) => {
  // Scanning the text each time would take far longer than the time limit; reading it takes milliseconds.
  const program = `s = ${text}\nfor i in range(10000):\n    n = ${read}`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['dicts', 'a = dict.fromkeys(range(100000), 0)\nb = dict.fromkeys(range(100000), 1)', 'a == b'],
  ['sets', 'a = set(range(100000))\nb = set(range(1, 100001))', 'a <= b'],
])('a comparison of long %s decided by the first item does not copy them', (_name, setup, comparison) => {
  // Copying the entries for each comparison would take longer than the time limit; the comparisons take milliseconds.
  const program = `${setup}\nfor i in range(5000):\n    x = ${comparison}`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a backward search for a long needle that matches at the end does not copy the text', () => {
  // Copying the text for each search would take far longer than the time limit; the search takes milliseconds.
  const program = `s = 'a' * 500000\nfor i in range(500):\n    v = s.rfind('aaaaaaaaa')`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  'del a[:0]',
  'del a[5:2]',
  'del a[0:0:2]',
  'a[3:3] = []',
  'a[3:5] = [0, 0]',
  'a[len(a):] = [1, 2]\n    del a[-2:]',
  'a[-2:] = []\n    a.extend([1, 2])',
])('a change of a long list that moves little of it, %s, over and over costs no scan of it', (statement) => {
  // Work that copies the list would take far longer than the time limit; the change itself takes milliseconds.
  const program = `a = [0] * 100000\nfor i in range(10000):\n    ${statement}`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

/**
 * Runs a program with the clock standing still, so that only the operations it is charged, not the load of the host,
 * decide whether it stays within the limits.
 */
function executeOnStillClock(program: string): ReturnType<typeof executeProgram> {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  try {
    return executeProgram('python', program);
  } finally {
    clock.mockRestore();
  }
}
