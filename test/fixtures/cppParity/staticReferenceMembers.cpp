#include <iostream>

int original = 2;
int& globalAlias = original;

struct Item {
  int value;
  Item(int n) : value(n) {}
  ~Item() { std::cout << "destroy " << value << '\n'; }
};

struct Holder {
  static int& assigned;
  static int& braced;
  inline static int& inClass = globalAlias;
  static constexpr int& constant = original;
  static const Item& retained;
};

int& Holder::assigned = original;
int& Holder::braced{original};
const Item& Holder::retained{Item(9)};

Holder receiver() { std::cout << "receiver\n"; return Holder{}; }
constexpr int* address = &Holder::constant;

int main() {
  Holder::assigned = 7;
  receiver().braced += 2;
  const Holder object{};
  object.inClass += 1;
  std::cout << original << ' ' << *address << ' ' << Holder::retained.value << '\n';
}
