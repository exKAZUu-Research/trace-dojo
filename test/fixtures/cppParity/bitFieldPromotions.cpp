#include <cstdio>
struct A { unsigned a : 3; int b : 2; };
struct B { char c; unsigned short s : 12; unsigned short t : 8; };
struct C { int x : 1; int : 0; char y; };
struct D { char a; char : 0; char b; };
struct E { long long a : 3; int b; };
struct F { unsigned char a : 4, b : 4, c : 4; };
enum Color { RED, GREEN, BLUE };
struct G { Color c : 2; bool on : 1; };
int main() {
  A x{};
  x.a = 2;
  x.b = 1;
  printf("%d %d\n", x.a - 3, x.b + 1);
  long long v = x.a - 5;
  printf("%lld\n", v);
  printf("%zu %zu %zu %zu %zu %zu %zu\n", sizeof(A), sizeof(B), sizeof(C), sizeof(D), sizeof(E), sizeof(F), sizeof(G));
  G g{BLUE, true};
  printf("%d %d\n", g.c, g.on);
  x.b = 2;
  printf("%d\n", x.b);
  unsigned u = ~x.a;
  printf("%u %d\n", u, -x.a);
}
