import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

test.each(['auto value = value;', 'static auto value = value;', 'auto& value = value;', 'static auto& value = value;'])(
  'rejects a self-reference before deduction in %s',
  (declaration) => {
    const program = `int value = 7;
int main() { ${declaration} }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 1, message: expect.stringContaining('型が決まる前には使えません') }],
    });
  }
);

test.each([
  'std::string value;',
  'std::stringstream value{};',
  'new std::string("value");',
  'sizeof(std::string);',
  'std::string* pointer = nullptr; pointer->size();',
])('requires a definition beyond <iosfwd> for %s', (body) => {
  const program = `#include <iosfwd>
int main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('はまだ定義されていません') }],
  });
});

test('keeps a transparent comparator distinct from the ordered container default', () => {
  const program = `#include <functional>
#include <map>
int main() {
  std::map<int, int, std::less<>> source;
  std::map<int, int>* pointer = &source;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 4 }] });
});

test('a C header does not expose FILE in namespace std', () => {
  const program = `#include <stdio.h>
int main() { std::FILE* stream = stdout; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('FILE') }],
  });
});

test('keeps every pure virtual member in a grouped C++ declaration', () => {
  const program = `struct Base { virtual int first() = 0, second() = 0; };
struct Partial : Base { int first() override { return 1; } };
int main() { Partial value; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('Partial は抽象クラス') }],
  });
});

test.each([
  ['qualified', '', 'std::remove'],
  ['unqualified', 'using namespace std;', 'remove'],
])('rejects %s algorithm remove with only <cstdio>', (_scope, directive, name) => {
  const program = `#include <cstdio>
${directive}
int main() { int a[] = {1, 2, 1}; ${name}(a, a + 3, 1); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('remove') }],
  });
});

test.each([
  ['double value{source};', 'long double'],
  ['std::vector<double> values{source};', 'long double'],
  ['float value{3.4028236e38};', 'double'],
])('diagnoses narrowing in C++ list initialization of %s', (statement, sourceType) => {
  const program = `#include <vector>
int main() {
  long double source = 1.25L;
  ${statement}
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining(`${sourceType} 型の値`) }],
  });
});

test.each(['bool flag{&n};', 'std::vector<bool> flags{&n};', 'bool flag{static_cast<int*>(nullptr)};'])(
  'diagnoses pointer-to-bool narrowing in C++ list initialization of %s',
  (statement) => {
    const program = `#include <vector>
int main() {
  int n = 0;
  ${statement}
}`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 3, message: expect.stringContaining('縮小変換') }],
    });
  }
);

test.each([
  ['set', 'set<const int>', '要素を const 型にはできません'],
  ['set', 'multiset<const int>', '要素を const 型にはできません'],
  ['unordered_set', 'unordered_set<const int>', '要素を const 型にはできません'],
  ['set', 'set<int&>', '要素を参照にはできません'],
  ['unordered_set', 'unordered_set<int&>', '要素を参照にはできません'],
  ['set', 'set<void>', '要素を void にはできません'],
  ['set', 'set<int[]>', '要素には大きさが決まるオブジェクト型'],
])('rejects a non-allocatable element in <%s> std::%s', (header, container, message) => {
  const program = `#include <${header}>
int main() { std::${container} elements; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining(message) }],
  });
});

test.each([
  'std::set<Item> items;',
  'std::multiset<Item> items;',
  'auto items = new std::set<Item>;',
  'auto items = new std::set<Item>{};',
  'std::set<Item>* items = nullptr; delete items;',
])('requires a complete element type when constructing or destroying %s', (statement) => {
  const program = `#include <set>
struct Item;
int main() { ${statement} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('クラス Item はまだ定義されていません') }],
  });
});

test('rejects a still-incomplete element when a containing object is constructed', () => {
  const program = `#include <set>
struct Item;
struct Owner { std::set<Item> items; };
int main() { Owner owner; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('クラス Item はまだ定義されていません') }],
  });
});

test.each([
  ['set', 'set<Item>'],
  ['set', 'multiset<Item>'],
  ['map', 'map<int, Item>'],
  ['unordered_map', 'unordered_map<int, Item>'],
  ['list', 'list<Item>'],
  ['set', 'set<std::array<Item, 1>>'],
  ['map', 'map<int, std::array<Item, 1>>'],
  ['list', 'list<std::array<Item, 1>>'],
  ['list', 'list<std::array<Item, 0>>'],
])('rejects abstract classes laid out as elements in <%s> std::%s', (header, container) => {
  const program = `#include <${header}>
#include <array>
struct Item;
struct Owner { std::${container} items; };
int main() { Owner owner; }
struct Item { virtual void f() = 0; };`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ message: expect.stringContaining('Item は抽象クラス') }],
  });
});

test('requires a complete std::array element even in a zero-length member layout', () => {
  const program = `#include <array>
struct Item;
struct Owner { std::array<Item, 0> items; };
struct Item {};
int main() {}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('クラス Item はまだ定義されていません') }],
  });
});

test('requires a complete field layout when measuring a pair that embeds a fixed array', () => {
  const program = `#include <array>
#include <utility>
struct Item;
std::pair<std::array<Item, 2>, char>* pointer;
int main() { return sizeof(*pointer); }
struct Item { long value; };`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 4, message: expect.stringContaining('クラス Item はまだ定義されていません') }],
  });
});

test.each([
  ['map', 'map<Key, int>'],
  ['set', 'set<Key>'],
])('requires comparable keys for equal_range on an empty <%s>', (header, type) => {
  const program = `#include <${header}>
struct Key { int value; };
int main() { std::${type} entries; Key key{1}; entries.equal_range(key); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('Key の値は < で比べられない') }],
  });
});

test.each([
  ['time.h', 'time(0);', '時刻'],
  ['ctime', 'time_t start = 0;', 'time_t'],
  ['cstdlib', 'double value = atof("1.5");', 'atof'],
  ['cstdlib', 'double value = std::atof("1.5");', 'std::atof'],
  ['cassert', 'assert(true);', 'assert'],
  ['cerrno', 'errno = 0;', 'errno'],
])('an SDK declaration in <%s> gets an unsupported diagnostic for %s', (header, statement, name) => {
  const program = `#include <${header}>
int main() { ${statement} }`;
  const execution = executeProgram('cpp', program);
  expect(execution).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining(name) }],
  });
  expect(execution).toMatchObject({
    diagnostics: [{ message: expect.stringContaining('この採点環境では使えません') }],
  });
});

