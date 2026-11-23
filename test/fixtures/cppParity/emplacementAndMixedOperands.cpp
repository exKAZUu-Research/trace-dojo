#include <cmath>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <vector>

struct S {
  int number;
  int cells[2];
};
struct Wrapped { S inner; int cells[2]; };

int main() {
  std::map<int, std::string> strings;
  strings.try_emplace(1, 3, 'x');
  strings.try_emplace(1, 2, 'y');
  strings.emplace();
  std::set<int> values;
  values.emplace();
  std::cout << strings[1] << strings.size() << *values.begin() << ' ';
  std::cout << std::pow(2.0f, 3.0) << std::fma(2, 3, 1) << ' ';
  int x = 2;
  const int y = 3;
  const int* p = &(true ? x : y);
  const int* q = false ? &x : &y;
  std::cout << *p << *q << ' ';
  Wrapped braced{};
  Wrapped copied = {};
  Wrapped* heap = new Wrapped();
  std::vector<Wrapped> many(2);
  std::cout << braced.inner.cells[0] << copied.cells[1] << heap->cells[0] << many[1].inner.number;
  delete heap;
}
