#include <iostream>

struct Item {
  inline static int value = 4;
  static void print() { std::cout << "called\n"; }
  ~Item() { std::cout << "destroyed\n"; }
};

int count = 0;
int next() { return ++count; }
Item make() {
  std::cout << "created\n";
  return Item{};
}

void show() {
  static int a = next(), b = next();
  std::cout << a << ' ' << b << ' ' << count << '\n';
}

int main() {
  make().print();
  std::cout << make().value << '\n';
  show();
  show();
  for (int i = 0; i < 1; i++) { { int i = 7; std::cout << i << '\n'; } }
  for (int n : {9}) { { int n = 8; std::cout << n << '\n'; } }
}