test.each(['Derived()', 'make()'])('a reference cannot bind to an inaccessible base of %s', (source) => {
  const program = `struct Base {};
class Derived : private Base {};
Derived make() { return Derived(); }
int main() { const Base& value = ${source}; }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 3 }] });
});

test.each([
  'std::vector<Item> items(1);',
  'std::vector<Item> items; items.resize(1);',
  'std::map<int, Item> items; items[0];',
  'std::unordered_map<int, Item> items; items[0];',
  'std::pair<int, Item> item;',
  'std::array<Item, 1> items;',
])('library default construction cannot access a private constructor in %s', (statement) => {
  const program = `#include <array>
#include <map>
#include <unordered_map>
#include <utility>
#include <vector>
class Item {
public:
  static void make() { ${statement} }
private:
  Item() {}
};
int main() { Item::make(); }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 7 }] });
});

test.each(['uniform_int_distribution<int>', 'uniform_real_distribution<double>'])(
  'copy-list initialization cannot select the explicit constructor of std::%s',
  (distribution) => {
    const program = `#include <random>
int main() { std::${distribution} value = {1, 6}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 1, message: expect.stringContaining('explicit') }],
    });
  }
);

test.each([
  ['int source() {return 2;}\nstruct S { static const int count{source()}; };', 1, '定数'],
  ['struct S { static const int count{2.5}; };', 0, '縮小変換'],
  ['struct S { static const int count{3}; };\nint main() { const int* p = &S::count; }', 1, '定義'],
  ['struct S { static const int count{3}; };\nconst int S::count{4};', 1, 'すでに指定'],
  ['struct S { static const int count; };\nint S::count = 3;', 1, '型が宣言と違います'],
  ['struct S { static int count; };\nconst int S::count = 3;', 1, '型が宣言と違います'],
])('validates a braced static member and its definition: %s', (source, row, message) => {
  const program = source.includes('int main') ? source : `${source}\nint main() {}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row, message: expect.stringContaining(message) }],
  });
});

test('a viable initializer-list insertion still requires copying its elements', () => {
  const program = `#include <vector>
class Item { public: Item() {} private: Item(const Item&); };
struct Box { std::vector<Item> items; Box(int n) : items(n) {} };
int main() { std::vector<Box> target; target.insert(target.end(), {2}); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining('private') }],
  });
});

test('a braced argument to push_back cannot select an explicit constructor', () => {
  const program = `#include <random>
#include <vector>
int main() { std::vector<std::mt19937> target; target.push_back({2}); }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 2 }] });
});

test.each([
  'int main() { const std::mt19937& engine = {2}; }',
  'int main() { static const std::mt19937& engine = {2}; }',
  'const std::mt19937& engine = {2}; int main() {}',
])('copy-list reference initialization rejects an explicit constructor: %s', (declaration) => {
  const program = `#include <random>
${declaration}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('explicit') }],
  });
});

test.each([
  'auto copy = source;',
  'std::vector<std::vector<Item>> target; target.push_back(source);',
  'std::vector<std::vector<Item>> target; target.insert(target.end(), source);',
  'std::stack<std::vector<Item>> target; target.push(source);',
])('copying a vector still requires access to the element copy constructor: %s', (copy) => {
  const program = `#include <stack>
#include <vector>
class Item { public: Item() {} private: Item(const Item&); };
int main() { std::vector<Item> source(2); ${copy} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining('private') }],
  });
});

test.each([
  'static int main() {}',
  'inline int main() {}',
  'constexpr int main() {}',
  'const int main() {}',
  'inline int main(); int main() {}',
  'static int main(); int main() {}',
])('rejects an invalid entry point declaration: %s', (program) => {
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 0 }] });
});

test.each([String.raw`"\x100"`, String.raw`"\400"`, String.raw`'\x100'`, String.raw`'\400'`])(
  'rejects a numeric escape outside the character range in %s',
  (literal) => {
    const program = `int main() { auto value = ${literal}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 0, message: expect.stringContaining('文字の値の範囲') }],
    });
  }
);

test.each(['int n = 2;', 'WithDefault n;', 'WithDestructor n;', 'WithDefault n[2];'])(
  'rejects a switch label that bypasses initialization of %s',
  (declaration) => {
    const program = `struct WithDefault { int n = 1; };
struct WithDestructor { ~WithDestructor() {} };
int main() {
  switch (1) {
    case 0: ${declaration}
    case 1: break;
  }
}`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 5, message: expect.stringContaining('飛び越えて') }],
    });
  }
);

test.each([
  ['std::accumulate(input, input + 2, 0, add)', 'int add(int& sum, int item) { return sum + item; }'],
  [
    'std::inner_product(input, input + 2, input, 0, add, multiply)',
    'int add(int& sum, int item) { return sum + item; }',
  ],
  [
    'std::inner_product(input, input + 2, input, 0, add, multiply)',
    'int add(int sum, int& item) { return sum + item; }',
  ],
  ['std::partial_sum(input, input + 2, output, add)', 'int add(int& sum, int item) { return sum + item; }'],
])('rejects a callback taking an rvalue by mutable reference in %s with %s', (call, callback) => {
  const program = `#include <numeric>
${callback}
int multiply(int left, int right) { return left * right; }
int main() { int input[] = {1, 2}, output[2] = {}; ${call}; }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 3 }] });
});

test.each(['Base value;', 'Base values[1];'])(
  'a protected destructor cannot destroy a separate base-typed member: %s',
  (member) => {
    const program = `struct Base { protected: ~Base() {} };
struct Derived : Base { ${member} };
int main() { Derived object; }`;
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 2 }] });
  }
);

test.each(['Base value;', 'Base values[1];'])(
  'a protected constructor cannot construct a separate base-typed member: %s',
  (member) => {
    const program = `struct Base { protected: Base() {} };
struct Derived : Base { ${member} Derived() {} };
int main() { Derived object; }`;
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 1 }] });
  }
);

test.each(['Turtle', 'WithTurtle', 'WithCopy'])('assignment through a pair requires an assignable %s', (type) => {
  const program = `#include <utility>
struct WithTurtle { Turtle turtle; };
struct WithCopy { Turtle turtle; WithCopy() {} WithCopy(const WithCopy&) {} };
int main() {
  ${type} first, second;
  std::pair<${type}&, int> target(first, 1), source(second, 2);
  target = source;
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 6, message: expect.stringContaining('代入演算子が削除') }],
  });
});

test.each(['private', 'protected'])('an array may not destroy an element with a %s destructor', (access) => {
  const program = `#include <array>
struct Item { Item(int) {} ${access}: ~Item() {} };
int main() { std::array<Item, 1> items{Item(7)}; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('デストラクタ') }],
  });
});

