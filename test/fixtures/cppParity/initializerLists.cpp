#include <iostream>
#include <initializer_list>
#include <vector>
#include <string>
#include <algorithm>
class Bag {
  std::vector<int> items;
public:
  Bag() { std::cout << "default\n"; }
  Bag(int n, int v) : items(n, v) { std::cout << "fill\n"; }
  Bag(std::initializer_list<int> list) : items(list) { std::cout << "list " << list.size() << "\n"; }
  int sum() const { int s = 0; for (int x : items) s += x; return s; }
  std::size_t size() const { return items.size(); }
};
int total(std::initializer_list<int> values) {
  int s = 0;
  for (int v : values) s += v;
  return s;
}
template <class T>
T largest(std::initializer_list<T> values) { return *std::max_element(values.begin(), values.end()); }
int main() {
  Bag a{1, 2, 3};
  Bag b(2, 5);
  Bag c{2, 5};
  Bag d;
  Bag e{};
  std::cout << a.sum() << " " << b.sum() << " " << c.sum() << " " << d.size() << e.size() << "\n";
  std::cout << total({4, 5, 6}) << " " << total({}) << " " << largest({3.5, 9.25, 1.0}) << "\n";
  std::initializer_list<std::string> words{"x", "yy"};
  for (const auto& w : words) std::cout << w << ";";
  std::cout << words.size() << " " << sizeof(words) << "\n";
  auto list = {7, 8, 9};
  std::cout << list.size() << " " << *list.begin() << "\n";
}
