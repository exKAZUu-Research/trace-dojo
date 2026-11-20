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

test.each([
  ['iostream', 'int a[] = {1, 2}, b[2]; std::partial_sum(a, a + 2, b); std::cout << b[1];', '3'],
  ['iterator', 'int a[] = {3, 7, 9}; std::printf("%d", *std::find(a, a + 3, 7));', '7'],
  ['cstdio', 'std::FILE* stream = stdout; std::fputs("ready", stream);', 'ready'],
])('uses declarations exposed by the Apple SDK through <%s>', (header, body, stdout) => {
  const program = `#include <${header}>
int main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', stdout, uncaughtException: undefined });
});

test('selects the algorithm remove overload when its declaration is visible', () => {
  const program = `#include <algorithm>
#include <cstdio>
using namespace std;
int main() {
  int a[] = {1, 2, 1};
  std::printf("%ld", remove(a, a + 3, 1) - a);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', stdout: '1', uncaughtException: undefined });
});

test('binds every member in mixed C++ class declarations', () => {
  const program = `#include <iostream>
struct Record {
  int first(), second(int x = 2);
  int left = 4, third();
  int fourth(), right{5};
  static int high(), value;
};
int Record::first() { return 1; }
int Record::second(int x) { return x; }
int Record::third() { return left; }
int Record::fourth() { return right; }
int Record::value = 6;
int Record::high() { return value; }
int main() {
  Record record;
  std::cout << record.first() << record.second() << record.third() << record.fourth() << Record::high();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '12456',
    uncaughtException: undefined,
  });
});

test('binds every function in mixed C++ file-scope declarations', () => {
  const program = `#include <iostream>
int first(int n = 1), second(int n = 2);
int left = 3, third();
int fourth(), right = 4;
int* pointer(), value = 5;
int main() {
  std::cout << first() << second() << third() << fourth() << *pointer();
}
int first(int n) { return n; }
int second(int n) { return n; }
int third() { return left; }
int fourth() { return right; }
int* pointer() { return &value; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '12345',
    uncaughtException: undefined,
  });
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

test('allows forward-declared set elements until an object needs them', () => {
  const program = `#include <iostream>
#include <set>
struct Pending;
std::set<Pending>* pending = nullptr;
struct Item;
std::set<Item>* forward = nullptr;
struct Item { int value; };
int main() {
  std::set<Item> items{};
  std::cout << (pending == nullptr) << (forward == nullptr) << items.size();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '110',
    uncaughtException: undefined,
  });
});

test.each(['set', 'multiset'])('defers owned std::%s element completeness until construction', (container) => {
  const program = `#include <iostream>
#include <set>
struct Pending;
struct Unused { std::${container}<Pending> items; };
Unused* unused = nullptr;
struct Item;
struct Owner { std::${container}<Item> items; };
struct Outer { Owner owner; };
struct Item { int value; };
int main() {
  Outer outer;
  std::cout << (unused == nullptr) << outer.owner.items.empty();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11',
    uncaughtException: undefined,
  });
});

test.each(['set', 'multiset'])('accepts a later definition of an owned std::%s element', (container) => {
  const program = `#include <iostream>
#include <set>
struct Item;
struct Owner { std::${container}<Item> items; };
Owner global;
int main() {
  Owner local;
  std::cout << global.items.empty() << local.items.empty();
}
struct Item { int value; };`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11',
    uncaughtException: undefined,
  });
});

test('allows abstract types as pointer elements and in empty vector and deque storage', () => {
  const program = `#include <deque>
#include <iostream>
#include <set>
#include <vector>
struct Item;
struct Unused { std::set<Item> items; };
Unused* unused = nullptr;
struct Item { virtual void f() = 0; };
struct AlsoUnused { std::set<Item> items; };
AlsoUnused* alsoUnused = nullptr;
struct Concrete : Item { void f() override {} };
int main() {
  std::set<Item*> pointers;
  std::set<Concrete> concrete;
  std::vector<Item> vector;
  std::deque<Item> deque;
  std::cout << (unused == nullptr && alsoUnused == nullptr)
            << pointers.empty() << concrete.empty() << vector.empty() << deque.empty();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '11111',
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

test.each([
  ['x++ + bytes[1]', 'int x = 0;', '&x'],
  ['x + (bytes[2] = 1)', 'int x = 0;', '&x'],
  ['bytes[1] + a[0]++', 'int a[] = {0, 9};', 'a'],
  ['bytes[1]++ + a[0]++', 'int a[] = {0, 9};', 'a'],
])('rejects overlapping unsequenced scalar and byte accesses in %s', (expression, declaration, address) => {
  const program = `#include <iostream>
int main() {
  ${declaration}
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(${address}));
  std::cout << (${expression});
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: expect.stringContaining('実行順序が決まっていない式'),
  });
});

test('allows unsequenced accesses to separate elements through a C++ byte view', () => {
  const program = `#include <iostream>
int main() {
  int a[] = {1, 9};
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(a));
  std::cout << (a[0]++ + bytes[sizeof(int)]);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '10',
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
