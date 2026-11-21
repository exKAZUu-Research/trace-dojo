#include <algorithm>
#include <functional>
#include <iostream>
#include <numeric>
#include <vector>

struct Item {
  int n;
  Item(int value) : n(value) {}
  Item(const Item& other) : n(other.n) { std::cout << 'C'; }
  ~Item() { std::cout << n; }
};
bool isLess(const Item& a, const Item& b) { return a.n < b.n; }
int combine(const Item& item, double n) { return item.n + n * 10; }

int main() {
  Item min = std::min({Item(2), Item(1)}, isLess);
  std::cout << ' ' << min.n << ' ';
  const Item left[]{3, 4};
  const double right[]{0.5, 1.5};
  int result[2];
  std::transform(left, left + 2, right, result, combine);
  std::cout << result[0] << ' ' << result[1] << ' ';
  std::cout << std::plus<>()(1, 2.5) << ' ' << std::less<>()(1, 1.5) << ' ';
  std::vector<Item> items;
  items.emplace_back(5);
  items = std::vector<Item>{6};
  std::cout << ' ' << items[0].n << ' ';
  std::cout << std::accumulate(right, right + 2, 0, std::plus<double>())
            << std::accumulate(right, right + 2, 1, std::multiplies<>());
}
