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

test.each(['destinations[index()]', 'location()'])(
  'tracing keeps an assignment value alive while its destination runs: %s',
  (destination) => {
    const program = `Turtle* destinations[1];
int index() { int zero = 0; return zero; }
Turtle*& location() { int zero = 0; return destinations[zero]; }
int main() { ${destination} = new Turtle(1, 1); }`;
    const trace = traceProgram('cpp', program, program);
    expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([[1, 1]]);
  }
);

test.each(['v.assign({new Turtle(0, 0), second()});', 'v.insert(v.begin(), {new Turtle(0, 0), second()});'])(
  'sequence edits keep pointer elements alive while evaluating the remaining elements: %s',
  (edit) => {
    const program = `#include <vector>
Turtle* second() { Turtle* result = new Turtle(1, 1); return result; }
int main() { std::vector<Turtle*> v; ${edit} }`;
    const trace = traceProgram('cpp', program, program);
    expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  }
);

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

test.each([
  ['a member buffer', 'struct Row { std::vector<Turtle*> items; Token token; };', 'items'],
  ['a base buffer', 'struct Row : Storage { Token token; };', 'items'],
  ['a built-in array', 'struct Row { Entry cells[2]; };', 'cells[0].items'],
  ['a library array', 'struct Row { std::array<Entry, 2> cells; };', 'cells[0].items'],
])('keeps turtles reachable through %s during relocation', (_, definition, member) => {
  const program = `#include <array>
#include <vector>
int defaultValue() { int value = 1; return value; }
struct Token {
  Token() {}
  Token(const Token&, int = defaultValue()) noexcept {}
  ~Token() { int destroying = 1; }
};
struct Storage { std::vector<Turtle*> items; };
struct Entry : Storage { Token token; };
${definition}
int main() {
  std::vector<Row> rows(1);
  rows[0].${member}.push_back(new Turtle);
  rows.reserve(8);
  rows[0].${member}[0]->forward();
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([[0, 1]]);
});

test.each([
  [
    'vector clear',
    'std::vector<Item> items; items.reserve(2); items.emplace_back(1); items.emplace_back(2); items.clear();',
  ],
  [
    'vector resize',
    'std::vector<Item> items; items.reserve(2); items.emplace_back(1); items.emplace_back(2); items.resize(0);',
  ],
  [
    'vector erase',
    'std::vector<Item> items; items.reserve(2); items.emplace_back(1); items.emplace_back(2); items.erase(items.begin(), items.end());',
  ],
  ['deque clear', 'std::deque<Item> items; items.emplace_back(2); items.emplace_back(1); items.clear();'],
  ['list clear', 'std::list<Item> items; items.emplace_back(2); items.emplace_back(1); items.clear();'],
  ['map clear', 'std::map<int, Item> items; items.try_emplace(1, 2); items.try_emplace(2, 1); items.clear();'],
  [
    'unordered map clear',
    'std::unordered_map<int, Item> items; items.try_emplace(1, 1); items.try_emplace(2, 2); items.clear();',
  ],
])('keeps removed elements reachable through %s', (_, edit) => {
  const program = `#include <deque>
#include <iostream>
#include <list>
#include <map>
#include <unordered_map>
#include <vector>
Turtle observer(0, 0);
struct Item {
  Turtle* turtle;
  Item(int y = 1) : turtle(new Turtle(0, y)) {}
  ~Item() { std::cout << observer.canMoveForward(); delete turtle; }
};
int main() { ${edit} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '00',
    uncaughtException: undefined,
  });
  expect(traceProgram('cpp', program, program)).toMatchObject({ stdout: '00', uncaughtException: undefined });
});

