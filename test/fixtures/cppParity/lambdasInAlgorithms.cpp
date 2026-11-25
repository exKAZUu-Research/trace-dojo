#include <iostream>
#include <vector>
#include <algorithm>
#include <numeric>
#include <string>
struct ByLength { bool operator()(const std::string& a, const std::string& b) const { return a.size() < b.size(); } };
int main() {
  std::vector<int> v = {5, 2, 8, 1, 9, 3};
  std::sort(v.begin(), v.end(), [](int a, int b) { return a > b; });
  for (int x : v) std::cout << x;
  std::cout << "\n";
  int threshold = 4;
  std::cout << std::count_if(v.begin(), v.end(), [threshold](int x) { return x > threshold; }) << "\n";
  auto it = std::find_if(v.begin(), v.end(), [&](int x) { return x < threshold; });
  std::cout << *it << "\n";
  int sum = 0;
  std::for_each(v.begin(), v.end(), [&sum](int x) { sum += x; });
  std::cout << sum << "\n";
  std::vector<int> w(v.size());
  std::transform(v.begin(), v.end(), w.begin(), [](int x) { return x * x; });
  std::cout << w[0] << " " << std::accumulate(v.begin(), v.end(), 0, [](int a, int b) { return a + 2 * b; }) << "\n";
  std::vector<std::string> words = {"ccc", "a", "bb"};
  std::sort(words.begin(), words.end(), ByLength());
  for (auto& s : words) std::cout << s << " ";
  std::cout << "\n";
  v.erase(std::remove_if(v.begin(), v.end(), [](int x) { return x % 2 == 0; }), v.end());
  for (int x : v) std::cout << x;
  std::cout << "\n";
  std::cout << std::all_of(v.begin(), v.end(), [](int x) { return x % 2 == 1; }) << "\n";
  auto cmp = [](int a, int b) { return a < b; };
  std::cout << *std::max_element(v.begin(), v.end(), cmp) << "\n";
  int calls = 0;
  std::sort(w.begin(), w.end(), [&calls](int a, int b) { ++calls; return a < b; });
  std::cout << (calls > 0) << "\n";
}
