#include <iostream>
#include <vector>

struct Item {
  int n;
  Item(int value) : n(value) {}
  Item(const Item& other) : n(other.n) { std::cout << 'C'; }
  ~Item() { std::cout << 'D'; }
};
struct Box { std::vector<Item> items; };

Box choose(bool first) {
  Box left{{Item(1)}};
  Box right{{Item(2)}};
  if (first) return left;
  return right;
}

Box identity(Box parameter) { return (parameter); }
Box persistent() {
  static Box local{{Item(3)}};
  return local;
}

int main() {
  {
    Box value = choose(true);
    std::cout << '|' << value.items[0].n << '|';
  }
  std::cout << '\n';
  {
    Box value = identity(Box{{Item(4)}});
    std::cout << '|' << value.items[0].n << '|';
  }
  std::cout << '\n';
  {
    Box first = persistent();
    Box second = persistent();
    std::cout << '|' << first.items[0].n << second.items[0].n << '|';
  }
  std::cout << '\n';
}
