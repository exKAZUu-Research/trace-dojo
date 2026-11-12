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
])('%s ends at the execution limit', (_name, program) => {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'limitExceeded' });
});

test.each([
  ['a huge random.choices result', 'import random\nx = random.choices([1], k=1000001)'],
  ['a huge random integer', 'import random\nx = random.getrandbits(9000000)'],
  ['a huge format width', 'format(1, "01000000000000,")'],
  [
    'a dict comprehension and a list beyond the slot limit together',
    'd = {i: i for i in range(300000)}\na = [0] * 800000',
  ],
  [
    'a dict filled by assignment and a list beyond the slot limit together',
    'd = {}\nfor i in range(200000):\n    d[i] = i\na = [0] * 900000',
  ],
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
])('%s raises MemoryError', (_name, program) => {
  expect(executeProgram('python', program)).toMatchObject({ uncaughtException: 'MemoryError' });
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
