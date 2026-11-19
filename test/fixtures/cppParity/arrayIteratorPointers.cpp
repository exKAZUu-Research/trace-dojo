#include <algorithm>
#include <array>
#include <iostream>
#include <iterator>
#include <vector>

constexpr std::array<int, 2> constants{6, 7};
constexpr const int* start = constants.begin();
constexpr const int* stop = constants.cend();

int sum(const int* first, const int* last) {
  int result = 0;
  for (; first != last; ++first) result += *first;
  return result;
}

int main() {
  std::array<int, 3> values{2, 1, 3};
  std::array<int, 3>::iterator first = values.begin();
  std::array<int, 3>::const_iterator last = values.end();
  *first = 4;
  std::sort(first, values.end());
  const std::array<int, 3>& readonly = values;
  const int* begin = std::cbegin(readonly);
  std::cout << (begin == values.data()) << ' ' << sum(begin, last) << ' '
            << sum(start, stop) << ' ' << *values.rbegin() << '\n';
  std::array<int, 0> empty{};
  std::cout << (empty.begin() == nullptr) << (empty.end() == nullptr)
            << (empty.data() == nullptr) << ' ' << std::distance(empty.begin(), empty.end()) << '\n';

  std::vector<int> vector;
  std::cout << (vector.data() == nullptr);
  vector.reserve(2);
  std::cout << (vector.data() == nullptr);
  vector.push_back(1);
  vector.clear();
  std::cout << (vector.data() == nullptr);
  vector.shrink_to_fit();
  std::cout << (vector.data() == nullptr) << '\n';
}
