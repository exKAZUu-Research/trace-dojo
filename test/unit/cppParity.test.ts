import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'cppParity');

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

test('allows const map keys and pointers to const set elements', () => {
  const program = `#include <iostream>
#include <map>
#include <set>
int main() {
  const int n = 2;
  std::map<const int, int> counts;
  std::set<const int*> addresses;
  counts[1] = 3;
  addresses.insert(&n);
  std::cout << counts[1] << ' ' << **addresses.begin();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '3 2',
    uncaughtException: undefined,
  });
});

test.each([
  ['two increments', 'int i = 0;', 'i++ + i++'],
  ['a reference alias', 'int i = 1; int& r = i;', 'i++ + r'],
  ['an array element alias', 'int a[] = {1, 2}; int* p = a;', 'a[0]++ + *p'],
  ['a field alias', 'Item item{1}; int* p = &item.value;', 'item.value + (*p = 2)'],
  ['a pointer variable', 'int a[] = {1, 2}; int* p = a;', 'p++ == p'],
  ['a nested comma operator', 'int i = 0;', '(i++, 0) + i'],
  ['a fused product and addend', 'float f = 1;', '2 * f + f++'],
  ['string concatenation', "char c = 'a';", 'c++ + std::string(1, c)'],
])('rejects conflicting unsequenced C++ accesses through %s', (_name, declarations, expression) => {
  const program = `#include <iostream>
#include <string>
struct Item { int value; };
int main() {
  ${declarations}
  std::cout << (${expression});
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining('実行順序が決まっていない式'),
  });
});

test('preserves sequencing in shift, assignment, comma, short-circuit, and C++ function calls', () => {
  const program = `#include <iostream>
int touch(int& i) { return i++; }
int sum(int a, int b) { return a + b; }
int main() {
  int i = 0;
  std::cout << (i++, i++) << ' ' << (i++ << i) << ' ';
  i = i++ + 1;
  std::cout << (i++ && i++) << ' ' << (touch(i) + i++) << ' ' << sum(i++, i++);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '1 16 1 13 17',
    uncaughtException: undefined,
  });
});

// Each `.out` file holds what a program built with Apple clang++ 21 (`-std=c++20`, libc++) printed, followed by the
// line libc++abi wrote when an uncaught exception ended it, if one did.
test.each(fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.cpp')))(
  '%s prints what clang++ prints',
  (name) => {
    const program = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURE_DIR, name.replace(/\.cpp$/, '.out')), 'utf8');
    const execution = executeProgram('cpp', program);
    if (execution.kind !== 'executed') throw new Error(`${name} did not run: ${JSON.stringify(execution)}`);
    const uncaught = execution.uncaughtException ? `[uncaught] ${execution.uncaughtException}\n` : '';
    expect(execution.stdout + uncaught).toBe(expected);
  }
);
