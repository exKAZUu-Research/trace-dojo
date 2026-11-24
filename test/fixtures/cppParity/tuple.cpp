#include <iostream>
#include <tuple>
#include <string>
#include <vector>
#include <algorithm>
std::tuple<int, std::string, double> record() { return {1, "one", 1.5}; }
int add3(int a, int b, int c) { return a + b + c; }
int main() {
  std::tuple<int, double, char> t(1, 2.5, 'c');
  std::cout << std::get<0>(t) << " " << std::get<1>(t) << " " << std::get<2>(t) << " " << sizeof(t) << "\n";
  std::get<0>(t) = 10;
  std::cout << std::get<int>(t) << " " << std::tuple_size_v<decltype(t)> << "\n";
  auto m = std::make_tuple(3, std::string("x"), 4.5);
  std::cout << std::get<1>(m) << "\n";
  int a;
  std::string b;
  double c;
  std::tie(a, b, c) = record();
  std::cout << a << b << c << "\n";
  std::tie(a, std::ignore, c) = m;
  std::cout << a << c << "\n";
  std::vector<std::tuple<int, std::string>> people{{30, "b"}, {20, "a"}, {30, "a"}};
  std::sort(people.begin(), people.end());
  for (const auto& p : people) std::cout << std::get<0>(p) << std::get<1>(p) << " ";
  std::cout << "\n";
  std::cout << (std::make_tuple(1, 2) == std::make_tuple(1, 2)) << (std::make_tuple(1, 2) < std::make_tuple(1, 3)) << "\n";
  std::cout << std::apply(add3, std::make_tuple(1, 2, 3)) << "\n";
  auto joined = std::tuple_cat(std::make_tuple(1), std::make_tuple('z', 2.5));
  std::cout << std::get<1>(joined) << std::tuple_size_v<decltype(joined)> << "\n";
  std::tuple deduced{1, 2.0};
  std::tuple_element_t<1, decltype(deduced)> dv = std::get<1>(deduced);
  std::cout << dv << " " << sizeof(std::tuple<char, int>) << " " << sizeof(std::tuple<>) << "\n";
  std::tuple<int, int> p = std::make_pair(5, 6);
  std::cout << std::get<1>(p) << "\n";
}
