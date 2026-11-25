#include <iostream>
#include <cstddef>
#include <stdexcept>
struct alignas(16) Aligned { int x; };
struct Mixed { char c; alignas(8) int v; };
struct P { char a; int b; double c; };
extern int shared;
int readShared() { return shared; }
int shared = 42;
int counter() { thread_local int calls = 0; return ++calls; }
int check(int x) { if (x <= 0) throw std::invalid_argument("negative"); return x; }
struct Guard {
  int v;
  Guard(int x) try : v(check(x)) {
  } catch (const std::exception& e) {
    std::cout << "ctor caught " << e.what() << "\n";
  }
};
int parse(int x) try {
  if (x < 0) throw std::runtime_error("bad");
  return x;
} catch (const std::exception& e) {
  return -1;
}
int main() {
  std::cout << sizeof(Aligned) << alignof(Aligned) << sizeof(Mixed) << " " << offsetof(P, b) << offsetof(P, c) << alignof(double) << "\n";
  std::cout << readShared() << counter() << counter() << "\n";
  __typeof__(shared) t = 3;
  int e = __extension__ (t + 1);
  int z = 0;
  std::cout << t << e << (z ?: 9) << (t ?: 9) << "\n";
  auto p = (P){'a', 2, 3.5};
  std::cout << p.b << p.c << _Generic(p.b, int: "int", default: "other") << "\n";
  std::cout << parse(5) << parse(-5) << "\n";
  try { Guard g(-1); } catch (const std::exception& e) { std::cout << "rethrown " << e.what() << "\n"; }
  const int ci = 7;
  int* pi = (int*)&ci;
  std::cout << *pi << "\n";
  int local(int);
  std::cout << local(3) << "\n";
}
int local(int x) { return x * 10; }
