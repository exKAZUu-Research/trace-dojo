#include <algorithm>
#include <iostream>
#include <vector>

int main() {
  std::vector<bool> values{true, true, false};
  std::vector<bool>::reference first = values[0];
  first = false;
  auto second = values.begin()[1];
  second.flip();
  auto last = values.emplace_back(true);
  last = false;
  std::cout << values.front() << values.at(1) << values.back() << ':' << values.capacity() << '\n';
  for (auto value : values) value = true;
  const std::vector<bool>& readonly = values;
  auto view = readonly.at(1);
  bool snapshot = view;
  values[1] = false;
  std::cout << view << snapshot << ' ' << *readonly.begin() << ' '
            << std::count(values.begin(), values.end(), true) << ' ' << (values[0] + 2) << '\n';
  values.flip();
  std::cout << values[0] << values[1] << '\n';
  values.resize(66);
  std::cout << values.capacity() << ' ';
  values.resize(2);
  values.shrink_to_fit();
  std::cout << values.capacity() << '\n';
}
