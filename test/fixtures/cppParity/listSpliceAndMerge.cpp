#include <iostream>
#include <list>
bool big(int n) { return n > 3; }
int main() {
  std::list<int> a{1, 5, 2, 7}, b{3, 4, 9};
  a.remove_if([](int n) { return n == 5; });
  a.remove_if(big);
  a.sort();
  b.sort();
  a.merge(b);
  for (int x : a) std::cout << x;
  std::cout << b.empty() << "\n";
  std::list<int> c{10, 20};
  auto it = a.begin();
  ++it;
  a.splice(it, c);
  for (int x : a) std::cout << x << " ";
  std::cout << c.size() << "\n";
  std::list<int> d{5, 1}, e{4, 0};
  d.merge(e, [](int x, int y) { return x > y; });
  for (int x : d) std::cout << x;
  std::cout << "\n";
}
