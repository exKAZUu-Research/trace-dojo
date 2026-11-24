#include <array>
#include <iostream>
#include <iterator>
#include <numeric>
#include <span>
#include <vector>
int sum(std::span<const int> values) {
  int total = 0;
  for (int v : values) total += v;
  return total;
}
void doubleAll(std::span<int> values) {
  for (int& v : values) v *= 2;
}
int main() {
  int raw[] = {1, 2, 3, 4};
  std::vector<int> vec{5, 6, 7};
  std::array<int, 3> arr{8, 9, 10};
  std::cout << sum(raw) << " " << sum(vec) << " " << sum(arr) << "\n";
  doubleAll(vec);
  std::cout << vec[0] << vec[1] << vec[2] << "\n";
  std::span s(raw);
  std::cout << s.size() << s.size_bytes() << s.front() << s.back() << s.extent << "\n";
  auto mid = s.subspan(1, 2);
  std::cout << mid.size() << mid[0] << mid[1] << "\n";
  auto head = s.first<2>();
  std::cout << head.size() << head.extent << s.last(3)[0] << "\n";
  for (auto it = s.rbegin(); it != s.rend(); ++it) std::cout << *it;
  std::cout << "\n";
  std::span<int> dyn(vec.begin(), vec.end());
  std::cout << std::accumulate(dyn.begin(), dyn.end(), 0) << dyn.empty() << (dyn.data() == vec.data()) << "\n";
  std::span<int> empty;
  std::cout << empty.empty() << (std::dynamic_extent == static_cast<std::size_t>(-1)) << "\n";
  std::reverse_iterator<int*> r(raw + 4);
  std::cout << *r << r[1] << (std::make_reverse_iterator(raw + 4) == r) << "\n";
}
