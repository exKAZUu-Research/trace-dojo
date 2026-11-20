#include <algorithm>
#include <iostream>
#include <map>
#include <set>
#include <vector>

int f(int n = 1) { return n; }
struct Aggregate {
  int x = 3;
  int y = x + f();
};
int f() { return 2; }
int missing();
struct Replacement { int n = missing(); };
struct Unused { int n = missing(); };
struct UnusedInline { static int n; int get() { return n; } };
inline int unusedInline() { return missing(); }
struct WithArray { int values[2]; };

int copies;
struct Item {
  int n;
  Item(int value = 0) : n(value) { std::cout << 'I'; }
  Item(const Item& other) : n(other.n) {
    std::cout << 'C';
    if (++copies == 2) throw 1;
  }
  ~Item() { std::cout << 'D'; }
};
struct Box { Item entries[2]; };

int main() {
  Aggregate a{};
  Replacement replaced{8};
  WithArray grouped({2, 3});
  std::cout << a.y << replaced.n << grouped.values[1] << ' ';
  std::map<int, int> map({{1, 2}, {3, 4}});
  std::set<int> set({3, 1});
  std::vector<int> vector({1, 2});
  auto result = map.insert_or_assign(1, 9);
  auto range = set.equal_range(1);
  std::cout << map.at(1) << result.second << *range.first << *range.second << vector.size() << ' ';
  {
    Item items[2];
    std::cout << '|';
    std::fill(items, items + 2, 7);
    std::cout << items[1].n << ' ';
  }
  Box original;
  try { Box copy = original; }
  catch (int) { std::cout << 'X'; }
}
