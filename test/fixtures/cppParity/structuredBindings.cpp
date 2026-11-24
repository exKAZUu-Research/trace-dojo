#include <iostream>
#include <map>
#include <string>
#include <utility>
#include <array>
struct Point { int x; double y; };
std::pair<int, std::string> make() { return {7, "seven"}; }
int main() {
  std::map<std::string, int> m = {{"a", 1}, {"b", 2}};
  for (const auto& [key, value] : m) std::cout << key << "=" << value << " ";
  std::cout << "\n";
  for (auto& [key, value] : m) value *= 10;
  std::cout << m["a"] << m["b"] << "\n";
  auto [n, s] = make();
  std::cout << n << s << "\n";
  Point p{1, 2.5};
  auto& [px, py] = p;
  px = 9;
  std::cout << p.x << " " << py << "\n";
  int arr[3] = {4, 5, 6};
  auto [a, b, c] = arr;
  a = 100;
  std::cout << arr[0] << b << c << "\n";
  std::array<int, 2> sa = {8, 9};
  auto [s1, s2] = sa;
  std::cout << s1 + s2 << "\n";
  auto [it, inserted] = m.insert({"c", 3});
  std::cout << it->first << inserted << "\n";
}
