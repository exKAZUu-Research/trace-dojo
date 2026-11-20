#include <iostream>

struct Base {
  int n;
  ~Base() { std::cout << 'B'; }
};
struct Item : Base {
  Item(int n) : Base{n} {}
  ~Item() { std::cout << 'D'; }
};

int main() {
  const int& scalar = static_cast<const int&>(6);
  std::cout << scalar << ' ';
  {
    const Item& first = static_cast<const Item&>(Item(7));
    const Base& second = (const Base&)Item(8);
    const int& member = static_cast<const Item&>(Item(9)).n;
    std::cout << first.n << second.n << member << ' ';
  }
  std::cout << '\n';
  Item existing(4);
  for (int i = 0; i < 2; ++i) {
    const Base& selected = i == 0 ? static_cast<const Base&>(Item(5)) : existing;
    std::cout << selected.n;
  }
  std::cout << '\n';
}
