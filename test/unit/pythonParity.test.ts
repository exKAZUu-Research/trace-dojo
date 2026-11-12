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
])('%s ends at the execution limit', (_name, program) => {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'limitExceeded' });
});

test.each([
  ['a huge random.choices result', 'import random\nx = random.choices([1], k=1000001)'],
  ['a huge random integer', 'import random\nx = random.getrandbits(9000000)'],
  ['a huge format width', 'format(1, "01000000000000,")'],
])('%s raises MemoryError', (_name, program) => {
  expect(executeProgram('python', program)).toMatchObject({ uncaughtException: 'MemoryError' });
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
