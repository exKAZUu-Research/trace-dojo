import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LIMITS } from '../../src/interpreter/limits';
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

test('shows runtime-initialized const arithmetic globals in the trace', () => {
  const program = `int read() { int seed = 7; return seed; }
const int folded = 3;
const int fixed = read();
const double fraction = read() / 2.0;
struct Settings { inline static const int value = read(); };
int main() { int sum = fixed + folded + Settings::value; }`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.traceItems.map(({ vars }) => vars.fixed)).toEqual(expect.arrayContaining([0, 7]));
  expect(trace.traceItems.at(-1)?.vars).toMatchObject({ fixed: 7, fraction: 3.5, 'Settings::value': 7, sum: 17 });
  expect(trace.traceItems.some(({ vars }) => Object.hasOwn(vars, 'folded'))).toBe(false);
});

test('charges heap buffers only when a string allocates new capacity', () => {
  const program = `#include <iostream>
#include <string>
int main() {
  std::string source(8000, 'a'), target;
  target.reserve(8000);
  for (int i = 0; i < 20; ++i) {
    source = source;
    target = source;
    target.assign(source);
  }
  std::cout << source.size() << ' ' << target.size();
}`;
  const previous = LIMITS.maxSlots;
  LIMITS.maxSlots = 2500;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      stdout: '8000 8000',
      uncaughtException: undefined,
    });
    const grows = program.replace('target.assign(source);', "target.resize(12000, 'b');");
    expect(executeProgram('cpp', grows)).toMatchObject({
      kind: 'executed',
      uncaughtException: 'メモリを確保しすぎました。',
    });
  } finally {
    LIMITS.maxSlots = previous;
  }
});

test.each([
  'std::ostringstream stream(source);',
  'std::istringstream stream(source);',
  'std::stringstream stream; stream.str(source);',
])('counts storage owned by a string stream in %s', (statement) => {
  const program = `#include <sstream>
#include <string>
int main() {
  std::string source(16000, 'x');
  ${statement}
}`;
  const previous = LIMITS.maxSlots;
  LIMITS.maxSlots = 3000;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: 'メモリを確保しすぎました。',
    });
  } finally {
    LIMITS.maxSlots = previous;
  }
});

test('meters ostream::write only when the stream accepts output', () => {
  const program = `#include <iostream>
#include <sstream>
#include <string>
int main() {
  std::string source(16384, 'x');
  std::ostringstream stream;
  FAIL
  for (int i = 0; i < 24; ++i) {
    stream.write(source.data(), source.size());
    stream.str("");
  }
  std::cout << stream.str().size();
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 2048;
  try {
    expect(executeProgram('cpp', program.replace('FAIL', ''))).toMatchObject({
      kind: 'limitExceeded',
      limit: 'operations',
    });
    expect(executeProgram('cpp', program.replace('FAIL', 'stream.setstate(std::ios::failbit);'))).toMatchObject({
      kind: 'executed',
      stdout: '0',
      uncaughtException: undefined,
    });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test.each([
  ['std::ostream', 'cout', 'put(120)'],
  ['std::ostream', 'cerr', 'flush()'],
  ['std::ios', 'cout', 'good()'],
])('rejects a member call through a one-past %s pointer originating at %s', (type, stream, member) => {
  const program = `#include <iostream>
int main() {
  ${type}* pointer = &std::${stream};
  ++pointer;
  pointer->${member};
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '',
    uncaughtException: '配列の範囲の外を読み書きしました。',
  });
});

