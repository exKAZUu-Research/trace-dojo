#include <iostream>
#include <vector>
#include <string>
struct P { int x; double y; };
int g(int a) { return a; }
auto twice(int a) -> decltype(a * 2) { return a * 2; }
int main() {
  int x = 3;
  decltype(x) y = 4;
  decltype((x)) r = x;
  r = 10;
  P p{1, 2.5};
  decltype(p.y) z = p.y * 2;
  decltype(1.5f + 1) f = 2;
  std::vector<int> v = {1, 2};
  decltype(v.size()) n = v.size();
  decltype(g(1)) gi = 7;
  decltype(auto) a = x;
  std::cout << x << " " << y << " " << z << " " << f / 3 << " " << n << " " << gi << " " << a << " " << twice(4) << "\n";
  std::cout << sizeof(decltype(p)) << " " << sizeof(decltype(f)) << "\n";
}
