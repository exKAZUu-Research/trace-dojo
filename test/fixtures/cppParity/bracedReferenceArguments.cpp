#include <iostream>
struct H { int* p = nullptr; };
void f(H&& h) { std::cout << (h.p == nullptr) << "\n"; }
template <class T, class U = T> void g(U&& u) { std::cout << sizeof(U) << "\n"; }
template <class U = H> void k(U&& u) { std::cout << sizeof(U) << "\n"; }
int main() {
  f({});
  g<H>({});
  k({});
}
void h2() { H&& r = {}; std::cout << (r.p == nullptr) << "\n"; int&& n = {3}; std::cout << n << "\n"; }
int run2 = (h2(), 0);