test.each([
  'std::pair<const int, int> a{1, 2}, b{3, 4}; a = b;',
  'std::map<int, int> m{{1, 2}, {3, 4}}; auto a = *m.begin(); auto b = a; a = b;',
  'std::pair<Item, int> a{{1}, 2}, b{{3}, 4}; a = b;',
])('a pair may not assign a nonassignable member: %s', (body) => {
  const program = `#include <map>
#include <utility>
struct Item { const int value; };
int main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining('代入演算子が削除') }],
  });
});

test.each(['values.data();', 'bool& bit = values[0];', 'for (auto& bit : values) bit = false;'])(
  'vector<bool> does not expose bit addresses: %s',
  (body) => {
    const program = `#include <vector>
int main() { std::vector<bool> values{true}; ${body} }`;
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 1 }] });
  }
);

test.each(['time', 'log', 'index', 'random', 'floor', 'free', 'signal'])(
  'a C header function hides an untagged class name %s',
  (name) => {
    const program = `#include <cmath>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <ctime>
struct ${name} { int value; };
int main() { ${name} value; }`;
    expect(executeProgram('cpp', program)).toMatchObject({ kind: 'compileError', diagnostics: [{ row: 6 }] });
  }
);

test.each(['data', 'rank', 'empty', 'ref', 'hash', 'search', 'merge', 'byte', 'tuple', 'move', 'cin'])(
  'using namespace std makes an unqualified global named %s ambiguous',
  (name) => {
    const program = `#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
using namespace std;
int ${name} = 1;
int main() { cout << ${name}; }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 6, message: expect.stringContaining('どちらを指すのか決まりません') }],
    });
  }
);

test.each([
  ['cstdio', 'int value; scanf("%d", &value);'],
  ['cstdio', 'std::scanf("%*d");'],
  ['stdio.h', 'getchar();'],
  ['cstdio', 'FILE* file = fopen("example.txt", "r");'],
  ['cstdio', 'char buffer[8]; fgets(buffer, 8, stdin);'],
  ['cstdio', 'std::remove("example.txt");'],
])('rejects unavailable C input and file access with an explicit diagnostic: %s %s', (header, body) => {
  const program = `#include <${header}>
int main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('この採点環境では使えません。') }],
  });
});

test('copy-list initialization rejects an explicit forwarding pair constructor', () => {
  const program = `#include <utility>
#include <vector>
int main() { std::pair<std::vector<int>, int> pair = {1, 2}; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('explicit') }],
  });
});

test.each([
  ['struct Holder { static int& value; };\nint& Holder::value;', 1],
  ['struct Holder { inline static int& value; };', 0],
])('a static reference definition requires an initializer', (source, row) => {
  expect(executeProgram('cpp', `${source}\nint main() {}`)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row, message: expect.stringContaining('初期値') }],
  });
});

test.each([
  [
    'int count = 3;\nstruct Holder { inline static constexpr const int& value = count; };\nconstexpr int copied = Holder::value;\nint main() {}',
    2,
  ],
  ['int main() { const int& value = 3;\nconstexpr int copied = value; }', 1],
  [
    'const int count = 3;\nint main() { int calls = 0; const int& a = count; const int& b = (++calls, a);\nconstexpr int copied = b; }',
    2,
  ],
  [
    'const double rate = 1.5;\nstruct Holder { inline static const double& value = rate; };\nconstexpr double copied = Holder::value;\nint main() {}',
    2,
  ],
  ['const float rate = 1.5f;\nconst float& value = rate + 1.0f;\nconstexpr float copied = value;\nint main() {}', 2],
  ['int main() { const double rate = 1.5;\nconstexpr double copied = rate * 2; }', 1],
])('a reference must designate a readable constant for constexpr initialization', (source, row) => {
  expect(executeProgram('cpp', source)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row, message: expect.stringContaining('定数式') }],
  });
});

test.each([
  ['for_each', 'void callback(bool&) {}', 'callback'],
  ['transform', 'int callback(bool&) { return 1; }', 'out, callback'],
])('std::%s rejects bool lvalue references for bit proxy callbacks', (name, callback, argumentsAfterRange) => {
  const program = `#include <algorithm>
#include <vector>
${callback}
int main() { std::vector<bool> bits{true}; int out[1]; std::${name}(bits.begin(), bits.end(), ${argumentsAfterRange}); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining('std::vector<bool>::reference') }],
  });
});

test.each([
  ['reverse', 'v.begin(), v.end()'],
  ['rotate', 'v.begin(), v.begin() + 1, v.end()'],
  ['sort', 'v.begin(), v.end(), less'],
  ['stable_sort', 'v.begin(), v.end(), less'],
  ['shuffle', 'v.begin(), v.end(), std::mt19937()'],
  ['next_permutation', 'v.begin(), v.end(), less'],
])('std::%s requires definitions reached by element copies', (algorithm, args) => {
  const program = `#include <algorithm>
#include <random>
#include <vector>
struct Item { static int copies; int n = 0; Item() {} Item(const Item&) { ++copies; } };
bool less(const Item& a, const Item& b) { return a.n < b.n; }
int main() { std::vector<Item> v(3); std::${algorithm}(${args}); }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 3, message: expect.stringContaining('Item::copies') }],
  });
});