test('an uncaught exception preserves the turtles reached from main before unwinding', () => {
  const program = `int main() {
  Turtle t(3, 5);
  throw 1;
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([[3, 5]]);
});

test('keeps a thrown turtle reachable until an outer handler catches it', () => {
  const program = `struct Guard { ~Guard() { int cleanup = 1; } };
void fail() {
  Guard guard;
  throw new Turtle;
}
int main() {
  Turtle* kept = nullptr;
  try {
    try { fail(); }
    catch (Turtle* turtle) {
      Guard guard;
      throw;
    }
  } catch (Turtle* turtle) {
    kept = turtle;
  }
  kept->forward();
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([[0, 1]]);
});

test.each([
  ['directly', 'Turtle*', 'new Turtle', 'result'],
  ['in a vector', 'std::vector<Turtle*>', 'std::vector<Turtle*>{new Turtle}', 'result[0]'],
])('keeps a turtle returned %s during temporary destruction', (_, type, value, pointer) => {
  const program = `#include <vector>
struct Guard { ~Guard() { int value = 1; } };
${type} make() { return (Guard{}, ${value}); }
int main() {
  auto result = make();
  ${pointer}->forward();
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x, y }) => [x, y])).toEqual([[0, 1]]);
});

test.each([
  ['a struct', 'Group{Item(1), Item(2)}'],
  ['an array', 'std::array<Item, 2>{Item(1), Item(2)}'],
])('keeps the full temporary owner alive while destroying %s', (_, expression) => {
  const program = `#include <array>
#include <iostream>
Turtle observer(0, 0);
struct Item {
  Turtle turtle;
  Item(int y) : turtle(0, y) {}
  ~Item() { std::cout << observer.canMoveForward(); }
};
struct Group { Item first; Item second; };
int main() { static_cast<void>(${expression}); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '00',
    uncaughtException: undefined,
  });
  expect(traceProgram('cpp', program, program)).toMatchObject({ stdout: '00', uncaughtException: undefined });
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

test.each([
  ['find_if', 'bool'],
  ['for_each', 'void'],
])('%s destroys callback parameters only when execution returns or unwinds', (algorithm, returnType) => {
  const declarations = `#include <algorithm>
#include <iostream>
struct Value { ~Value() { std::cout << 'D' << std::flush; } };
${returnType} fail(Value parameter) { throw 1; }`;
  const call = `std::${algorithm}(values, values + 1, fail);`;
  const base = `${declarations}
int main() { Value values[1];`;
  expect(executeProgram('cpp', `${base} ${call} }`)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: 'libc++abi: terminating due to uncaught exception of type int',
  });
  expect(executeProgram('cpp', `${base} try { ${call} } catch (int) { std::cout << 'X'; } }`)).toMatchObject({
    kind: 'executed',
    stdout: 'DXD',
    uncaughtException: undefined,
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

test('records each visit to an initialized static local without rerunning its initializer', () => {
  const program = `int calls = 0;
int initialValue() { ++calls; return 7; }
int next() {
  static int count = initialValue();
  ++count;
  return count;
}
int main() {
  static int untouched;
  static bool flag = true;
  int first = next();
  int second = next();
  flag = false;
}`;
  const { traceItems } = traceProgram('cpp', program, program);
  expect(traceItems.filter(({ line }) => line === 4).map(({ vars }) => vars.count)).toEqual([7, 8]);
  expect(traceItems.some(({ line }) => line === 9)).toBe(false);
  expect(traceItems.find(({ line }) => line === 10)?.vars.flag).toBe(true);
  expect(traceItems.at(-1)?.vars).toMatchObject({ calls: 1, first: 8, second: 9, flag: false });
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

test('a character pointer can refer to one character without representing a C string', () => {
  const program = `int main() {
  char c = 'A';
  char* p = &c;
  char* empty = nullptr;
  int next = 1;
}`;
  const { traceItems } = traceProgram('cpp', program, program);
  expect(traceItems).toContainEqual(
    expect.objectContaining({
      referenceVars: expect.objectContaining({
        p: { kind: 'value', value: 'A' },
        // oxlint-disable-next-line unicorn/no-null -- The trace protocol represents nullptr as null.
        empty: { kind: 'value', value: null },
      }),
    })
  );
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

test.each(['std::isalpha(-2)', 'std::toupper(256)'])('C character functions check the input domain: %s', (call) => {
  expect(executeProgram('cpp', `#include <cctype>\nint main() { return ${call}; }`)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('unsigned char'),
  });
});

test('a downcast checks the runtime class of the pointed-to object', () => {
  const program = `struct Base { int x = 1; };
struct Derived : Base { int y = 2; };
int main() { Base value; Derived* p = static_cast<Derived*>(&value); return p->y; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('Derived'),
  });
});

test('clamp rejects bounds reversed under its comparator', () => {
  const program = '#include <algorithm>\nint main() { return std::clamp(3, 5, 1); }';
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('範囲'),
  });
});

test('void pointer recovery checks the original type when reading a value', () => {
  const program = `int main() {
  double value = 2.5;
  void* location = &value;
  int* converted = static_cast<int*>(location);
  if (static_cast<void*>(converted) != location) return 1;
  return *converted;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('ポインタで扱えません'),
  });
});

test('delete checks the original allocation type after void pointer recovery', () => {
  const program = `int main() {
  void* allocation = new double(2.5);
  delete static_cast<int*>(allocation);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('ポインタで扱えません'),
  });
});

test('a base-class member traces its own field when a derived field hides it', () => {
  const program = `struct Base {
  int value = 1;
  void set() { value = 3; }
};
struct Derived : Base { int value = 2; };
int main() { Derived object; object.set(); }`;
  const { traceItems } = traceProgram('cpp', program, program);
  expect(traceItems).toContainEqual(
    expect.objectContaining({
      vars: expect.objectContaining({ 'this->value': 3 }),
      referenceVars: expect.objectContaining({
        this: { kind: 'object', entries: { value: { kind: 'value', value: 3 } } },
      }),
    })
  );
});

test('a reference member shows the referenced value while tracing a setter', () => {
  const program = `struct Ref {
  int& value;
  void set() { value = 7; }
};
int main() { int n = 1; Ref holder{n}; holder.set(); int done = 0; }`;
  const { traceItems } = traceProgram('cpp', program, program);
  expect(traceItems).toContainEqual(
    expect.objectContaining({
      vars: expect.objectContaining({ 'this->value': 7 }),
      referenceVars: expect.objectContaining({
        this: { kind: 'object', entries: { value: { kind: 'value', value: 7 } } },
      }),
    })
  );
});

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
