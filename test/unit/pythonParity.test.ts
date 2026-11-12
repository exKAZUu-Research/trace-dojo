import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'pythonParity');

// Each fixture checks its own results and raises on a difference; CPython 3.14.10 runs all of them without raising.
test.each(fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.py')))('%s runs as in CPython', (name) => {
  const program = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['a set updated from an endless iterator', 'import itertools\nset().update(itertools.repeat(0))'],
  ['a set difference with an endless iterator', 'import itertools\nset().difference_update(itertools.repeat(0))'],
  ['a rejection loop that never accepts', 'import random\nrandom.gammavariate(float("nan"), 1)'],
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
  ['a suffix test of many long candidates', "s = 'x' * 500000\np = ('y' + 'x' * 499999,) * 5000\ns.endswith(p)"],
  ['a binomial coefficient of a huge size', 'import math\nmath.comb(10**6, 5 * 10**5)'],
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
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each([
  ['a huge random.choices result', 'import random\nx = random.choices([1], k=1000001)'],
  ['a huge random integer', 'import random\nx = random.getrandbits(9000000)'],
  ['a huge format width', 'format(1, "01000000000000,")'],
  ['ranges kept beside a list beyond the slot limit', 'a = list(map(range, range(200000)))\nb = [0] * 700000'],
  ['slices kept beside a list beyond the slot limit', 'a = [slice(i) for i in range(200000)]\nb = [0] * 700000'],
  [
    'complex numbers kept beside a list beyond the slot limit',
    'a = [complex(i, 1) for i in range(200000)]\nb = [0] * 700000',
  ],
  [
    'a dict comprehension and a list beyond the slot limit together',
    'd = {i: i for i in range(300000)}\na = [0] * 800000',
  ],
  [
    'a dict filled by assignment and a list beyond the slot limit together',
    'd = {}\nfor i in range(200000):\n    d[i] = i\na = [0] * 900000',
  ],
  ['a copy of a list beyond the slot limit together', 'a = [0] * 800000\nb = a.copy()'],
  ['a copy.copy of a list beyond the slot limit together', 'import copy\na = [0] * 800000\nb = copy.copy(a)'],
  ['a deep copy of a list beyond the slot limit together', 'import copy\na = [0] * 800000\nb = copy.deepcopy(a)'],
  ['a slice of a list beyond the slot limit together', 'a = [0] * 800000\nb = a[:]'],
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
  [
    'a reverse iterator over a dict and a list beyond the slot limit together',
    'd = dict.fromkeys(range(300000))\nr = reversed(d)\na = [0] * 500000',
  ],
])('%s raises MemoryError', (_name, program) => {
  expect(executeProgram('python', program)).toMatchObject({ uncaughtException: 'MemoryError' });
});

test('a long text built from many pieces is charged for its length, not for each piece', () => {
  const program = `lengths = [
    len(str(list(range(100000)))),
    len(str({i: i for i in range(20000)})),
    len(("x" * 400000).replace("x", "yy")),
    len(("x\\t" * 100000).expandtabs(4)),
    len(("x" * 400000).translate({120: "yy"})),
]
if lengths != [688890, 257780, 800000, 400000, 800000]:
    raise AssertionError(str(lengths))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('containers built in different ways are each charged once', () => {
  // Ten containers of 99,000 items fit in the slot limit only when none of them is charged twice.
  const program = `import copy
from collections import deque
a = [0] * 99000
containers = [a.copy(), copy.copy(a), copy.deepcopy(a), a[:], list(a), tuple(a), sorted(a), a + [], deque(a)]
if [len(container) for container in containers] != [99000] * 9:
    raise AssertionError("wrong length")`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test('a bounded deque repeated a billion times keeps its last items without running the rounds', () => {
  const program = `from collections import deque
d = deque([1, 2], maxlen=3)
d *= 1000000000
if list(d) != [2, 1, 2] or list(deque([1, 2, 3], maxlen=2) * 1000000001) != [2, 3]:
    raise AssertionError(str(d))`;
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
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
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
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
    steps: ['0:', '2:5', '3:5', '2:5', '3:5', '2:5', '3:5', '5:'],
  },
])('steps of $name are called from the line of the call that runs them', ({ program, steps }) => {
  const trace = traceProgram('python', program, program);
  expect(trace.traceItems.map(({ line, callLines }) => `${line}:${callLines.join(',')}`)).toEqual(steps);
});
