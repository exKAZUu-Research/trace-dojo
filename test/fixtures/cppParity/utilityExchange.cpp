#include <iostream>
#include <utility>
#include <string>
template <class T, class U = T>
T ex(T& o, U&& v) { T old = o; o = v; return old; }
struct H { int* p = nullptr; };
int main() {
  int a = 1;
  std::cout << ex(a, 5) << a << "\n";
  H h; int x; h.p = &x;
  H g = ex(h, {});
  std::cout << (g.p == &x) << (h.p == nullptr) << "\n";
  std::string s = "abc";
  std::cout << std::exchange(s, "z") << s << std::cmp_less(-1, 1u) << "\n";
}