// Apple clang++ 21 (`-std=c++20`) rejects each program at the given row, counted from 0.
test.each([
  [
    'a private member of a class forward-declared as a struct',
    'struct C;\nclass C { int value; };\nint main() { C c; return c.value; }',
    2,
  ],
  [
    'a private base of a class forward-declared as a struct',
    'struct B {};\nstruct D;\nclass D : B {};\nint main() { D d; B& base = d; }',
    3,
  ],
  ['a private member of a base', 'struct B { private: int x = 1; };\nstruct D : B { int f() { return B::x; } };', 1],
  ['a private member function of a base', 'struct B { private: void g() {} };\nstruct D : B { void f() { g(); } };', 1],
  [
    'a member of a private base in a grandchild',
    'struct B { int x = 1; };\nstruct D : private B {};\nstruct E : D { int f() { return x; } };',
    2,
  ],
  [
    'a conversion to a protected base',
    'struct B {};\nstruct D : protected B {};\nint main() { D d;\n  B* p = &d; }',
    3,
  ],
  [
    'a protected member through a reference to the base',
    'struct B { protected: int p = 1; };\nstruct D : B { int f(B& b) { return b.p; } };',
    1,
  ],
  ['a private static member function', 'class A { static void f() {} };\nint main() {\n  A::f(); }', 2],
  ['a private copy constructor', 'class A { A(const A&) {} public: A() {} };\nint main() { A a;\n  A b = a; }', 2],
  ['a private destructor', 'class A { ~A() {} public: A() {} };\nint main() {\n  A a; }', 2],
  ['braced construction through a private constructor', 'class A { A(int) {} };\nint main() {\n  A a{1}; }', 2],
  [
    'an assignment to a class with a const member',
    'struct D { const int c; };\nint main() { D x{1}, y{2};\n  x = y; }',
    2,
  ],
  ['a default-initialized class with a const member', 'struct D { const int c; };\nint main() {\n  D d; }', 2],
  ['a const variable without an initializer', 'int main() {\n  const int x; }', 1],
  ['an auto array', 'int main() {\n  auto a[2] = {1, 2}; }', 1],
  ['an auto size operand', 'int main() {\n  return sizeof(auto); }', 1],
  ['an incomplete class size operand', 'struct A;\nint main() { return sizeof(A); }', 1],
  ['size_t with no headers', 'int main() {\n  size_t count = 0; }', 1],
  ['a qualified integer typedef with no headers', 'int main() {\n  std::uint32_t count = 0; }', 1],
  ['a used static member lacking a definition', 'struct A { static int n; };\nint main() {\n  return A::n; }', 2],
  ['an undefined constructor', 'struct A { A(); };\nint main() {\n  A a; }', 2],
  ['an undefined destructor', 'struct A { ~A(); };\nint main() {\n  A a; }', 2],
  [
    'a live inline destructor needing a definition',
    'void missing();\nstruct A { ~A() { missing(); } };\nint main() { A a; }',
    1,
  ],
  [
    'a live vtable needing a definition',
    'void missing();\nstruct A { virtual void f() { missing(); } };\nint main() { A a; }',
    1,
  ],
  ['a const constructor', 'struct A {\n  A() const; };', 1],
  [
    'a vector operation reaching an inline copy constructor',
    '#include <vector>\nvoid missing();\nstruct A { A() {} A(const A&) { missing(); } };\nint main() { std::vector<A> a(1); a.reserve(2); }',
    2,
  ],
  [
    'a vector operation reaching an inline element destructor',
    '#include <vector>\nvoid missing();\nstruct A { ~A() { missing(); } };\nint main() { delete new std::vector<A>(1); }',
    2,
  ],
  [
    'a pair constructor reaching an inline copy constructor',
    '#include <utility>\nvoid missing();\nstruct A { A() {} A(const A&) { missing(); } };\nint main() { A a; std::pair<A, int> p(a, 1); }',
    2,
  ],
  ['a qualified constructor declaration', 'struct A {\n  const A(); };', 1],
  ['a qualified constructor definition', 'struct A { A(); };\nconst A::A() {}\nint main() {}', 1],
  ['an incomplete thrown object', 'struct A;\nvoid f(A* p) { throw *p; }\nint main() {}', 1],
  ['an incomplete catch reference', 'struct A;\nint main() { try { throw 1; } catch (const A&) {} }', 1],
  ['a class missing a semicolon before a declaration', 'struct A {\n int x;\n}\nvoid f() {}\nint main() {}', 2],
  ['a missing semicolon before comments', 'struct A {\n int x;\n}\n// Line\n/* Block */\nint main() {}', 2],
  ['a missing semicolon after a string', '#include <string>\nint main() {\n std::string s = "abc"\n int x = 1;\n}', 2],
  ['a prefix operation missing its semicolon', 'int main() {\n int x = 0;\n ++x\n ++x;\n}', 2],
  ['a struct definition missing its semicolon', 'struct A {\n  int n;\n}\nint main() {}', 2],
  ['a postfix operation missing its semicolon', 'int main() {\n  int n = 0;\n  n++\n  n--;\n}', 2],
  ['an else without its if', 'int main() {\n  int n = 0;\n  else {}\n}', 2],
  ['a nonconstant constexpr variable', 'int f() { return 1; }\nint main() {\n  constexpr int n = f(); }', 2],
  ['a nonconstant constexpr static member', 'int f() { return 1; }\nstruct S {\n  static constexpr int n = f(); };', 2],
  [
    'a deduced callback that names an overload set',
    '#include <algorithm>\n#include <iostream>\n#include <string>\nint main() { std::string s = "a";\n  std::transform(s.begin(), s.end(), s.begin(), std::toupper); }',
    4,
  ],
  ['a named void parameter', 'void f(void x) {}\nint main() {}', 0],
  ['an inconsistent noexcept declaration', 'void f() noexcept;\nvoid f() {}\nint main() {}', 1],
  [
    'an override on a nonvirtual destructor',
    'struct Base { ~Base() {} };\nstruct Derived : Base { ~Derived() override {} };\nint main() {}',
    1,
  ],
  [
    'an implicit override of a final destructor',
    'struct Base { virtual ~Base() final {} };\nstruct Derived : Base {};\nint main() {}',
    1,
  ],
  [
    'narrowing in a braced base initializer',
    'struct Base { Base(int) {} };\nstruct Derived : Base { Derived() : Base{2.5} {} };\nint main() {}',
    1,
  ],
  [
    'narrowing in a braced delegated initializer',
    'struct Value { Value(int) {}\n  Value() : Value{2.5} {} };\nint main() {}',
    1,
  ],
  [
    'a throwing override of std::exception::what',
    '#include <exception>\nstruct Error : std::exception { const char* what() const override { return "error"; } };\nint main() {}',
    1,
  ],
  ['a default value for a mutable reference', 'void f(int& n = 1) {}\nint main() {}', 0],
  ['an incomplete array parameter element', 'void f(int cells[2][]) {}\nint main() {}', 0],
  ['an incomplete global array', 'int cells[];\nint main() {}', 0],
  [
    'a priority queue from an unmatched braced argument',
    '#include <queue>\nint main() { std::priority_queue<int> q({3, 1}); }',
    1,
  ],
  [
    'narrowing within a nested pair member list',
    '#include <utility>\nint main() { std::pair<int, int> p{{2.5}, 1}; }',
    1,
  ],
  ['a const object allocated without an initializer', 'int main() {\n  auto p = new const int; }', 1],
  ['an assignment to a const object allocated with new', 'int main() { auto p = new int const{7};\n  *p = 8; }', 1],
  ['vector emplacement without a position', '#include <vector>\nint main() { std::vector<int> v;\n  v.emplace(); }', 2],
  ['map try_emplace without a key', '#include <map>\nint main() { std::map<int, int> m;\n  m.try_emplace(); }', 2],
  [
    'try_emplace on std::multimap',
    '#include <map>\nint main() { std::multimap<int, int> m;\n  m.try_emplace(1, 2); }',
    2,
  ],
  [
    'an assignment to a const object allocated with an interleaved sized type',
    'int main() { auto p = new unsigned const int{7};\n  *p = 8; }',
    1,
  ],
  [
    'an assignment to a const pointer allocated with new',
    'int main() { auto p = new int* const{nullptr};\n  *p = nullptr; }',
    1,
  ],
  ['a case jump over an initializer', 'int main() { switch (0) { int n = 1;\n  case 0: return n; } }', 1],
  ['a redeclaration in the outermost for body', 'int main() { for (int i = 0; i < 1; i++) {\n  int i = 5; } }', 1],
  ['a redeclaration in the outermost range-for body', 'int main() { for (int i : {1, 2}) {\n  int i = 5; } }', 1],
  [
    'different deduced range-for list types',
    '#include <initializer_list>\nint main() { for (auto i : {1, 2L}) {} }',
    1,
  ],
  [
    'a using directive after leaving its block',
    '#include <iostream>\nint main() { { using namespace std; cout << 1; }\n  cout << 2; }',
    2,
  ],
  ['a duplicate base initializer', 'struct Base {};\nstruct Derived : Base {\n  Derived() : Base(), Base() {} };', 2],
  ['a catch-all before another handler', 'int main() { try { throw 1; }\n  catch (...) {} catch (int) {} }', 1],
  ['a void catch parameter', 'int main() { try { throw 1; }\n  catch (void) {} }', 1],
  [
    'sorting a const range',
    '#include <algorithm>\n#include <vector>\nint main() { const std::vector<int> v{2,1};\n  std::sort(v.begin(), v.end()); }',
    3,
  ],
  [
    'shuffling with a const engine',
    '#include <algorithm>\n#include <random>\nint main() { int a[] = {1, 2}; const std::mt19937 engine(9);\n  std::shuffle(a, a + 2, engine); }',
    3,
  ],
  [
    'copying to a const iterator',
    '#include <algorithm>\n#include <vector>\nint main() { std::vector<int> v{1}; int data[1] = {2};\n  std::copy(data, data + 1, v.cbegin()); }',
    3,
  ],
  [
    'assigning through a search of a const C string',
    "#include <cstring>\nint main() { const char word[] = \"abc\";\n  *std::strchr(word, 'b') = 'd'; }",
    2,
  ],
  ['an abstract class as a parameter type', 'struct A { virtual void h() = 0; };\nvoid g(A a) {}', 1],
  ['an int argument between double and bool', 'void f(double) {}\nvoid f(bool) {}\nint main() {\n  f(1); }', 3],
  ['a chained comparison', 'int main() { int a = 1;\n  bool b = 0 < a < 2; }', 1],
  ['sizeof of void', 'int main() {\n  int n = sizeof(void); }', 1],
  ['auto deduced as different types', 'int main() {\n  auto x = 1, y = 2.0; }', 1],
  [
    'an override of what() without noexcept',
    '#include <exception>\nstruct E : std::exception {\n  const char* what() const override { return "e"; } };',
    2,
  ],
  [
    'a qualified call of an undefined pure virtual function',
    'struct A { virtual void f() = 0; };\nstruct B : A { void f() override {\n  A::f(); } };\nint main() { B b; b.f(); }',
    2,
  ],
  [
    'a list iterator plus an integer',
    '#include <list>\nint main() { std::list<int> l{1};\n  auto it = l.begin() + 1; }',
    2,
  ],
  [
    'list iterators compared with <',
    '#include <list>\nint main() { std::list<int> l;\n  bool b = l.begin() < l.end(); }',
    2,
  ],
  ['+= on a list iterator', '#include <list>\nint main() { std::list<int> l{1}; auto it = l.begin();\n  it += 1; }', 2],
  [
    'std::sort of a list',
    '#include <list>\n#include <algorithm>\nint main() { std::list<int> l;\n  std::sort(l.begin(), l.end()); }',
    3,
  ],
  [
    'std::shuffle of a list',
    '#include <list>\n#include <algorithm>\n#include <random>\nint main() { std::list<int> l; std::mt19937 g;\n  std::shuffle(l.begin(), l.end(), g); }',
    4,
  ],
  [
    '-- on an unordered_set iterator',
    '#include <unordered_set>\nint main() { std::unordered_set<int> s{1}; auto it = s.end();\n  --it; }',
    2,
  ],
  [
    'std::prev of an unordered_set iterator',
    '#include <unordered_set>\n#include <iterator>\nint main() { std::unordered_set<int> s{1};\n  std::prev(s.end()); }',
    3,
  ],
  [
    'resize of a vector of a class without a default constructor',
    '#include <vector>\nstruct P { P(int) {} };\nint main() { std::vector<P> v;\n  v.resize(3); }',
    3,
  ],
  [
    'a vector of n objects of a class without a default constructor',
    '#include <vector>\nstruct P { P(int) {} };\nint main() {\n  std::vector<P> v(3); }',
    3,
  ],
  [
    '[] of a map whose mapped type has no default constructor',
    '#include <map>\nstruct P { P(int) {} };\nint main() { std::map<int, P> m;\n  m[1]; }',
    3,
  ],
  [
    'list::remove of a class without ==',
    '#include <list>\nstruct P { int x; };\nint main() { std::list<P> l;\n  l.remove(P{1}); }',
    3,
  ],
  [
    'set::insert of a class without <',
    '#include <set>\nstruct P { int x; };\nint main() { std::set<P> s;\n  s.insert(P{1}); }',
    3,
  ],
  ['a global variable named index after <iostream>', '#include <iostream>\nint index = 3;', 1],
  [
    'a global function with div parameters and the wrong return type',
    '#include <cstdlib>\nint div(int a, int b) { return a / b; }',
    1,
  ],
  ['std::cout with only <initializer_list>', '#include <initializer_list>\nint main() { std::cout << 7; }', 1],
  ['std::map with only <cassert>', '#include <cassert>\nint main() { std::map<int, int> data; }', 1],
  ['emplace on a const map', '#include <map>\nint main() { const std::map<int, int> m; m.emplace(1, 2); }', 1],
  [
    'try_emplace on a const unordered_map',
    '#include <unordered_map>\nint main() { const std::unordered_map<int, int> m; m.try_emplace(1, 2); }',
    1,
  ],
  ['a call of a const random engine', '#include <random>\nint main() { const std::mt19937 engine; engine(); }', 1],
  [
    'a distribution called with a const engine',
    '#include <random>\nint main() { const std::mt19937 engine; std::uniform_int_distribution<int> draw; draw(engine); }',
    1,
  ],
  [
    'a call of a const distribution',
    '#include <random>\nint main() { std::mt19937 engine; const std::uniform_int_distribution<int> draw; draw(engine); }',
    1,
  ],
  [
    'a floating-point constant in a std::array bound',
    '#include <array>\nconstexpr double length = 2;\nint main() { std::array<int, length> values; }',
    2,
  ],
  ['a negative std::array bound', '#include <array>\nint main() { std::array<int, -1> values; }', 1],
  ['a non-type argument in a std::vector element type', '#include <vector>\nint main() { std::vector<2> values; }', 1],
  ['a global variable named malloc after a transitive C header', '#include <vector>\nint malloc = 3;', 1],
  ['a global variable named scanf after <cstdio>', '#include <cstdio>\nint scanf = 3;', 1],
  [
    'a new abs overload that duplicates a using-declaration',
    '#include <iostream>\ndouble abs(double value) { return value; }',
    1,
  ],
  ['a surrogate Unicode string escape', String.raw`int main() { const char* s = "\uD800"; }`, 0],
  ['a Unicode string escape beyond the last code point', String.raw`int main() { const char* s = "\U00110000"; }`, 0],
  ['a partially written Unicode string escape', String.raw`int main() { const char* s = "\u123"; }`, 0],
  ['a local variable using a macro from <cmath>', '#include <cmath>\nint main() { double M_PI = 3; }', 1],
  ['a parameter using a macro from <cstdio>', '#include <cstdio>\nvoid report(int EOF) {}', 1],
  ['a global variable using a transitive macro from <iostream>', '#include <iostream>\nint RAND_MAX = 3;', 1],
  [
    'a definition that redefines the SDK toupper function',
    '#include <iostream>\nint toupper(int value) { return value; }',
    1,
  ],
  [
    'narrowing in the selected vector initializer-list overload',
    '#include <vector>\nint main() { std::vector<unsigned char> values{300}; }',
    1,
  ],
  [
    'nested narrowing in a vector initializer list',
    '#include <vector>\nint main() { std::vector<std::vector<unsigned char>> values{{300}}; }',
    1,
  ],
  ['std::sqrt with only <cstdio>', '#include <cstdio>\nint main() {\n  double x = std::sqrt(2.0); }', 2],
  ['std::abs with only <cstdio>', '#include <cstdio>\nint main() {\n  int x = std::abs(-2); }', 2],
  ['std::size without a header', 'int main() { int a[3] = {}; return std::size(a); }', 0],
  ['std::ostream without a header', 'int main() { std::ostream* p = nullptr; }', 0],
  [
    'fill with an element type that has a deleted assignment operator',
    '#include <algorithm>\nstruct X { const int n; };\nint main() { X a[] = {{1}}; std::fill(a, a + 1, X{2}); }',
    2,
  ],
  [
    'array fill with a deleted element assignment',
    '#include <array>\nstruct X { const int n; };\nint main() { std::array<X, 1> a{{{1}}}; a.fill(X{2}); }',
    2,
  ],
  [
    'min comparator that requires a mutable reference',
    '#include <algorithm>\nbool compare(int& a, int& b) { return a < b; }\nint main() { int a=1, b=2; std::min(a, b, compare); }',
    2,
  ],
  [
    'initializer-list max comparator that requires a mutable reference',
    '#include <algorithm>\nbool compare(int& a, int& b) { return a < b; }\nint main() { std::max({1, 2}, compare); }',
    2,
  ],
  ['array fill with const elements', '#include <array>\nint main() { std::array<const int, 1> a{1}; a.fill(2); }', 1],
  [
    'empty array fill with a const element type',
    '#include <array>\nint main() { std::array<const int, 0> a{}; a.fill(2); }',
    1,
  ],
  [
    'remove_if with an element type that has a deleted assignment operator',
    '#include <algorithm>\nstruct X { const int n; };\nbool keep(const X&) { return true; }\nint main() { X a[] = {{1}}; std::remove_if(a, a + 1, keep); }',
    3,
  ],
  [
    'library copy of a private copy constructor from a member that could call it directly',
    '#include <vector>\nclass X { X(const X&) {} public: X() {} void store() { std::vector<X> v; v.push_back(*this); } };',
    1,
  ],
  [
    'copy from a const object with only a mutable reference copy constructor',
    'struct X { X() {} X(X&) {} };\nint main() { const X a; X b = a; }',
    1,
  ],
  [
    'implicit copy with an inaccessible base copy constructor',
    'class Base { Base(const Base&) {} public: Base() {} };\nstruct Child : Base {};\nint main() { Child a; Child b = a; }',
    2,
  ],
  [
    'a prvalue argument with an inaccessible destructor',
    'class X { ~X() {} public: X() {} };\nvoid f(X) {}\nint main() { f(X()); }',
    2,
  ],
  [
    'different iterator types in a single deduced range',
    '#include <algorithm>\n#include <vector>\nint main() { std::vector<int> v{1, 2}; std::sort(v.begin(), v.cend()); }',
    2,
  ],
  [
    'different iterator types in a sequence range constructor',
    '#include <vector>\nint main() { std::vector<int> v{1, 2}; std::vector<int> w(v.begin(), v.cend()); }',
    1,
  ],
  [
    'a static_cast to an inaccessible base',
    'struct Base {}; struct Derived : private Base {};\nint main() { Derived value; auto p = static_cast<Base*>(&value); }',
    1,
  ],
  [
    'comparing class pointers through an inaccessible base',
    'struct Base {}; struct Derived : private Base {};\nint main() { Derived value; Base* p = nullptr; return p == &value; }',
    1,
  ],
  ['a constructor delegation cycle', 'struct X { X() : X(1) {}\n X(int) : X() {} };', 1],
  [
    'adding const in a covariant virtual return',
    'struct Base { virtual Base* get(); };\nstruct Derived : Base { const Derived* get() override; };',
    1,
  ],
  ['incrementing void pointers', 'int main() { void* p = nullptr; ++p; }', 0],
  [
    'two implicit class conversion directions in a conditional expression',
    'struct B; struct A { A() {} A(const B&) {} };\nstruct B { B() {} B(const A&) {} };\nint main() { auto value = true ? A() : B(); }',
    2,
  ],
  ['a floating-point case label', 'int main() { switch (1) { case 1.5: return 0; } }', 0],
  ['an out-of-range case label', 'int main() { switch (1) { case 4294967295ULL: return 0; } }', 0],
  ['a non-const reference to a temporary member', 'struct X { int n = 1; };\nint main() { int& r = X{}.n; }', 1],
  [
    'a non-const reference to an element in a temporary array member',
    'struct X { int values[1][1] = {{1}}; };\nint main() { int& r = X{}.values[0][0]; }',
    1,
  ],
  [
    'a non-const reference to a conditional temporary member',
    'struct X { int value = 1; };\nint main() { int& r = true ? X{}.value : X{}.value; }',
    1,
  ],
  ['NULL without a declaring header', 'int main() { int* p = NULL; }', 0],
  ['copy-initialization of bool from nullptr', 'int main() { bool flag = nullptr; }', 0],
  ['copy-list-initialization of bool from nullptr', 'int main() { bool flag = {nullptr}; }', 0],
  [
    'constant bool initialization with a call returning nullptr',
    '#include <cstddef>\nstd::nullptr_t value() { return nullptr; }\nint main() { constexpr bool flag(value()); }',
    2,
  ],
  [
    'constant pointer initialization with a call returning nullptr',
    '#include <cstddef>\nstd::nullptr_t value() { return nullptr; }\nconstexpr int* pointer = value();',
    2,
  ],
  [
    'constexpr nullptr variable initialized by a nonconstant call',
    '#include <cstddef>\nstd::nullptr_t value() { return nullptr; }\nconstexpr std::nullptr_t pointer = value();',
    2,
  ],
  [
    'passing nullptr to a vector Boolean push operation',
    '#include <vector>\nint main() { std::vector<bool> values; values.push_back(nullptr); }',
    1,
  ],
  ...[
    ['vector', 'std::vector<bool> values(source, source + 1);'],
    ['vector', 'std::vector<bool> values; values.assign(source, source + 1);'],
    ['vector', 'std::vector<bool> values; values.insert(values.begin(), source, source + 1);'],
    ['deque', 'std::deque<bool> values; values.assign(source, source + 1);'],
    ['deque', 'std::deque<bool> values; values.insert(values.begin(), source, source + 1);'],
    ['list', 'std::list<bool> values; values.assign(source, source + 1);'],
  ].map(([header, use]): [string, string, number] => [
    `assigning a nullptr range to Boolean storage with ${use}`,
    `#include <cstddef>\n#include <${header}>\nint main() { std::nullptr_t source[]{nullptr}; ${use} }`,
    2,
  ]),
  ['a default member initializer copy-initializing bool from nullptr', 'struct Flag { bool value = {nullptr}; };', 0],
  [
    'an empty aggregate missing explicit braces in a deduced array',
    'struct E {};\nint main() { E entries[] = {1}; }',
    1,
  ],
  [
    'an empty aggregate member missing braces in a deduced array',
    'struct E {}; struct Item { E empty; int value; };\nint main() { Item entries[] = {1}; }',
    1,
  ],
  [
    'const default-initialization of an object with an uninitialized nested field',
    'struct Inner { int value; }; struct Outer { Inner inner; };\nint main() { const Outer value; }',
    1,
  ],
  [
    'a using-declaration conflicting with a local variable',
    '#include <iostream>\nint main() { int cout = 1; using std::cout; }',
    1,
  ],
  [
    'a using-declaration conflicting with a function of the same signature',
    '#include <string>\nstd::string to_string(int value) { return "x"; }\nusing std::to_string;',
    2,
  ],
  [
    'a function declaration conflicting with an already imported signature',
    '#include <string>\nusing std::to_string;\nstd::string to_string(int value);',
    2,
  ],
  [
    'insertion and extraction on a const stream',
    '#include <sstream>\nint main() { const std::ostringstream s; s << 42; }',
    1,
  ],
  ['a static local variable of type void', 'int main() { static void v; }', 0],
  ['excess initializers for a multidimensional allocation', 'int main() { new int[1][2]{1, 2, 3}; }', 0],
  [
    'std::array copying a const source with a mutable-only element copy constructor',
    '#include <array>\nstruct X { X() {} X(X&) {} };\nint main() { const std::array<X, 1> source; auto copy = source; }',
    2,
  ],
  [
    'evaluated parameter shadowing a global in a function default',
    'int n = 5;\nvoid f(int n, int step = n) {}\nint main() { f(1); }',
    1,
  ],
  [
    'evaluated parameter shadowing a static member in a constructor default',
    'struct X { inline static int n = 5;\nX(int n, int step = n) {} };\nint main() { X x(1); }',
    1,
  ],
  [
    'adding the same default argument in a second declaration',
    'int f(int value = 1);\nint f(int value = 2);\nint main() {}',
    1,
  ],
  [
    'adding a default that turns an out-of-class definition into a default constructor',
    'struct X { X(int); };\nX::X(int value = 2) {}\nint main() {}',
    1,
  ],
  [
    'inaccessible data member in an unevaluated operand',
    'class X { int size; };\nint main() { return sizeof(X::size); }',
    1,
  ],
  [
    'pointer overloads with competing qualification conversions',
    'void f(int* const*, const int* const*);\nvoid f(const int* const*, int* const*);\nint main() { int value; int* p = &value; f(&p, &p); }',
    2,
  ],
  [
    'vector erase requiring deleted element assignment',
    '#include <vector>\nstruct X { const int n; };\nint main() { std::vector<X> v{{1}, {2}}; v.erase(v.begin()); }',
    2,
  ],
  [
    'vector copy assignment requiring deleted element assignment',
    '#include <vector>\nstruct X { const int n; };\nint main() { std::vector<X> a{{1}}, b{{2}}; a = b; }',
    2,
  ],
  [
    'map insert_or_assign requiring deleted mapped assignment',
    '#include <map>\nstruct X { const int n; };\nint main() { std::map<int, X> m; m.insert_or_assign(1, X{2}); }',
    2,
  ],
  [
    'map insertion invoking a private mapped copy constructor',
    '#include <map>\nclass X { X(const X&) {} public: X() {} };\nint main() { std::pair<const int, X> p; std::map<int, X> m; m.insert(p); }',
    2,
  ],
  [
    'unordered map insertion invoking a private mapped copy constructor',
    '#include <unordered_map>\nclass X { X(const X&) {} public: X() {} };\nint main() { std::pair<const int, X> p; std::unordered_map<int, X> m; m.insert(p); }',
    2,
  ],
  [
    'returning a named local with a deleted copy constructor',
    'class Base { Base(const Base&) {} public: Base() {} };\nstruct Derived : Base {};\nDerived make() { Derived value; return value; }',
    2,
  ],
  [
    'default arguments on a function passed to for_each',
    '#include <algorithm>\nvoid emit(int, int = 9) {}\nint main() { int values[] = {1}; std::for_each(values, values + 1, emit); }',
    2,
  ],
  [
    'private copying for an algorithm callback initiated inside the element class',
    '#include <algorithm>\nclass X; void f(X);\nclass X { X(const X&) {} public: X() {} void run() { X a[1]; std::for_each(a, a + 1, f); } };\nvoid f(X) {}',
    2,
  ],
  [
    'private allocator construction initiated inside the element class',
    '#include <vector>\nclass X { X(int) {} public: void run() { std::vector<X> values; values.emplace_back(2); } };',
    1,
  ],
  [
    'default arguments on a function passed to transform',
    '#include <algorithm>\nint twice(int x, int scale = 2) { return x * scale; }\nint main() { int a[] = {1}, b[1]; std::transform(a, a + 1, b, twice); }',
    2,
  ],
  [
    'a void-returning function used as a predicate',
    '#include <algorithm>\nvoid pred(int) {}\nint main() { int values[] = {1}; return std::count_if(values, values + 1, pred); }',
    2,
  ],
  [
    'a hidden class in the leading return type of an out-of-class member',
    '#include <ctime>\nstruct time { time next() const; };\ntime time::next() const { return time{}; }',
    2,
  ],
])('the interpreter rejects %s', (_, program, row) => {
  const execution = executeProgram('cpp', program.includes('int main') ? program : `${program}\nint main() {}`);
  expect(execution).toMatchObject({ kind: 'compileError', diagnostics: [{ row }] });
});

