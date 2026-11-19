#include <algorithm>
#include <functional>
#include <iostream>
#include <list>
#include <numeric>
#include <random>
#include <string>
#include <vector>

struct P {
  int k;
};

bool gt(int a, int b) { return a > b; }
bool ieq(char a, char b) { return (a | 32) == (b | 32); }
int mul(int a, int b) { return a * b; }
int add(int a, int b) { return a + b; }
bool lessPk(const P& a, int k) { return a.k < k; }
bool lessKp(int k, const P& a) { return k < a.k; }
bool near(int a, int b) { return b - a < 2; }
bool byLength(const std::string& a, const std::string& b) { return a.size() < b.size(); }
const int* expected = nullptr;
bool observesReference(const int& a, const int& b) {
  std::cout << (&a == expected);
  return a < b;
}
bool observesArray(const int& a, const int& b) {
  std::cout << (&a + 1 == &b);
  return a < b;
}

int main() {
  int three = 3, five = 5;
  auto p = std::minmax(three, five, gt);
  std::cout << p.first << p.second << '\n';
  auto q = std::minmax({4, 1, 9, 2, 1, 9});
  std::cout << q.first << q.second << '\n';
  auto r = std::minmax({4, 1, 9, 2}, gt);
  std::cout << r.first << r.second << '\n';
  auto s = std::minmax({std::string("bb"), std::string("a"), std::string("cc"), std::string("d")}, byLength);
  std::cout << s.first << s.second << '\n';
  std::cout << std::min({4, 1, 9}, gt) << std::max({4, 1, 9}, gt) << '\n';
  std::cout << std::clamp(10, 5, 1, gt) << std::clamp(3, 5, 1, gt) << '\n';
  expected = &three;
  std::cout << std::max(three, five, observesReference) << ' ';
  expected = &five;
  std::cout << std::min(three, five, observesReference) << ' ';
  std::cout << std::max({7, 9}, observesArray) << '\n';

  std::string a = "abc", b = "ABC", c = "ABCD";
  std::cout << std::equal(a.begin(), a.end(), b.begin(), b.end(), ieq)
            << std::equal(a.begin(), a.end(), c.begin(), c.end(), ieq) << std::equal(a.begin(), a.end(), b.begin(), ieq)
            << '\n';

  std::vector<int> v{1, 2, 3, 4}, o(4);
  std::partial_sum(v.begin(), v.end(), o.begin(), mul);
  for (int x : o) std::cout << x << ' ';
  std::cout << '\n';
  std::partial_sum(v.begin(), v.end(), o.begin(), std::multiplies<int>());
  std::cout << o[3] << '\n';
  std::cout << std::inner_product(v.begin(), v.end(), v.begin(), 1, mul, add) << '\n';
  std::cout << std::inner_product(v.begin(), v.end(), v.begin(), 0, std::plus<int>(), std::multiplies<int>()) << '\n';

  std::vector<std::string> w{"a", "b", "c"};
  std::cout << std::accumulate(w.begin(), w.end(), std::string(), std::plus<std::string>()) << '\n';
  long long x = 5;
  std::cout << std::min<long long>(3, x) << ' ' << std::max<double>(1, 2.5) << '\n';
  std::cout << std::clamp<double>(1.5, 0, 1) << ' ' << sizeof(std::gcd<long>(2, 3)) << ' '
            << sizeof(std::lcm<short, short>(2, 3)) << '\n';
  int input[]{1, 2, 3};
  const int* last = input + 3;
  std::cout << std::accumulate<const int*, double>(input, input + 3, 0.5f) << ' '
            << std::count<const int*, double>(input, input + 3, 1.9) << ' '
            << std::equal<const int*, const int*>(input, input + 3, input, last) << '\n';

  std::vector<P> ps{{1}, {3}, {5}, {7}};
  std::cout << (std::lower_bound(ps.begin(), ps.end(), 4, lessPk) - ps.begin())
            << (std::upper_bound(ps.begin(), ps.end(), 5, lessKp) - ps.begin()) << '\n';

  std::list<int> l{3, 1, 2, 5, 4};
  l.sort(gt);
  for (int y : l) std::cout << y;
  std::cout << '\n';
  l.sort(std::less<int>());
  for (int y : l) std::cout << y;
  std::cout << '\n';
  std::list<int> l2{1, 2, 3, 6, 7, 10};
  std::cout << l2.unique(near) << ':';
  for (int y : l2) std::cout << y << ' ';
  std::cout << '\n';

  std::vector<int> u{1, 2};
  u.insert(u.begin() + 1, {9, 8});
  for (int y : u) std::cout << y;
  std::cout << '\n';
  u.assign({7, 7});
  std::cout << u.size() << u[1] << '\n';
  std::cout << std::mt19937::max() << ' ' << std::mt19937::min() << ' ' << std::mt19937_64::max() << '\n';
}
