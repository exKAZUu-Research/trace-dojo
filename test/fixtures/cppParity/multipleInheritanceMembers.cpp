#include <cstdio>
struct A { int a = 1; };
struct B { int b = 2; int getB() const { return b; } };
struct C : A, B { int c = 3; int sum() const { return a + b + c; } };
int main() { C x; printf("%d %d %d\n", x.sum(), x.b, x.getB()); B* p = &x; printf("%d\n", p->b); }
