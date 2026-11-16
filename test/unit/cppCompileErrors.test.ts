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
])('the interpreter rejects %s', (_, program, row) => {
  const execution = executeProgram('cpp', program.includes('int main') ? program : `${program}\nint main() {}`);
  expect(execution).toMatchObject({ kind: 'compileError', diagnostics: [{ row }] });
});
