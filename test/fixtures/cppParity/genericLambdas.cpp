#include <iostream>
#include <vector>
#include <algorithm>
#include <string>
auto twice(auto x) { return x + x; }
void show(const auto& v) { for (const auto& x : v) std::cout << x << ' '; std::cout << '\n'; }
struct Printer { void print(auto x) const { std::cout << "<" << x << ">"; } };
int main() {
  auto add = [](auto a, auto b) { return a + b; };
  std::cout << add(1, 2) << " " << add(1.5, 2) << " " << add(std::string("a"), "b") << "\n";
  std::vector<int> v = {3, 1, 2};
  std::sort(v.begin(), v.end(), [](const auto& a, const auto& b) { return a > b; });
  show(v);
  int base = 10;
  auto plus = [&](auto x) { return x + base; };
  base = 20;
  std::cout << plus(1) << " " << plus(0.5) << "\n";
  auto ident = []<class T>(T x) { return x; };
  std::cout << ident(7) << twice(3) << twice(std::string("ab")) << "\n";
  Printer().print(5); Printer().print("s");
  std::cout << "\n";
  auto counter = [n = 0](auto step) mutable { n += step; return n; };
  std::cout << counter(2) << counter(3) << "\n";
}
