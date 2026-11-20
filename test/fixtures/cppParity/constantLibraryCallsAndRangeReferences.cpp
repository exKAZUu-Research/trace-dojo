#include <algorithm>
#include <iostream>
#include <limits>

struct Item {
  static int live;
  Item(int) { ++live; }
  ~Item() { --live; }
};
int Item::live;

constexpr int limit = std::numeric_limits<int>::max();
constexpr int minimum = std::min(3, 2);
int main() {
  int arr[]{1, 2, 3};
  for (const Item& value : arr) {
    std::cout << Item::live;
    if (Item::live == 1) continue;
  }
  std::cout << Item::live << ':' << limit << ':' << minimum << '\n';
}
