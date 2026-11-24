#include <iostream>
#include <optional>
#include <string>
#include <vector>
std::optional<int> find(const std::vector<int>& v, int x) {
  for (int i = 0; i < (int)v.size(); i++)
    if (v[i] == x) return i;
  return std::nullopt;
}
struct P {
  int x, y;
  P(int a, int b) : x(a), y(b) {}
};
int main() {
  std::vector<int> v{3, 1, 4};
  auto a = find(v, 4);
  auto b = find(v, 9);
  std::cout << a.has_value() << " " << *a << " " << b.has_value() << " " << b.value_or(-1) << "\n";
  if (a) std::cout << "found " << a.value() << "\n";
  std::optional<std::string> s;
  std::cout << sizeof(std::optional<int>) << " " << sizeof(std::optional<double>) << " " << sizeof(s) << "\n";
  s = "hello";
  std::cout << *s << " " << s->size() << "\n";
  s.reset();
  std::cout << s.has_value() << "\n";
  std::optional<P> p;
  p.emplace(1, 2);
  std::cout << p->x + p->y << "\n";
  try {
    b.value();
  } catch (const std::bad_optional_access& e) {
    std::cout << "error: " << e.what() << "\n";
  }
  std::optional<int> c = 5, d = 5, e;
  std::cout << (c == d) << (c != e) << (e == std::nullopt) << (c == 5) << (e < c) << "\n";
  auto m = std::make_optional(3.5);
  std::cout << *m << "\n";
  std::optional<std::vector<int>> ov{std::vector<int>{1, 2}};
  std::cout << ov->size() << "\n";
  std::optional<int> moved = std::move(c);
  std::cout << *moved << "\n";
}
