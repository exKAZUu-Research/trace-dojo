#include <algorithm>
#include <array>
#include <iostream>
#include <utility>
#include <vector>

struct Row { std::vector<int> values; };

struct Inner {
  Inner() {}
  Inner(const Inner&) { std::cout << 'C'; }
};
struct Outer { Inner inner; };
struct Token {
  Token() {}
  Token(const Token&) noexcept { std::cout << 'N'; }
};
struct MemberFallback { Token token; std::vector<int> values; };
struct BaseFallback : Token { std::vector<int> values; };

int main() {
  std::vector<std::vector<int>> rows{{1}, {4}, {5}, {2}, {3}, {6}};
  rows[2].reserve(16);
  int* point = rows[2].data();
  rows.reserve(20);
  std::cout << *point << ' ' << rows[2].capacity() << ' ';
  std::sort(rows.begin(), rows.end());
  for (const auto& row : rows) std::cout << row[0];
  std::cout << ' ' << *point << ' ' << rows[4].capacity() << ' ' << (point == rows[4].data()) << '\n';

  std::vector<std::pair<int, std::vector<int>>> pairs{{6,{6}}, {5,{5}}, {4,{4}}, {3,{3}}, {2,{2}}, {1,{1}}};
  int* savedPair = pairs[1].second.data();
  pairs.reserve(32);
  std::sort(pairs.begin(), pairs.end());
  std::cout << *savedPair << ' ' << (savedPair == pairs[4].second.data()) << '\n';

  std::vector<Row> wrapped(1);
  wrapped[0].values.push_back(7);
  int* savedMember = wrapped[0].values.data();
  wrapped.reserve(16);
  std::vector<std::array<std::vector<int>, 1>> fixed(1);
  fixed[0][0].push_back(8);
  int* savedFixed = fixed[0][0].data();
  fixed.reserve(16);
  std::cout << *savedMember << *savedFixed << '\n';

  std::vector<Outer> copies{Outer{}};
  std::cout << copies.size() << '\n';

  std::vector<MemberFallback> memberFallback(1);
  memberFallback[0].values.push_back(5);
  int* savedMemberFallback = memberFallback[0].values.data();
  memberFallback.reserve(16);
  std::vector<BaseFallback> baseFallback(1);
  baseFallback[0].values.push_back(6);
  int* savedBaseFallback = baseFallback[0].values.data();
  baseFallback.reserve(16);
  std::cout << *savedMemberFallback << *savedBaseFallback << '\n';
}
