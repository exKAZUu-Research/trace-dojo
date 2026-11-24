#include <iostream>
struct Flags {
  unsigned a : 3, b : 5;
  int c : 4;
  unsigned : 0;
  bool d : 1;
  unsigned : 2;
  unsigned short e : 9;
};
struct P { char c; int x : 4; };
struct Q { char c; int : 4; };
struct R { char c; long long x : 40; char d; };
int main() {
  Flags f{};
  f.a = 9;
  f.b = 31;
  f.c = 7;
  f.c++;
  f.d = true;
  f.e = 1000;
  std::cout << f.a << " " << f.b << " " << f.c << " " << f.d << " " << f.e << "\n";
  f.c = -9;
  std::cout << f.c << " " << (f.a = 15) << "\n";
  std::cout << sizeof(Flags) << " " << alignof(Flags) << " " << sizeof(P) << " " << sizeof(Q) << " " << alignof(Q) << " " << sizeof(R) << "\n";
  Flags g = {1, 2, 3};
  std::cout << g.a << g.b << g.c << "\n";
  auto h = f.a;
  std::cout << sizeof(h) << " " << f.a + 1 << "\n";
}
