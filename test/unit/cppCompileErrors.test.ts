import { expect, test } from 'vitest';

import { executeProgram } from '../../src/interpreter/program';

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
  [
    'an assignment to a class with a const member',
    'struct D { const int c; };\nint main() { D x{1}, y{2};\n  x = y; }',
    2,
  ],
  ['a default-initialized class with a const member', 'struct D { const int c; };\nint main() {\n  D d; }', 2],
  ['a const variable without an initializer', 'int main() {\n  const int x; }', 1],
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
  ['std::sqrt with only <cstdio>', '#include <cstdio>\nint main() {\n  double x = std::sqrt(2.0); }', 2],
  ['std::abs with only <cstdio>', '#include <cstdio>\nint main() {\n  int x = std::abs(-2); }', 2],
])('the interpreter rejects %s', (_, program, row) => {
  const execution = executeProgram('cpp', program.includes('int main') ? program : `${program}\nint main() {}`);
  expect(execution).toMatchObject({ kind: 'compileError', diagnostics: [{ row }] });
});