test.each([
  'std::ios* p = &std::cout; static_cast<std::ostream*>(p);',
  'std::ios_base* p = &std::cout; static_cast<std::ostream*>(p);',
  'std::stringstream s; std::ios& r = s; static_cast<std::stringstream&>(r);',
  'std::ios* p = &std::cout; (std::ostream*)p;',
])('rejects a stream downcast through the virtual base std::ios in %s', (body) => {
  const program = `#include <iostream>
#include <sstream>
int main() { ${body} }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 2, message: expect.stringContaining('仮想基底クラス std::ios') }],
  });
});

test.each([
  ['class E { ~E() {} public: E() {} }; int main() { throw E(); }', 'のデストラクタは private なので'],
  ['struct E { ~E(); }; int main() { try { throw E(); } catch (...) {} }', 'は宣言だけで、定義（本体）がありません'],
])('requires the destructor of a thrown exception object in %s', (program, message) => {
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: expect.stringContaining(message) }],
  });
});

test.each(['0', 'text'])('rejects a non-callable std::unique predicate %s', (predicate) => {
  const program = `#include <algorithm>
#include <string>
int main() {
  int values[3] = {1, 1, 2};
  std::string text;
  std::unique(values, values + 3, ${predicate});
}`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 5, message: expect.stringContaining('関数 unique に') }],
  });
});

test.each(['S& r = s; int a[r.N];', 'S* p = &s; int a[p->N];'])(
  'rejects a static constant named through a non-constant object expression in %s',
  (body) => {
    const program = `struct S { static const int N = 3; };
int main() { S s; ${body} }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 1, message: expect.stringContaining('可変長配列') }],
    });
  }
);

