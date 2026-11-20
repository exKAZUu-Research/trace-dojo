#include <algorithm>
#include <functional>
#include <iostream>
#include <iterator>
#include <limits>
#include <numeric>
#include <string>
#include <vector>

struct Item { int value; };

struct Tracked {
  int value;
  Tracked(int n) : value(n) {}
  Tracked(const Tracked& other) : value(other.value) { std::cout << 'C'; }
};

void copyOnly(Item item) { item.value = 50; }
void increment(Item& item) { ++item.value; }
int plusOne(short value) { return value + 1; }
std::string append(std::string sum, int value) {
  sum += char('0' + value);
  return sum;
}

int main() {
  int values[3] = {3, 1, 2};
  std::cout << *std::max_element(values, values + 3) << ' ' << *std::next(values) << '\n';
  std::sort(values, values + 3);
  int copied[3];
  std::cout << (std::copy(values, values + 3, copied) == copied + 3) << '\n';
  std::cout << std::accumulate(copied, copied + 3, std::string("sum="), append) << '\n';

  Item items[2] = {{4}, {5}};
  std::for_each(items, items + 2, copyOnly);
  std::for_each(items, items + 2, increment);
  int* saved = &items[0].value;
  std::fill(items, items + 2, Item{6});
  std::cout << *saved << ' ' << items[1].value << '\n';
  Item replacement[2] = {{7}, {8}};
  std::copy(replacement, replacement + 2, items);
  std::cout << *saved << ' ' << items[1].value << '\n';
  Tracked destination[2] = {Tracked(1), Tracked(2)};
  Tracked fill(9);
  std::fill(destination, destination + 2, fill);
  std::cout << destination[1].value << '\n';
  std::transform(copied, copied + 3, values, plusOne);
  std::cout << values[2] << '\n';

  double nan = std::numeric_limits<double>::quiet_NaN();
  double samples[2] = {nan, 1.0};
  std::cout << std::equal_to<double>{}(nan, 1.0) << ' ' << std::less_equal<double>{}(nan, 1.0) << ' ';
  std::cout << (std::find(samples, samples + 2, 1.0) == samples + 1) << '\n';
  std::equal_to<int> equal;
  { auto copy = equal; std::cout << copy(1, 1) << ' '; }
  std::cout << equal(1, 1) << '\n';

  unsigned long long large[2] = {9007199254740992ULL, 9007199254740993ULL};
  std::cout << (std::find(large, large + 2, 9007199254740993ULL) == large + 1) << '\n';

  unsigned char iota[3];
  std::iota(iota, iota + 3, 254);
  std::cout << int(iota[0]) << ' ' << int(iota[1]) << ' ' << int(iota[2]) << '\n';
}
