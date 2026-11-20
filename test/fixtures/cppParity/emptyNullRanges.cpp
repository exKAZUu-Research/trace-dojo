#include <algorithm>
#include <iostream>
#include <iterator>
#include <numeric>
#include <set>
#include <vector>

int main() {
  int* empty = nullptr;
  std::sort(empty, empty);
  std::cout << std::count(empty, empty, 1) << ' ' << std::accumulate(empty, empty, 7) << '\n';
  std::cout << (std::min_element(empty, empty) == empty)
            << (std::copy(empty, empty, empty) == empty)
            << (std::find(empty, empty, 7) == empty)
            << (empty + 0 == empty) << ' ' << std::distance(empty, empty) << '\n';
  std::vector<int> values(empty, empty);
  values.insert(values.begin(), empty, empty);
  values.assign(empty, empty);
  std::set<int> keys(empty, empty);
  std::cout << values.size() << keys.size() << '\n';
}
