#include <iostream>
#include <map>
#include <vector>

int main() {
  std::vector<int> v{1, 2, 3, 4, 5};
  auto it = v.insert(v.end(), 2, 0);
  std::cout << (it - v.begin()) << ' ' << v.size() << '\n';
  std::vector<int> w{1, 2, 3, 4, 5};
  it = w.insert(w.end(), 2, 7);
  std::cout << (it - w.begin()) << ' ' << w.size() << '\n';
  it = w.erase(w.end() - 1);
  std::cout << (it == w.end()) << '\n';
  std::vector<int>::const_iterator c = v.begin();
  c = w.begin() + 2;
  std::cout << *c << '\n';
  std::map<int, int> m{{1, 10}, {2, 20}}, n{{3, 30}};
  auto p = m.begin();
  p = n.find(3);
  std::cout << p->second << (p == n.begin()) << '\n';
}
