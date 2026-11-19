import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { executeProgram, traceProgram } from '../../src/interpreter/program';

// The interpreter's clock stands still in these tests, so that the program, not the load of the host, decides each one.
beforeEach(() => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function steps(language: 'cpp' | 'java', program: string): { vars: Record<string, unknown>; board: string }[] {
  return traceProgram(language, program, program).traceItems.map(({ vars, board }) => ({
    vars: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name.replace('this->', 'this.'), value])),
    board,
  }));
}

test('a C++ program records the steps that the Java version of it records', () => {
  const cpp = `#include <string>
#include <vector>
class Walker {
 public:
  int speed = 1;
  Turtle t;
  void walk(int n) {
    for (int i = 0; i < n * speed; i++) {
      t.前に進む();
    }
  }
};
int twice(int a) {
  return a * 2;
}
int main() {
  Walker w;
  int n = twice(1);
  w.walk(n);
  std::vector<int> arr = {1, 2};
  for (int x : arr) {
    w.t.右を向く();
  }
  std::string s = "fr";
  char c = s[1];
}`;
  const java = `public class Main {
  public static void main(String[] args) {
    Walker w = new Walker();
    int n = twice(1);
    w.walk(n);
    int[] arr = { 1, 2 };
    for (int x : arr) {
      w.t.右を向く();
    }
    String s = "fr";
    char c = s.charAt(1);
  }
  static int twice(int a) {
    return a * 2;
  }
}
class Walker {
  int speed = 1;
  Turtle t = new Turtle();
  void walk(int n) {
    for (int i = 0; i < n * speed; i++) {
      t.前に進む();
    }
  }
}`;
  expect(steps('cpp', cpp)).toEqual(steps('java', java));
});

test('a turtle leaves the board when its object ends its lifetime or becomes unreachable', () => {
  const program = `int main() {
  {
    Turtle a(1, 1);
  }
  Turtle* p = new Turtle(2, 2);
  p = new Turtle(3, 3);
  Turtle* q = new Turtle(4, 4);
  delete q;
  Turtle last(5, 5);
}`;
  const trace = traceProgram('cpp', program, program);
  const turtlesAt = (line: number): string[] =>
    (trace.traceItems.findLast((item) => item.line === line)?.turtles ?? []).map(({ x, y }) => `${x},${y}`);
  expect(turtlesAt(3)).toEqual(['1,1']);
  expect(turtlesAt(5)).toEqual(['2,2']);
  expect(turtlesAt(6)).toEqual(['3,3']);
  expect(turtlesAt(8)).toEqual(['3,3']);
  // The final turtles are those main's variables reach when its body completes, before they end their lifetime.
  expect(trace.finalTurtles.map(({ x, y }) => `${x},${y}`)).toEqual(['3,3', '5,5']);
});

// The declaration of m records no step of its own: the member's construction recorded one, as in Java.
test('// atomic on a member function makes each call of it one step of the caller', () => {
  const program = `class Mover {
 public:
  Turtle t;
  void twoSteps() { // atomic
    t.前に進む();
    t.前に進む();
  }
};
int main() {
  Mover m;
  m.twoSteps();
}`;
  expect(traceProgram('cpp', program, program).traceItems.map(({ line }) => line)).toEqual([0, 3, 11]);
});

test('a heap object stays on the board while a later element of the same list is constructed', () => {
  const program = `#include <vector>
class Mark {
 public:
  Turtle t;
  Mark(int x) : t(x, 0) {}
};
int main() {
  std::vector<Mark*> marks = {new Mark(1), new Mark(2)};
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x }) => x)).toEqual([1, 2]);
});

test('a heap receiver stays on the board while its method arguments are evaluated', () => {
  const program = `#include <iostream>
Turtle observer(0, 0);
int probe() { return observer.canMoveForward(); }
struct Walker {
  Turtle t;
  Walker() : t(0, 1) {}
  void go(int clear) { std::cout << clear; }
};
int main() { (new Walker)->go(probe()); }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', stdout: '0' });
});

test('an uncaught exception preserves the turtles reached from main before unwinding', () => {
  const program = `int main() {
  Turtle t(3, 5);
  throw 1;
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([[3, 5]]);
});

test('an uncaught exception terminates before full-expression temporary destruction', () => {
  const program = `#include <iostream>
struct Print { ~Print() { std::cout << 'D' << std::flush; } };
void stop(const Print&) { throw 1; }
int main() { stop(Print{}); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'libc++abi: terminating due to uncaught exception of type int',
  });
});

test('lifetime extension by a static reference preserves indeterminate fields', () => {
  const program = `struct Value { int n; Value() {} };
int main() { static const Value& value = Value(); return value.n; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('値を入れていない'),
  });
});

test('a pointer one past a member cannot be dereferenced', () => {
  const program = `struct Value { int first; int second; };
int main() { Value value{1, 2}; const int* past = &value.first + 1; return *past; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('範囲'),
  });
});

test('an exception escaping a catch parameter copy terminates before outer handlers', () => {
  const program = `#include <iostream>
struct Print {
  Print() {}
  Print(const Print&) { std::cout << 'C' << std::flush; throw 2; }
};
int main() {
  try { try { throw Print(); } catch (Print value) {} }
  catch (int) { std::cout << 'X'; }
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: 'C',
    uncaughtException: 'libc++abi: terminating due to uncaught exception of type int',
  });
});

test.each([
  ['array', 'std::array<int, 2> a; return a[0];', '値を入れていない'],
  [
    'vector',
    'std::vector<int> v; v.reserve(1); v.push_back(1); int* p = v.data(); v.push_back(2); return *p;',
    'イテレータ',
  ],
  ['random', 'std::uniform_real_distribution<float> d(-3e38f, 3e38f);', '範囲が広すぎ'],
  ['unordered_set', 'std::unordered_set<int> s{3}; auto i = s.begin(); s.rehash(100); return *i;', 'イテレータ'],
])('reports an invalid operation from <%s>', (header, body, reason) => {
  const program = `#include <${header}>\nint main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining(reason),
  });
});

test('the interpreter rejects the syntax it leaves out with a message naming it', () => {
  const execution = executeProgram('cpp', 'int main() {\n  auto f = [](int x) { return x; };\n}');
  expect(execution).toEqual({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: 'ラムダ式は、この採点環境では使えません。' }],
  });
});

test.each([
  ['a block-local array', 'int* p; { int a[2] = {7, 8}; p = a; } return *p;', '有効期間'],
  ['a freed array member', 'auto object = new A; int* p = object->cells; delete object; return *p;', 'delete'],
  ['a temporary object', 'int* p = A{}.data(); return *p;', '有効期間'],
  ['a by-value parameter', 'save(A{}); return *saved;', '有効期間'],
  ['a string buffer', 'const char* p; { std::string s = "c"; p = s.c_str(); } return *p;', '有効期間'],
  [
    'a removed vector element',
    'std::vector<A> values(1); int* p = values[0].cells; values.pop_back(); return *p;',
    '有効期間',
  ],
])('rejects a pointer into %s after its lifetime ends', (_, body, message) => {
  const program = `#include <string>
#include <vector>
struct A {
  int cells[1] = {5};
  int* data() { return cells; }
};
int* saved;
void save(A a) { saved = a.cells; }
int main() { ${body} }`;
  const execution = executeProgram('cpp', program);
  expect(execution).toMatchObject({ kind: 'executed', uncaughtException: expect.stringContaining(message) });
});
