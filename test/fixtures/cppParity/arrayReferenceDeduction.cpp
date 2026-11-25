#include <iostream>
template <class T, unsigned long N> void f(T (&)[N]) { std::cout << N << "\n"; }
template <class T, int N> void g(T (&a)[N]) { std::cout << N << sizeof(a) << "\n"; }
template <class T, unsigned long N = 0> struct S { S(T (&)[N]) { std::cout << "S" << N << "\n"; } };
int main() {
  int raw[] = {1, 2};
  f(raw);
  g(raw);
  S x(raw);
}
