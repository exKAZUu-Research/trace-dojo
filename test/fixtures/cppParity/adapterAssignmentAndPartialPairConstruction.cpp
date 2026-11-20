#include <iostream>
#include <queue>
#include <stack>
#include <utility>
#include <vector>

int copies;
bool shouldThrow;
struct Item {
  int n;
  Item(int value) : n(value) {}
  Item(const Item& other) : n(other.n) {
    if (shouldThrow && ++copies == 2) throw 1;
    std::cout << 'C' << n;
  }
  ~Item() { std::cout << 'D' << n; }
};

int main() {
  std::stack<Item> source, target;
  source.emplace(1);
  source.emplace(2);
  target.emplace(3);
  target = source;
  std::queue<Item> from, to;
  from.emplace(4);
  to.emplace(5);
  to = from;
  std::stack<Item, std::vector<Item>> stack, other;
  stack.emplace(1);
  stack.emplace(2);
  stack.emplace(3);
  other.emplace(4);
  other = stack;
  stack = other;
  stack.pop();
  Item first(6), second(7);
  shouldThrow = true;
  try {
    std::pair<Item, Item> pair(first, second);
  } catch (int) {
    std::cout << 'X';
  }
}
