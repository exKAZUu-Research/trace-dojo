#include <functional>
#include <iostream>
#include <type_traits>
int g = 1;
decltype(auto) a() { return (g); }
decltype(auto) b() { return g; }
template <class T> decltype(auto) c(T& w) { return w.get(); }
template <class T> decltype(auto) d(T& w) { if constexpr (true) return w.get(); else return 0; }
int main() {
  int x = 3;
  auto r = std::ref(x);
  std::cout << std::is_same_v<decltype(a()), int&> << std::is_same_v<decltype(b()), int> << std::is_same_v<decltype(c(r)), int&> << std::is_same_v<decltype(d(r)), int&> << "\n";
  c(r) = 8;
  std::cout << x << "\n";
}
