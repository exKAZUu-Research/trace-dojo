#include <iostream>
#include <vector>
#include <algorithm>
#include <numeric>
#include <string>
#include <utility>
using namespace std;
bool byFirst(const std::pair<int,int>& a, const std::pair<int,int>& b) { return a.first < b.first; }
bool isEven(int x) { return x % 2 == 0; }
int twice(int x) { return x * 2; }
int main() {
  std::vector<std::pair<int,int>> ps;
  for (int i = 0; i < 40; i++) ps.push_back({(i * 7) % 5, i});
  std::sort(ps.begin(), ps.end(), byFirst);
  for (auto& p : ps) std::cout << p.second << ",";
  std::cout << "\n";
  std::vector<int> v = {5, 3, 8, 1, 9, 2};
  std::sort(v.begin(), v.end(), std::greater<int>());
  for (int x : v) std::cout << x << " ";
  std::cout << std::accumulate(v.begin(), v.end(), 0) << " " << std::count_if(v.begin(), v.end(), isEven)
            << " " << *std::max_element(v.begin(), v.end()) << " " << std::max(3, 7) << " " << std::min({4, 2, 8}) << "\n";
  std::vector<int> w(v.size());
  std::transform(v.begin(), v.end(), w.begin(), twice);
  std::reverse(w.begin(), w.end());
  for (int x : w) std::cout << x << " ";
  std::cout << "\n";
  std::string s = "hello";
  std::sort(s.begin(), s.end());
  std::cout << s << " " << (std::find(v.begin(), v.end(), 8) - v.begin()) << "\n";
  std::vector<int> p = {1, 2, 3};
  do { for (int x : p) std::cout << x; std::cout << " "; } while (std::next_permutation(p.begin(), p.end()));
  std::cout << "\n" << std::gcd(12, 18) << " " << std::lcm(4, 6) << "\n";
  auto it = std::lower_bound(p.begin(), p.end(), 2);
  std::cout << *it << " " << std::binary_search(p.begin(), p.end(), 5) << "\n";
  std::cout << std::gcd(-3, 6u) << ' ' << std::lcm(-3, 6u) << ' ' << std::gcd(6u, -3LL) << '\n';
  short x = 12, y = 8;
  auto narrowGcd = std::gcd(x, y);
  auto narrowLcm = std::lcm(x, y);
  auto mixedLcm = std::lcm(x, 8u);
  std::cout << sizeof(narrowGcd) << ' ' << narrowGcd << ' ' << sizeof(narrowLcm) << ' ' << narrowLcm << ' '
            << sizeof(mixedLcm) << ' ' << mixedLcm << '\n';
  std::vector<std::string> words{"fox", "dog", "fox", "owl"};
  const char* fox = "fox";
  const char* expected[] = {"fox", "dog", "fox", "owl"};
  std::cout << (std::find(words.begin(), words.end(), "dog") - words.begin()) << ' '
            << std::count(words.begin(), words.end(), fox) << ' '
            << std::equal(words.begin(), words.end(), expected) << ' '
            << (remove(words.begin(), words.end(), fox) - words.begin()) << '\n';
  std::vector<std::string> ordered{"ant", "cat", "dog"};
  std::vector<unsigned> positive{1, 2, 3};
  std::cout << (std::lower_bound(ordered.begin(), ordered.end(), "cat") - ordered.begin()) << ' '
            << (std::upper_bound(ordered.begin(), ordered.end(), "cat") - ordered.begin()) << ' '
            << std::binary_search(ordered.begin(), ordered.end(), "cat") << ' '
            << (std::lower_bound(positive.begin(), positive.end(), -1) - positive.begin()) << '\n';
  int location = 1;
  const int* address = &location;
  std::vector<int*> pointers{&location, nullptr, &location};
  std::cout << (std::find(pointers.begin(), pointers.end(), nullptr) - pointers.begin()) << ' '
            << std::count(pointers.begin(), pointers.end(), address) << '\n';
}
