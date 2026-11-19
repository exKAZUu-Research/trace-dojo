import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

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
  ['std::sqrt with only <cstdio>', '#include <cstdio>\nint main() {\n  double x = std::sqrt(2.0); }', 2],
  ['std::abs with only <cstdio>', '#include <cstdio>\nint main() {\n  int x = std::abs(-2); }', 2],
])('the interpreter rejects %s', (_, program, row) => {
  const execution = executeProgram('cpp', program.includes('int main') ? program : `${program}\nint main() {}`);
  expect(execution).toMatchObject({ kind: 'compileError', diagnostics: [{ row }] });
});
