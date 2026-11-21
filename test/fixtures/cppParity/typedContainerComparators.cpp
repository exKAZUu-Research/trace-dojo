#include <algorithm>
#include <functional>
#include <iostream>
#include <list>
#include <map>
#include <set>
#include <string>

struct Value { const int id; };

int main() {
  std::map<double, int, std::less<int>> m;
  m[1.1] = 7;
  m[1.9] = 8;
  std::set<double, std::greater<int>> s{1.1, 1.9, 2.2};
  std::cout << m.size() << ' ' << m.at(1.1) << ' ' << s.size() << ' ' << *s.begin() << '\n';
  std::list<Value> kept{{3}, {4}};
  kept.erase(kept.begin());
  std::cout << kept.front().id << '\n';
  int first = 1, second = 2, third = 3;
  auto refs = std::minmax(first, second);
  auto reversed = std::minmax(second, first);
  auto larger = std::minmax(first, third);
  std::cout << (refs == reversed) << (refs < larger) << '\n';
  std::cout << std::set<int>().max_size() << ' ' << std::map<int, int>().max_size() << ' '
            << std::map<int, std::string>().max_size() << '\n';
}
