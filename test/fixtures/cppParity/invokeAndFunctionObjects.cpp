#include <functional>
#include <iostream>
#include <map>
struct S { int v = 3; int get(int a) const { return v + a; } };
int main() {
  S s;
  std::cout << std::invoke(&S::get, s, 4) << std::invoke([](int x) { return x * 2; }, 5) << std::invoke(&S::v, s) << "\n";
  auto r = std::ref(s.v); r.get() = 9; std::cout << s.v << "\n";
  std::cout << std::plus<int>{}(1, 2) << std::hash<int>{}(5) << "\n";
  auto nf = std::not_fn([](int x) { return x > 2; }); std::cout << nf(1) << "\n";
  auto mf = std::mem_fn(&S::get); std::cout << mf(s, 1) << "\n";
}
