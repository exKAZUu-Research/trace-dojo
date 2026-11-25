#include <functional>
#include <iostream>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>
#include <algorithm>
using namespace std::placeholders;

struct Point {
  int x, y;
  bool operator==(const Point&) const = default;
};
template <>
struct std::hash<Point> {
  std::size_t operator()(const Point& p) const noexcept { return std::hash<int>{}(p.x) * 31 + std::hash<int>{}(p.y); }
};

int subtract(int a, int b) { return a - b; }
struct Greeter {
  std::string prefix;
  std::string greet(const std::string& name, int times) const {
    std::string out;
    for (int i = 0; i < times; ++i) out += prefix + name + ";";
    return out;
  }
};

int main() {
  auto minus10 = std::bind(subtract, _1, 10);
  auto reversed = std::bind(subtract, _2, _1);
  std::cout << minus10(25) << " " << reversed(3, 10) << "\n";
  Greeter g{"hi "};
  auto twice = std::bind(&Greeter::greet, &g, _1, 2);
  std::cout << twice("bob") << "\n";
  auto nested = std::bind(subtract, std::bind(subtract, _1, 1), _2);
  std::cout << nested(10, 4) << "\n";
  int counter = 0;
  auto add = [](int& c, int d) { c += d; };
  auto byRef = std::bind(add, std::ref(counter), _1);
  byRef(5);
  byRef(6);
  std::cout << counter << "\n";
  auto front = std::bind_front(subtract, 100);
  std::cout << front(1) << "\n";
  std::vector<int> v{5, 1, 4};
  std::sort(v.begin(), v.end(), std::bind(std::greater<int>{}, _1, _2));
  for (int x : v) std::cout << x;
  std::cout << "\n";
  std::cout << std::hash<std::string>{}("hello") << "\n";
  std::cout << std::hash<double>{}(1.5) << " " << std::hash<char>{}('a') << " " << std::hash<long>{}(-3) << "\n";
  std::cout << std::hash<std::string_view>{}("hello") << "\n";
  std::cout << std::hash<Point>{}(Point{1, 2}) << "\n";
  std::unordered_set<Point> points{{1, 2}, {3, 4}, {1, 2}};
  std::cout << points.size() << points.count({3, 4}) << "\n";
  std::cout << std::is_placeholder_v<decltype(_2)> << std::is_bind_expression_v<decltype(minus10)> << "\n";
}
