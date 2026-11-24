#include <iostream>
#include <tuple>
#include <map>
#include <string>
std::tuple<int, std::string, double> record() { return {7, "seven", 7.5}; }
int main() {
  auto [id, name, score] = record();
  std::cout << id << " " << name << " " << score << "\n";
  std::tuple<int, int> t{1, 2};
  auto& [x, y] = t;
  x = 10;
  std::cout << std::get<0>(t) << " " << y << "\n";
  const auto [cx, cy] = t;
  std::cout << cx + cy << "\n";
  std::map<std::string, std::tuple<int, int>> m{{"a", {1, 2}}};
  for (const auto& [key, value] : m) {
    auto [p, q] = value;
    std::cout << key << p << q << "\n";
  }
}