test.each([
  ['int main() { void* p = new void[3]; }', 'void のオブジェクトは new で作れません'],
  ['struct X; int main() { X* p = new X[0]{}; }', 'クラス X はまだ定義されていません'],
  ['struct X { virtual void f() = 0; }; int main() { X* p = new X[0]{}; }', 'X は抽象クラス'],
  ['struct X { X() {} private: ~X() {} }; int main() { X* p = new X[2]; }', 'X のデストラクタは private'],
  ['struct X { X(int) {} }; int main() { X* p = new X[0]; }', 'X のコンストラクタ に、引数（）に合うものがありません'],
  [
    'struct X { X(int) {} }; int main() { X* p = new X[0](); }',
    'X のコンストラクタ に、引数（）に合うものがありません',
  ],
])('rejects the array new expression in %s', (program, message) => {
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 0, message: expect.stringContaining(message) }],
  });
});

test('accepts a braced zero-length array new of a class without a default constructor', () => {
  const program = `struct X { X(int) {} };
int main() { X* p = new X[0]{}; delete[] p; }`;
  expect(executeProgram('cpp', program)).toMatchObject({ kind: 'executed', uncaughtException: undefined });
});

test.each(['make()', '(std::cout << "x", std::plus<>{})'])(
  'rejects a constexpr functor call whose callable %s is not a constant expression',
  (callable) => {
    const program = `#include <functional>
#include <iostream>
std::plus<> make() { std::cout << "called"; return {}; }
int main() { constexpr int n = ${callable}(1, 2); }`;
    expect(executeProgram('cpp', program)).toMatchObject({
      kind: 'compileError',
      diagnostics: [{ row: 3, message: expect.stringContaining('定数式') }],
    });
  }
);

test.each([
  ['S a[2];', 'a[5].N'],
  ['S a[2];', 'a[-1].N'],
  ['static S a[2];', 'a[5].N'],
  ['static S a[2];', 'a[-1].N'],
])('rejects a static constant named through out-of-bounds element of %s %s', (declaration, bound) => {
  const program = `struct S { static const int N = 3; };
int main() { ${declaration} int b[${bound}]; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('可変長配列') }],
  });
});

test.each([
  '1.0 / 0.0',
  '0.0 / 0.0',
  'std::numeric_limits<double>::infinity() - std::numeric_limits<double>::infinity()',
  'std::numeric_limits<double>::quiet_NaN() + 1.0',
])('rejects the invalid floating operation %s in a constexpr initializer', (value) => {
  const program = `#include <limits>
int main() { constexpr double x = ${value}; }`;
  expect(executeProgram('cpp', program)).toMatchObject({
    kind: 'compileError',
    diagnostics: [{ row: 1, message: expect.stringContaining('定数式') }],
  });
});
