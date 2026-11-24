#include <cstdio>
struct A { int a = 1; A(int n=4):a(n){printf("A%d\n",n);} };
struct B : virtual A { B():A(2){} };
struct C : virtual A { int c = 2; };
struct D : B, C { D():A(5){} };
int main() { D d; printf("%d\n", d.a); C& c = d; printf("%d %d\n", c.a, c.c); }
