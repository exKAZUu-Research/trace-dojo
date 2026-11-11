import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

/** Runs a program that raises when a value it computes differs from what CPython 3.14.10 computes for it. */
function expectSameAsCPython(program: string): void {
  expect(executeProgram('python', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
}

/** `count` nested for loops around `inner`. */
function nested(count: number, inner = 'pass'): string {
  const loops = Array.from({ length: count }, (_, i) => `${' '.repeat(i)}for x${i} in y:`).join('\n');
  return `${loops}\n${' '.repeat(count)}${inner}\n`;
}

function compileErrorRow(program: string): number | undefined {
  const result = executeProgram('python', program);
  return result.kind === 'compileError' ? result.diagnostics[0]?.row : undefined;
}

test('a thread waiting in a function a builtin calls back lets the other threads run', () => {
  expectSameAsCPython(`import threading, queue
q = queue.Queue()
log = []
def key(x):
    v = q.get()
    log.append(('key', x, v))
    return v
def consumer():
    log.append(('sorted', sorted([1, 2, 3], key=key)))
    log.append(('sum', sum(q.get() for _ in range(2))))
    log.append(('map', list(map(lambda x: x + q.get(), [100, 200]))))
    log.append(('comp', [q.get() * 2 for _ in range(2)]))
def producer():
    for v in [30, 10, 20, 5, 6, 1, 2, 7, 8]:
        log.append(('put', v))
        q.put(v)
threads = [threading.Thread(target=consumer), threading.Thread(target=producer)]
for t in threads: t.start()
for t in threads: t.join()
expected = [('put', 30), ('put', 10), ('put', 20), ('put', 5), ('put', 6), ('put', 1), ('put', 2), ('put', 7),
            ('put', 8), ('key', 1, 30), ('key', 2, 10), ('key', 3, 20), ('sorted', [2, 3, 1]), ('sum', 11),
            ('map', [101, 202]), ('comp', [14, 16])]
if log != expected: raise AssertionError(log)
`);
});

test('the compiler refuses statically nested blocks past 21, counted per code object', () => {
  expect(compileErrorRow(`print(1)\n${nested(21)}`)).toBeUndefined();
  expect(compileErrorRow(`print(1)\n${nested(22)}`)).toBe(22);
  expect(compileErrorRow(`print(1)\n${nested(21, '[a for a in b]')}`)).toBe(22);
  expect(compileErrorRow(`x = ${'('.repeat(201)}1${')'.repeat(201)}\n`)).toBe(0);
});

test('builtin iterators pickle and copy at their position', () => {
  expectSameAsCPython(`import pickle, copy
it = iter([1, 2, 3])
next(it)
if it.__reduce__() != (iter, ([1, 2, 3],), 1): raise AssertionError(it.__reduce__())
if list(pickle.loads(pickle.dumps(it))) != [2, 3]: raise AssertionError
c = copy.copy(it)
if (list(c), list(it)) != ([2, 3], [2, 3]): raise AssertionError
r = iter(range(0, 10, 3)); next(r)
if r.__reduce__() != (iter, (range(3, 12, 3),), None): raise AssertionError(r.__reduce__())
m = map(abs, [-1, -2])
if list(pickle.loads(pickle.dumps(m))) != [1, 2]: raise AssertionError
`);
});
