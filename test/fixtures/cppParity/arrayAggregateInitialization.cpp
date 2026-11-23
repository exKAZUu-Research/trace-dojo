#include <array>
#include <iostream>
#include <string>

constexpr int length = 3;
struct Config { static constexpr int length = 2; };
struct Pair { int x; int y; };
struct Count { int value; Count(int n) : value(n) {} };
struct Locked { const int value; };

int main() {
  const int localLength = 2;
  std::array<int, length> integers{{1, 2, 3}};
  std::array<std::string, localLength> strings{{"a", "b"}};
  std::array<Pair, Config::length> pairs{4, 5, 6, 7};
  std::array<Count, Config::length> counts{Count(8), Count(9)};
  std::array<std::array<int, 2>, 2> grid{{{{1, 2}}, {{3, 4}}}};
  std::array<Count, 0> empty;
  std::array<Count, Config::length> copied{counts};
  std::array<int, 2> direct{std::array<int, 2>{10, 11}};
  std::array<Locked, 0> vacant{};
  vacant.fill(Locked{1});
  std::cout << integers[2] << strings[1] << pairs[1].y << counts[0].value << grid[1][0] << empty.size()
            << copied[1].value << direct[1] << vacant.size() << '\n';
}
