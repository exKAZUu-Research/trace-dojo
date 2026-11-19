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

test.each([
  'struct Result : Pair { Result() : Pair(new Turtle(0, 0), second()) {} };',
  'struct Result : Pair { Result() : Result(new Turtle(0, 0), second()) {} Result(Turtle* a, Turtle* b) : Pair(a, b) {} };',
])('constructor initializers keep earlier arguments alive during later steps', (declaration) => {
  const program = `struct Pair {
  Turtle* first;
  Turtle* last;
  Pair(Turtle* a, Turtle* b) : first(a), last(b) {}
};
Turtle* second() { Turtle* result = new Turtle(1, 1); return result; }
${declaration}
int main() { Result result; }`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([
    [0, 0],
    [1, 1],
  ]);
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

test.each([
  ['a direct pointer', 'const int* past = &value.first + 1; return *past;'],
  ['a subscript', 'const int* start = &value.first; return start[1];'],
  ['a returned end iterator', 'auto past = std::find(&value.first, &value.first + 1, 9); return *past;'],
])('rejects dereferencing one past a member through %s', (_, body) => {
  const program = `#include <algorithm>
struct Value { int first; int second; };
int main() { Value value{1, 2}; ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('範囲'),
  });
});

test.each([
  ['insertion', 'auto added = values.insert(values.begin() + 1, 4); std::cout << *added;'],
  ['erasure', 'auto next = values.erase(values.begin() + 1); std::cout << *next;'],
])('vector %s retains positions before the edit and invalidates its suffix', (_, edit) => {
  const program = `#include <iostream>
#include <vector>
int main() {
  std::vector<int> values{4, 5, 4};
  values.reserve(12);
  auto first = values.begin();
  auto stale = first + 1;
  ${edit}
  std::cout << *first << *stale;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '44',
    uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
  });
});

test('tracing continues when a vector invalidates an unused character pointer', () => {
  const program = `#include <iostream>
#include <vector>
int main() {
  std::vector<char> chars{'a',0};
  char* old = chars.data();
  chars.reserve(20);
  std::cout << "ok";
}`;
  expect(traceProgram('cpp', program, program)).toMatchObject({ stdout: 'ok' });
});

test.each(['std::cout.width(100001)', 'std::cout << std::fixed << std::setprecision(100001)'])(
  'oversized formatted output is charged before padding: %s',
  (setup) => {
    const program = `#include <iostream>
#include <iomanip>
int main() { ${setup}; std::cout << 1.0; }`;
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'output' });
  }
);

test('general float formatting uses the actual stream buffer space', () => {
  const program = `#include <iostream>
#include <sstream>
#include <string>
int main() {
  std::ostringstream stream;
  stream << std::string(999999, 'x') << 1.0;
  std::cout << stream.str().size();
}`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', stdout: '1000000' });
});

test.each(['std::printf("%s", values)', 'std::snprintf(buffer, 8, "%.*s", 0, values)'])(
  'printf string conversions require character pointers: %s',
  (call) => {
    const program = `#include <cstdio>
int main() { int values[2] = {65, 0}; char buffer[8]; ${call}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('引数の型が合いません'),
    });
  }
);

test.each([
  ['std::set<int> a{1, 2}, b{3, 4}; a.erase(a.begin(), b.end());', 'イテレータ'],
  ['std::map<int, int> a{{1, 2}}, b{{3, 4}}; a.erase(b.begin(), b.end());', 'イテレータ'],
  ['std::set<int> a{1, 2}; auto it = a.begin(); a.erase(it); a.erase(it, a.end());', 'イテレータ'],
  ['std::set<int> a{1, 2}; a.erase(a.end(), a.begin());', '範囲'],
  ['std::set<int> a{1, 2}, b{3, 4}; a.insert(b.begin(), 5);', 'イテレータ'],
])('ordered container edits require a valid iterator range: %s', (body, diagnostic) => {
  const program = `#include <map>
#include <set>
int main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining(diagnostic),
  });
});

test('an exception message cannot hide an output limit', () => {
  const program = `#include <iostream>
#include <stdexcept>
#include <string>
struct Error : std::exception {
  const char* what() const noexcept override {
    std::cout << std::string(110000, 'a');
    return "message";
  }
};
int main() { throw Error{}; }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'output' });
});

test.each([
  ['std::abs(INT_MIN)', 'オーバーフロー'],
  ['std::labs(LONG_MIN)', 'オーバーフロー'],
  ['std::printf("%s", text)', 'nullptr'],
  ['std::printf("%.*s", 0, text)', 'nullptr'],
])('reports undefined library behavior for %s', (call, diagnostic) => {
  const program = `#include <climits>
#include <cstdio>
#include <cstdlib>
int main() { const char* text = nullptr; ${call}; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining(diagnostic),
  });
});

test('an exception message ends its lifetime with the exception object', () => {
  const program = `#include <stdexcept>
int main() {
  const char* text;
  { std::runtime_error error("message"); text = error.what(); }
  return *text;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('有効期間が終わった'),
  });
});

test('a scalar character member needs its own string terminator', () => {
  const program = `#include <iostream>
struct Text { char marker; char padding; };
int main() { Text text{'A', '\\0'}; std::cout << &text.marker; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('文字列の終わり'),
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

test('an exception escaping a noexcept function terminates before outer handlers', () => {
  const program = `#include <iostream>
void stop() noexcept { throw 1; }
int main() { try { stop(); } catch (int) { std::cout << 'X'; } }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
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
