#include <iostream>
#include <compare>
#include <set>
#include <string>
#include <algorithm>
#include <vector>
struct Version {
  int major, minor;
  auto operator<=>(const Version&) const = default;
};
struct Name {
  std::string first, last;
  bool operator==(const Name&) const = default;
};
struct Temp {
  double value;
  std::partial_ordering operator<=>(const Temp& o) const { return value <=> o.value; }
  bool operator==(const Temp& o) const { return value == o.value; }
};
struct P { int x; friend bool operator==(const P&, const P&) = default; };
int main() {
  Version a{1, 2}, b{1, 5};
  std::cout << (a < b) << (a > b) << (a == b) << (a != b) << (a <= a) << ((a <=> b) < 0) << "\n";
  auto c = 3 <=> 5;
  std::cout << (c < 0) << (c == std::strong_ordering::less) << ((2.0 <=> 1.0) > 0) << "\n";
  std::set<Version> versions = {{2, 0}, {1, 9}, {1, 10}};
  for (auto v : versions) std::cout << v.major << "." << v.minor << " ";
  std::cout << "\n";
  std::cout << (Name{"a", "b"} == Name{"a", "b"}) << (Name{"a", "b"} != Name{"a", "c"}) << "\n";
  Temp t1{1.5}, t2{2.5};
  std::cout << (t1 < t2) << (t1 >= t2) << (P{1} == P{1}) << "\n";
  std::vector<Version> vs = {{3, 1}, {1, 2}};
  std::sort(vs.begin(), vs.end());
  std::cout << vs[0].major << ((std::string("a") <=> std::string("b")) < 0) << "\n";
}
