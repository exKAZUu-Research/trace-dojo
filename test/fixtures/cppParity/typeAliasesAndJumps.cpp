#include <iostream>
#include <vector>
#include <string>
typedef int Int, *IntPtr;
typedef struct { int x, y; } Point;
using Name = std::string;
using Row = std::vector<int>;
struct Box {
  typedef double Value;
  using Size = unsigned;
  Value v = 1.5;
  static_assert(sizeof(Value) == 8, "double");
};
static_assert(sizeof(Int) == 4);
int f() { static int n = 0; return ++n; }
int main() {
  Int a = 3;
  IntPtr p = &a;
  Point pt{1, 2};
  Name n = "abc";
  Row r = {1, 2, 3};
  Box::Value bv = 2.5;
  Box::Size s = 7;
  std::cout << *p << " " << pt.x + pt.y << " " << n << " " << r.size() << " " << bv << " " << s << " " << Box().v << "\n";
  typedef long L;
  L big = 1L << 40;
  std::cout << big << "\n";
  if (int k = f(); k > 0) std::cout << "k=" << k << "\n";
  if (int m = f() - 2) std::cout << "m=" << m << "\n"; else std::cout << "zero m=" << m << "\n";
  switch (int q = f(); q) { case 3: std::cout << "three\n"; break; default: std::cout << "other " << q << "\n"; }
  int count = 0;
  while (int left = 3 - count) { std::cout << left; ++count; }
  std::cout << "\n";
  for (std::vector<int> v = {4, 5}; int x : v) std::cout << x;
  std::cout << "\n";
  int i = 0;
loop:
  if (i < 3) { std::cout << i; ++i; goto loop; }
  std::cout << "\n";
  for (int a1 = 0; a1 < 3; ++a1)
    for (int b1 = 0; b1 < 3; ++b1)
      if (a1 * b1 == 2) { std::cout << a1 << b1; goto done; }
done:
  std::cout << " done\n";
  {
    goto inner;
    std::cout << "skipped\n";
    inner: std::cout << "inner\n";
  }
  static_assert(sizeof(Point) == 8, "pt");
}
