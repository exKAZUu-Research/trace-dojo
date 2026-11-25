#include <iostream>
#include <vector>
#include <string>
template <class... Ts> auto sum(Ts... xs) { return (xs + ...); }
template <class... Ts> auto sumFrom(Ts... xs) { return (100 + ... + xs); }
template <class... Ts> void printAll(const Ts&... xs) { (std::cout << ... << xs) << "\n"; }
template <class... Ts> std::size_t count(Ts...) { return sizeof...(Ts); }
template <class... Ts> bool allPositive(Ts... xs) { return (... && (xs > 0)); }
void print() { std::cout << "end\n"; }
template <class T, class... Rest> void print(T first, Rest... rest) { std::cout << first << " "; print(rest...); }
template <class... Ts> std::vector<int> toVector(Ts... xs) { return {static_cast<int>(xs)...}; }
template <class... Ts> void each(Ts... xs) { ((std::cout << "[" << xs << "]"), ...); std::cout << "\n"; }
template <class... Ts> struct Holder { static const int size = sizeof...(Ts); };
int main() {
  std::cout << sum(1, 2, 3) << " " << sum(1.5, 2) << " " << sumFrom(1, 2) << "\n";
  printAll(1, " and ", 2.5, std::string("!"));
  std::cout << count() << count(1, 'a', "s") << "\n";
  std::cout << allPositive(1, 2, 3) << allPositive(1, -2) << allPositive() << "\n";
  print(1, "two", 3.0);
  std::vector<int> v = toVector(1.9, 2, 'A');
  for (int x : v) std::cout << x << " ";
  std::cout << "\n";
  each(1, "x", 2.5);
  std::cout << Holder<int, char, double>::size << "\n";
}