test.each([
  ['char', ' '],
  ['std::string', ' '],
  ['int', '0'],
  ['double', '0'],
])('charges string-stream input scanning for %s', (type, fill) => {
  const program = `#include <sstream>
#include <string>
int main() {
  std::string source(8000, '${fill}');
  source[7999] = '1';
  std::istringstream input(source);
  for (int i = 0; i < 10; ++i) {
    input.str(source);
    input.clear();
    ${type} value;
    input >> value;
  }
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 2100;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test.each([
  'std::string copy(source.data(), source.size());',
  'std::string copy(source.c_str());',
  'std::string copy(source.begin(), source.end());',
  'std::string copy(source);',
])('charges the storage limit for string construction in %s', (statement) => {
  const program = `#include <string>
int main() {
  std::string source(16000, 'x');
  ${statement}
}`;
  const previous = LIMITS.maxSlots;
  LIMITS.maxSlots = 3000;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: 'メモリを確保しすぎました。',
    });
  } finally {
    LIMITS.maxSlots = previous;
  }
});

test('stops C-string scans as soon as the result is known', () => {
  const program = `#include <cstring>
#include <string>
#include <iostream>
int main() {
  std::string a(8000, 'x'), b(8000, 'x');
  b[0] = 'y';
  int matches = 0;
  for (int i = 0; i < 15; ++i) {
    matches += std::strcmp(a.c_str(), b.c_str()) < 0;
    matches += std::strncmp(a.c_str(), b.c_str(), 8000) < 0;
    matches += std::strchr(a.c_str(), 'x') == a.c_str();
    matches += std::strstr(a.c_str(), "xxx") == a.c_str();
  }
  std::cout << matches;
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 1800;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      stdout: '60',
      uncaughtException: undefined,
    });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test.each([
  ['std::istringstream stream;', 'std::istream', 'std::stringstream'],
  ['std::ostringstream stream;', 'std::ostream', 'std::stringstream'],
])('rejects a stream downcast from %s through %s to %s', (declaration, base, derived) => {
  const program = `#include <sstream>
int main() {
  ${declaration}
  ${base}* pointer = &stream;
  static_cast<${derived}*>(pointer);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: `${derived} 型ではないオブジェクトをキャストしました。`,
  });
});

test.each([
  ['const char* p = nullptr;', 'std::strstr(p, "")', 'nullptr（NULL）のポインタの指す先を読み書きしました。'],
  [
    'const char* p; { char a[] = "x"; p = a; }',
    'std::strstr(p, "")',
    '有効期間が終わった変数（またはオブジェクト）を読み書きしました。',
  ],
  ['const char* p = nullptr;', 'std::strncmp(p, "x", 0)', 'nullptr（NULL）のポインタの指す先を読み書きしました。'],
  ['char* p = nullptr;', 'std::strncpy(p, "x", 0)', 'nullptr（NULL）のポインタの指す先を読み書きしました。'],
])('rejects an invalid C string argument before a trivial result in %s %s', (setup, call, message) => {
  const program = `#include <cstring>
int main() {
  ${setup}
  ${call};
}`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', uncaughtException: message });
});

test('reads only the required prefix of a C substring search needle', () => {
  const program = `#include <cstring>
#include <string>
#include <iostream>
int main() {
  std::string needle(8000, 'y');
  int failures = 0;
  for (int i = 0; i < 35; ++i) {
    failures += std::strstr("x", needle.c_str()) == nullptr;
    failures += std::strstr("y", needle.c_str()) == nullptr;
  }
  const char* repeated = "aababababa";
  std::cout << failures << ' ' << (std::strstr(repeated, "abababa") - repeated);
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 1800;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      stdout: '70 1',
      uncaughtException: undefined,
    });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test.each(['std::iota(a, a + 512, 0)', 'std::fill(a, a + 512, 2)', 'std::reverse(a, a + 512)'])(
  'charges the operations limit during repeated %s',
  (operation) => {
    const program = `#include <algorithm>
#include <numeric>
int main() {
  static int a[512] = {};
  for (int i = 0; i < 8; ++i) { ${operation}; }
}`;
    const previous = LIMITS.maxOperations;
    LIMITS.maxOperations = 2048;
    try {
      expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
    } finally {
      LIMITS.maxOperations = previous;
    }
  }
);

test.each([
  'std::copy(v.begin(), v.end(), std::back_inserter(v));',
  'std::transform(v.begin(), v.end(), std::back_inserter(v), twice);',
])('diagnoses past-the-end iterator invalidation in %s', (statement) => {
  const program = `#include <algorithm>
#include <iterator>
#include <vector>
int twice(int value) { return value * 2; }
int main() {
  std::vector<int> v{1};
  v.reserve(10);
  ${statement}
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
  });
});

test.each([
  'std::accumulate(values.begin(), values.end(), 0, accumulate);',
  'std::inner_product(values.begin(), values.end(), factors, 0, accumulate, multiply);',
])('validates the end iterator after the final callback in %s', (statement) => {
  const program = `#include <numeric>
#include <vector>
std::vector<int> values;
int accumulate(int sum, int value) {
  values.push_back(9);
  return sum + value;
}
int multiply(int a, int b) { return a * b; }
int main() {
  values.reserve(5);
  values.push_back(1);
  int factors[]{7};
  ${statement}
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
  });
});

test.each([
  'std::vector<Element> result(values.begin(), values.end());',
  'std::deque<Element> result(values.begin(), values.end());',
  'std::vector<Element> result; result.reserve(2); result.insert(result.end(), values.begin(), values.end());',
])('checks saved end iterators after constructing sequence elements in %s', (statement) => {
  const program = `#include <deque>
#include <vector>
std::vector<int> values;
struct Element {
  int value;
  Element(int n) : value(n) { values.push_back(9); }
};
int main() {
  values.reserve(5);
  values.push_back(1);
  ${statement}
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
  });
});

test.each([
  ['std::array<int, 512> a{}, b{};', 'a.fill(1);'],
  ['std::array<int, 512> a{}, b{};', 'a = b;'],
  ['std::array<int, 512> a{}, b{};', 'a.swap(b);'],
  ['std::vector<int> a(512, 1), b(512, 1);', 'a == b;'],
  ['std::vector<int> a(512, 1), b(512, 1);', 'a <= b;'],
  ['std::pair<std::vector<int>, int> a, b; a.first.resize(512, 1); b.first.resize(512, 1);', 'a == b;'],
  ['std::pair<std::vector<int>, int> a, b; a.first.resize(512, 1); b.first.resize(512, 1);', 'a < b;'],
  ['std::list<int> a(512, 1);', 'a.reverse();'],
  ['std::list<int> a(512, 1);', 'a.sort();'],
  ['std::list<int> a(512, 1);', 'a.remove(2);'],
  ['std::list<int> a;', 'a.insert(a.end(), 512, 1); a.clear();'],
  ['std::list<int> a;', 'a.insert(a.end(), 512, 1); a.erase(a.begin(), a.end());'],
  ['std::deque<int> a;', 'a.insert(a.end(), 512, 1); a.clear();'],
  ['std::vector<int> a(512, 1); a.reserve(514);', 'a.insert(a.begin(), 2); a.erase(a.begin());'],
  ['std::vector<int> a(512, 1);', 'a.assign(512, 2);'],
])('meters sequence traversal in %s %s', (setup, statement) => {
  const program = `#include <array>
#include <deque>
#include <list>
#include <utility>
#include <vector>
int main() {
  ${setup}
  for (int i = 0; i < 8; ++i) { ${statement} }
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 3000;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test.each([
  ['std::set<std::vector<int>> s; std::vector<int> k(512, 1); s.insert(k);', 's.find(k);'],
  ['std::set<std::vector<int>> s; std::vector<int> k(512, 1); s.insert(k);', 's.contains(k);'],
  [
    'std::set<std::vector<int>, std::greater<std::vector<int>>> s; std::vector<int> k(512, 1); s.insert(k);',
    's.count(k);',
  ],
  ['std::map<std::vector<int>, int> s; std::vector<int> k(512, 1); s[k] = 1;', 's[k];'],
  ['std::unordered_map<int, std::vector<int>> a, b; a[1].resize(512, 1); b[1].resize(512, 1);', 'a == b;'],
  ['std::priority_queue<std::vector<int>> q; std::vector<int> k(512, 1); q.push(k);', 'q.push(k);'],
  ["std::unordered_set<std::string> a, b; std::string k(8000, 'x'); a.insert(k); b.insert(k);", 'a == b;'],
  ['std::unordered_set<std::string> a{"y"}; std::string k(24000, \'x\');', 'a.count(k);'],
])('meters key comparisons in %s %s', (setup, statement) => {
  const program = `#include <functional>
#include <map>
#include <queue>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
int main() {
  ${setup}
  for (int i = 0; i < 8; ++i) { ${statement} }
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 3000;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test.each([
  ['std::unordered_set<int> s; for (int i = 0; i < 512; ++i) s.insert(i);'],
  ['std::unordered_map<int, int> s; for (int i = 0; i < 512; ++i) s[i] = i;'],
])('meters each entry rehashed in %s', (setup) => {
  const program = `#include <unordered_map>
#include <unordered_set>
int main() {
  ${setup}
  for (int i = 0; i < 8; ++i) { s.rehash(2048); s.rehash(1031); }
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 6000;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test.each([
  ['list', '=='],
  ['vector', '!='],
])('rejects %s iterator comparison %s across different sequences', (container, operator) => {
  const program = `#include <${container}>
#include <iostream>
int main() {
  std::${container}<int> a{1}, b{2};
  std::${container}<int>::iterator first{}, second{};
  std::cout << (first == second) << (&a == &b);
  std::cout << (a.begin() ${operator} b.begin());
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    stdout: '10',
    uncaughtException: expect.stringContaining('使えなくなったイテレータ'),
  });
});

test.each([
  'std::string copy(source.data(), source.size());',
  'std::string copy(source.c_str());',
  'source.compare(source);',
  'source.starts_with(source);',
  'source.ends_with(source);',
  'source == source;',
  'source.find("y");',
  'source.rfind("y");',
  'std::strlen(source.c_str());',
  'std::strcmp(source.c_str(), source.c_str());',
  'std::snprintf(nullptr, 0, "%s", source.c_str());',
])('charges the operations limit during repeated string scans in %s', (statement) => {
  const program = `#include <string>
#include <cstring>
#include <cstdio>
int main() {
  std::string source(16384, 'x');
  for (int i = 0; i < 24; ++i) { ${statement} }
}`;
  const previous = LIMITS.maxOperations;
  LIMITS.maxOperations = 2048;
  try {
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'limitExceeded', limit: 'operations' });
  } finally {
    LIMITS.maxOperations = previous;
  }
});

test('hides a C++ scalar until every byte is initialized', () => {
  const program = `int main() {
  int values[1];
  unsigned char* bytes = static_cast<unsigned char*>(static_cast<void*>(values));
  bytes[0] = 7;
  for (unsigned i = 1; i < sizeof(int); ++i) bytes[i] = 0;
}`;
  const trace = traceProgram('cpp', program, program);
  // oxlint-disable-next-line unicorn/no-null -- The trace protocol represents indeterminate array elements as null.
  expect(trace.traceItems.find(({ line }) => line === 4)?.vars.values).toEqual([null]);
  expect(trace.finalVars.values).toEqual([7]);
});

test('counts nested pair fields toward the C++ storage limit', () => {
  const program = `#include <iostream>
#include <utility>
#include <vector>
int main() {
  std::vector<std::pair<int, std::pair<int, int>>> entries(COUNT);
  std::cout << entries.size();
}`;
  const previousLimit = LIMITS.maxSlots;
  LIMITS.maxSlots = 5;
  try {
    expect(executeProgram('cpp', program.replace('COUNT', '1'))).toMatchObject({ kind: 'executed', stdout: '1' });
    expect(executeProgram('cpp', program.replace('COUNT', '2'))).toMatchObject({
      kind: 'executed',
      uncaughtException: 'メモリを確保しすぎました。',
    });
  } finally {
    LIMITS.maxSlots = previousLimit;
  }
});

test.each([
  ['vector<int>', 'std::vector<int> values(24);'],
  ['vector<pair<int, int>>', 'std::vector<std::pair<int, int>> values(24);'],
  ['string', "std::string values(1500, 'x');"],
])('bounds the cumulative snapshots of a C++ %s', (_type, declaration) => {
  const program = `#include <string>
#include <utility>
#include <vector>
int main() {
  ${declaration}
  for (int i = 0; i < COUNT; ++i) {
    values.size();
  }
}`;
  const previousLimit = LIMITS.maxCppTraceSize;
  LIMITS.maxCppTraceSize = 16_000;
  try {
    const short = program.replace('COUNT', '1');
    const long = program.replace('COUNT', '20');
    expect(traceProgram('cpp', short, short).traceItems.length).toBeGreaterThan(1);
    expect(() => traceProgram('cpp', long, long)).toThrow('Execution limit exceeded: trace');
    expect(executeProgram('cpp', long)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
  } finally {
    LIMITS.maxCppTraceSize = previousLimit;
  }
});

test('charges initializer-list storage and newly constructed vector elements', () => {
  const prefix = `#include <cstdio>
#include <vector>
int main() {
  std::vector<int> values{1, 2};`;
  const reusesStorage = `${prefix}
  values = {3, 4};
  std::printf("%d", values[0]);
}`;
  const grows = `${prefix}
  values = {3, 4, 5};
}`;
  const previousLimit = LIMITS.maxSlots;
  try {
    LIMITS.maxSlots = 6;
    expect(executeProgram('cpp', reusesStorage)).toMatchObject({
      kind: 'executed',
      stdout: '3',
      uncaughtException: undefined,
    });
    for (const [limit, program] of [
      [3, prefix + '}'],
      [5, reusesStorage],
      [9, grows],
    ] as const) {
      LIMITS.maxSlots = limit;
      expect(executeProgram('cpp', program)).toMatchObject({
        kind: 'executed',
        uncaughtException: expect.stringContaining('メモリを確保しすぎました'),
      });
    }
  } finally {
    LIMITS.maxSlots = previousLimit;
  }
});

test('accepts C compatibility headers and keeps function-like macro names usable as variables', () => {
  const program = `#include <stdbool.h>
#include <stdarg.h>
#include <time.h>
#include <assert.h>
#include <cstdio>
int main() {
  bool assert = true;
  std::printf("%d", assert);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined, stdout: '1' });
});

test('unordered map assignment retains earlier copied entries while later entries allocate turtles', () => {
  const program = `#include <unordered_map>
int copies;
struct Item {
  Turtle* turtle = nullptr;
  Item() {}
  Item(const Item&) : turtle(new Turtle(++copies, 0)) {}
};
int main() {
  std::unordered_map<int, Item> source, target;
  source.try_emplace(1);
  source.try_emplace(2);
  source.try_emplace(3);
  target = source;
}`;
  const execution = executeProgram('cpp', program);
  const trace = traceProgram('cpp', program, program);
  expect(execution).toMatchObject({
    kind: 'executed',
    finalTurtles: [
      expect.objectContaining({ x: 1 }),
      expect.objectContaining({ x: 2 }),
      expect.objectContaining({ x: 3 }),
    ],
  });
  expect(trace).toMatchObject({ finalTurtles: execution.kind === 'executed' ? execution.finalTurtles : undefined });
});

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
  ['map', 'int, Turtle', 'try_emplace(1, 0, 1)', 'try_emplace(2, probe(), 2)'],
  ['unordered_map', 'int, Turtle', 'try_emplace(1, 0, 1)', 'try_emplace(2, probe(), 2)'],
  ['list', 'Turtle', 'emplace_back(0, 1)', 'emplace_back(probe(), 2)'],
])('keeps a heap %s receiver reachable through emplacement', (header, types, first, next) => {
  const container = `std::${header}<${types}>`;
  const program = `#include <${header}>
#include <iostream>
Turtle observer(0, 0);
${container}& make() {
  auto* receiver = new ${container}();
  receiver->${first};
  return *receiver;
}
int probe() {
  std::cout << observer.canMoveForward();
  return 0;
}
int main() { make().${next}; }`;
  const result = executeProgram('cpp', program);
  if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
  expect(result.stdout).toBe('0');
});

test.each([
  [
    'ordered map',
    `#include <map>
std::map<int, Turtle>& make() {
  auto* receiver = new std::map<int, Turtle>();
  receiver->try_emplace(0, 0, 1);
  return *receiver;
}`,
  ],
  [
    'unordered map',
    `#include <unordered_map>
std::unordered_map<int, Turtle>& make() {
  auto* receiver = new std::unordered_map<int, Turtle>();
  receiver->try_emplace(0, 0, 1);
  return *receiver;
}`,
  ],
  [
    'vector',
    `#include <vector>
std::vector<Turtle*>& make() { return *new std::vector<Turtle*>{new Turtle(0, 1)}; }`,
  ],
  [
    'vector iterator',
    `#include <vector>
std::vector<Turtle*>::iterator make() {
  auto* receiver = new std::vector<Turtle*>{new Turtle(0, 1)};
  return receiver->begin();
}`,
  ],
  ['built-in array', 'Turtle** make() { return new Turtle*[1]{new Turtle(0, 1)}; }'],
])('keeps the heap storage for a %s subscript reachable during indexing', (_, factory) => {
  const program = `#include <iostream>
Turtle observer(0, 0);
${factory}
int probe() {
  std::cout << observer.canMoveForward();
  return 0;
}
int main() { make()[probe()]; }`;
  const result = executeProgram('cpp', program);
  if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
  expect(result.stdout).toBe('0');
});

test.each([
  ['forward iterator', 'iterator', 'begin'],
  ['reverse iterator', 'reverse_iterator', 'rbegin'],
  ['built-in pointer', '', ''],
])('keeps heap storage alive while offsetting a %s', (_, iterator, begin) => {
  const factory = iterator
    ? `std::vector<Turtle*>::${iterator} make() {
  auto* receiver = new std::vector<Turtle*>{new Turtle(0, 1)};
  return receiver->${begin}();
}`
    : 'Turtle** make() { return new Turtle*[1]{new Turtle(0, 1)}; }';
  const program = `#include <iostream>
#include <vector>
Turtle observer(0, 0);
${factory}
int probe() {
  std::cout << observer.canMoveForward();
  return 0;
}
int main() { make() + probe(); }`;
  const result = executeProgram('cpp', program);
  if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
  expect(result.stdout).toBe('0');
});

test.each([
  ['concatenation', "char probe() { observe(); return 'b'; }", 'std::cout << (make() + probe());', '0ab'],
  ['comparison', 'std::string probe() { observe(); return "a"; }', 'std::cout << (make() == probe());', '01'],
  [
    'assignment',
    'std::string target; std::string& probe() { observe(); return target; }',
    'probe() = make(); std::cout << target;',
    '0a',
  ],
])('keeps a borrowed string owner alive through %s', (_, probe, body, stdout) => {
  const program = `#include <iostream>
#include <string>
Turtle observer(0, 0);
struct Owner {
  Turtle blocker;
  std::string word;
  Owner() : blocker(0, 1), word("a") {}
};
std::string& make() { return (new Owner)->word; }
void observe() { std::cout << observer.canMoveForward(); }
${probe}
int main() { ${body} }`;
  const result = executeProgram('cpp', program);
  if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
  expect(result.stdout).toBe(stdout);
});

test.each([
  ['array decay', 'int values[1]{7};', 'int* make() { return (new Owner)->values; }', 'int* p = make();', '*p'],
  [
    'a nested array reference',
    'int values[1][1]{{7}};',
    'int& make() { return (new Owner)->values[0][0]; }',
    'int& value = make();',
    'value',
  ],
  [
    'a base subobject reference',
    'Entry entry;',
    'Base& make() { return (new Owner)->entry; }',
    'Base& value = make();',
    'value.number',
  ],
  [
    'a std::array data pointer',
    'std::array<int, 1> values{7};',
    'int* make() { return (new Owner)->values.data(); }',
    'int* p = make();',
    '*p',
  ],
  [
    'a nested std::array element reference',
    'std::array<std::array<int, 1>, 1> values{7};',
    'int& make() { return (new Owner)->values[0][0]; }',
    'int& value = make();',
    'value',
  ],
])('retains the heap owner through %s', (_, field, factory, bind, value) => {
  const program = `#include <array>
#include <iostream>
Turtle observer(0, 0);
struct Base { int number = 7; };
struct Entry : Base { virtual void marker() {} };
struct Owner {
  ${field}
  Turtle blocker;
  Owner() : blocker(0, 1) {}
};
${factory}
int main() {
  ${bind}
  std::cout << observer.canMoveForward() << ':' << ${value};
}`;
  const result = executeProgram('cpp', program);
  if (result.kind !== 'executed') throw new Error(JSON.stringify(result));
  expect(result.stdout).toBe('0:7');
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

test.each([
  ['count at the back', '', 'items.insert(items.end(), 3, value);'],
  ['count at the front', 'items.emplace_back();', 'items.insert(items.begin(), 3, value);'],
  ['range at the back', '', 'items.insert(items.end(), source, source + 3);'],
  ['range at the front', 'items.emplace_back();', 'items.insert(items.begin(), source, source + 3);'],
])('roots new deque elements during insertion by %s', (_, setup, insert) => {
  const program = `#include <deque>
int copies = 0;
struct Item {
  Turtle* turtle = nullptr;
  Item() {}
  Item(const Item&) { turtle = new Turtle(++copies, 0); }
};
int main() {
  Item value;
  Item source[3];
  std::deque<Item> items;
  ${setup}
  ${insert}
}`;
  const trace = traceProgram('cpp', program, program);
  expect(trace.finalTurtles.map(({ x }) => x)).toEqual([1, 2, 3]);
});

test('retains intermediate deque values during forward range insertion', () => {
  const program = `#include <deque>
#include <iostream>
#include <unordered_map>
#include <utility>
Turtle observer(0, 0);
int copies = 0;
struct Item {
  Turtle* turtle = nullptr;
  Item() {}
  Item(const Item&) {
    std::cout << observer.canMoveForward();
    turtle = new Turtle(0, ++copies);
  }
};
int main() {
  std::unordered_map<int, Item> source;
  source.try_emplace(1);
  source.try_emplace(2);
  source.try_emplace(3);
  std::deque<std::pair<int, Item>> items;
  items.insert(items.end(), source.begin(), source.end());
}`;
  expect(traceProgram('cpp', program, program)).toMatchObject({ stdout: '100000', uncaughtException: undefined });
});

test.each([
  ['deque', 1, [2, 3, 4, 5]],
  ['deque', 2, [1, 2, 4, 5]],
  ['vector', 1, [1, 2, 4, 5]],
  ['vector', 2, [1, 2, 4, 5]],
] as const)('retains the new %s element while emplacement shifts position %s', (type, at, expected) => {
  const program = `#include <${type}>
int copies = 0;
struct Item {
  Turtle* turtle = nullptr;
  Item() {}
  Item(const Item&) { turtle = new Turtle(++copies, 0); }
};
int main() {
  Item source;
  std::${type}<Item> items;
  ${type === 'vector' ? 'items.reserve(8);' : ''}
  items.emplace_back(source);
  items.emplace_back(source);
  items.emplace_back(source);
  items.emplace(items.begin() + ${at}, source);
}`;
  expect(traceProgram('cpp', program, program).finalTurtles.map(({ x }) => x)).toEqual(expected);
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
  ['a temporary struct', 'static_cast<void>(Group{Item(1), Item(2)});'],
  ['a temporary array', 'static_cast<void>(std::array<Item, 2>{Item(1), Item(2)});'],
  ['a factory allocation', 'delete make();'],
  ['a new struct', 'delete new Group{Item(1), Item(2)};'],
  ['a new array', 'delete[] new Item[2]{Item(1), Item(2)};'],
])('keeps the full owner alive while destroying %s', (_, statement) => {
  const program = `#include <array>
#include <iostream>
Turtle observer(0, 0);
struct Item {
  Turtle turtle;
  Item(int y) : turtle(0, y) {}
  ~Item() { std::cout << observer.canMoveForward(); }
};
struct Group { Item first; Item second; };
Group* make() { return new Group{Item(1), Item(2)}; }
int main() { ${statement} }`;
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

test('character arrays show elements beyond the C string terminator', () => {
  const program = `int main() {
  char bytes[4] = "ab";
  char* text = bytes;
  bytes[3] = 'X';
}`;
  const { traceItems } = traceProgram('cpp', program, program);
  expect(traceItems.find(({ line }) => line === 4)).toMatchObject({
    vars: { bytes: ['a', 'b', '\0', 'X'], text: 'ab' },
    referenceVars: {
      bytes: { kind: 'array', entries: { 3: { kind: 'value', value: 'X' } } },
    },
  });
});

test('a multimap trace preserves all duplicate keys in traversal order', () => {
  const program = `#include <map>
#include <string>
int main() {
  std::multimap<std::string, int> entries;
  entries.emplace("b", 10);
  entries.emplace("a", 20);
  entries.emplace("b", 30);
  entries.emplace("b", 40);
}`;
  const { traceItems } = traceProgram('cpp', program, program);
  expect(traceItems.at(-1)?.referenceVars.entries).toEqual({
    kind: 'array',
    entries: {
      0: { kind: 'object', entries: { first: { kind: 'value', value: 'a' }, second: { kind: 'value', value: 20 } } },
      1: { kind: 'object', entries: { first: { kind: 'value', value: 'b' }, second: { kind: 'value', value: 10 } } },
      2: { kind: 'object', entries: { first: { kind: 'value', value: 'b' }, second: { kind: 'value', value: 30 } } },
      3: { kind: 'object', entries: { first: { kind: 'value', value: 'b' }, second: { kind: 'value', value: 40 } } },
    },
  });
});

test.each([
  ['map<std::string, int>', '{{"2", 2}, {"10", 10}}', false],
  ['map<int, int, std::greater<int>>', '{{2, 2}, {10, 10}}', true],
  ['unordered_map<int, int>', '{{2, 2}, {10, 10}, {4, 4}}', true],
])('a %s trace follows its iteration order', (type, values, numeric) => {
  const program = `#include <functional>
#include <iostream>
#include <map>
#include <string>
#include <unordered_map>
int main() {
  std::${type} entries${values};
  for (const auto& entry : entries) std::cout << entry.first << ' ';
}`;
  const recording = traceProgram('cpp', program, program);
  const node = recording.traceItems.at(-1)?.referenceVars.entries;
  if (node?.kind !== 'array') throw new Error('Expected an ordered snapshot of entries');
  const keys = Object.values(node.entries).map((entry) => (entry.kind === 'object' ? entry.entries.first : undefined));
  expect(keys).toEqual(
    recording.stdout
      .trim()
      .split(' ')
      .map((key) => ({ kind: 'value', value: numeric ? Number(key) : key }))
  );
});

test('inner bindings hide outer trace values even before assignment', () => {
  const program = `int global = 1;
int main() {
  int local[] = {2};
  {
    int global, local;
    int marker = 3;
    local = 4;
  }
  int marker = 5;
}`;
  const { traceItems } = traceProgram('cpp', program, program);
  const beforeAssignment = traceItems.find(({ line }) => line === 6);
  const afterAssignment = traceItems.find(({ line }) => line === 7);
  expect(beforeAssignment?.vars).toEqual({ marker: 3 });
  expect(beforeAssignment?.referenceVars).toEqual({});
  expect(afterAssignment?.vars).toEqual({ local: 4, marker: 3 });
  expect(afterAssignment?.referenceVars).toEqual({});
  expect(traceItems.find(({ line }) => line === 9)).toMatchObject({
    vars: { global: 1, local: [2], marker: 5 },
    referenceVars: { local: { kind: 'array' } },
  });
});

test('a loop reuses local static storage and leaves its binding behind at scope exit', () => {
  const program = `int main() {
  int last = 0;
  for (int i = 0; i < 2; ++i) {
    static int count = 5;
    last = ++count;
  }
  int result = last;
}`;
  const { traceItems } = traceProgram('cpp', program, program);
  expect(traceItems.filter(({ line }) => line === 5).map(({ vars }) => vars.count)).toEqual([6, 7]);
  expect(traceItems.find(({ line }) => line === 7)?.vars).toEqual({ last: 7, result: 7 });
});

test('a for initializer records default turtle construction as Java does', () => {
  const cpp = 'int main() { for (Turtle t; t.canMoveForward(); t.forward()) {} }';
  const java = `public class Main {
  public static void main(String[] args) {
    for (Turtle t = new Turtle(); t.canMoveForward(); t.forward()) {}
  }
}`;
  const javaPositions = traceProgram('java', java, java).traceItems.map(({ turtles }) => turtles.map(({ y }) => y));
  const cppPositions = traceProgram('cpp', cpp, cpp).traceItems.map(({ turtles }) => turtles.map(({ y }) => y));
  expect(cppPositions).toEqual(javaPositions);
});

test.each(['p + n', 'p - n', '&p[n]', 'p += n'])('keeps the full unsigned pointer displacement in %s', (expression) => {
  const program = `#include <climits>
int main() {
  int values[3] = {1, 2, 3};
  int* p = values + 1;
  unsigned long n = ULONG_MAX;
  p = ${expression};
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('ポインタの足し算・引き算'),
  });
});

test('rotate rejects a middle iterator past its end', () => {
  const program = `#include <algorithm>
int main() {
  int values[] = {1, 2, 3, 4};
  std::rotate(values + 1, values + 4, values + 3);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('範囲（先頭と末尾のイテレータ）が正しくありません'),
  });
});

test.each(['values.end(), values.begin()', 'values.rend(), values.rbegin()'])(
  'distance requires the end of a list range to be reachable: %s',
  (endpoints) => {
    const program = `#include <iterator>
#include <list>
int main() {
  std::list<int> values{1, 2, 3};
  std::distance(${endpoints});
}`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('範囲（先頭と末尾のイテレータ）が正しくありません'),
    });
  }
);

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

test('an exception message pointer expires when its last owner ends', () => {
  const program = `#include <stdexcept>
int main() {
  const char* message = nullptr;
  {
    std::runtime_error original("message");
    message = original.what();
    std::runtime_error copy = original;
  }
  return message[0];
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('有効期間が終わった'),
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
  ['std::atoi("2147483648")', 'オーバーフロー'],
  ['std::atoi("-2147483649")', 'オーバーフロー'],
  ['std::atol("9223372036854775808")', 'オーバーフロー'],
  ['std::atol("-9223372036854775809")', 'オーバーフロー'],
  ['std::printf("%s", text)', 'nullptr'],
  ['std::printf("%.*s", 0, text)', 'nullptr'],
  ['std::printf("%d", 4294967297L)', '引数の型が合いません'],
  ['std::printf("%ld", 1LL)', '引数の型が合いません'],
  ['std::printf("%u", -1)', '引数の型が合いません'],
  ['std::printf("%*d", 3L, 1)', '引数の型が合いません'],
  ['std::printf("%.*d", 3L, 1)', '引数の型が合いません'],
  ['std::printf("%c", 65L)', '引数の型が合いません'],
  ['std::printf("%Lf", 1.0)', '引数の型が合いません'],
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

test.each(['strcpy(bytes, bytes + 1)', 'strncpy(bytes + 1, bytes, 3)', 'strcat(bytes, bytes + 1)'])(
  'rejects overlapping ranges in %s',
  (call) => {
    const program = `#include <cstring>
int main() { char bytes[16] = "abcd"; std::${call}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('領域が重なっています'),
    });
  }
);

test.each(['sprintf(bytes, "%s!", bytes)', 'snprintf(bytes + 1, 2, "%s", bytes)', 'sprintf(bytes, bytes)'])(
  'rejects overlapping formatted output in %s',
  (call) => {
    const program = `#include <cstdio>
int main() { char bytes[16] = "hi"; std::${call}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('領域が重なっています'),
    });
  }
);

test.each(['strcpy(bytes, "abc")', 'strncpy(bytes, "ab", 4)', 'strcat(bytes, "c")'])(
  'reports a short destination buffer as an out-of-bounds write in %s',
  (call) => {
    const program = `#include <cstring>
int main() { char bytes[3] = "ab"; std::${call}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('配列の範囲の外を読み書きしました'),
    });
  }
);

test.each([
  'std::string text(values.begin(), values.end());',
  'std::string text; text.append(values.begin(), values.end());',
])('string iterator ranges use the normal conversion to char: %s', (statement) => {
  const program = `#include <string>
#include <vector>
int main() { std::vector<double> values{200.0}; ${statement} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('浮動小数点数を整数にした値'),
  });
});

test('C string copies still reject overlapping character views of scalar storage', () => {
  const program = `#include <cstring>
int main() {
  unsigned int word = 0x61;
  char* bytes = static_cast<char*>(static_cast<void*>(&word));
  std::strcpy(bytes + 1, bytes);
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('領域が重なっています'),
  });
});

test.each(['text.copy(text.data() + 1, 10)', 'text.copy(text.data(), 2, 1)'])(
  'std::string::copy rejects overlap after clamping its count: %s',
  (call) => {
    const program = `#include <string>
int main() { std::string text = "abcd"; ${call}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'executed',
      uncaughtException: expect.stringContaining('領域が重なっています'),
    });
  }
);

test('string replacement rejects reversed destination iterators', () => {
  const program = `#include <string>
int main() {
  std::string text = "abcd";
  text.replace(text.begin() + 2, text.begin() + 1, "X");
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'executed',
    uncaughtException: expect.stringContaining('範囲（先頭と末尾のイテレータ）が正しくありません'),
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
