#include <iostream>
#include <map>
#include <utility>
#include <vector>

struct Key {
  int n;
  Key(int value) : n(value) { std::cout << 'K'; }
  Key(const Key& other) : n(other.n) { std::cout << 'C'; }
  ~Key() { std::cout << 'D'; }
};

struct Mapped {
  Mapped(int) { std::cout << 'M'; throw 1; }
};

int main() {
  std::map<std::vector<int>, Mapped> map;
  try { map.emplace(std::vector<int>{1}, 1); }
  catch (int) { std::cout << 'E' << map.size() << '\n'; }
  try { map.try_emplace(std::vector<int>{2}, 2); }
  catch (int) { std::cout << 'T' << map.size() << '\n'; }
  Key key(3);
  try { std::pair<Key, Mapped> pair(key, 3); }
  catch (int) { std::cout << 'P' << '\n'; }
}
