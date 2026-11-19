#include <iostream>

struct DefaultRef { const int& value{7}; };

struct Base {
  ~Base() { std::cout << 'B'; }
};
struct Derived : Base {
  Derived() {}

  ~Derived() { std::cout << 'D'; }
};
struct Ref { const Base& value; };

int main() {
  DefaultRef first{};
  DefaultRef second{9};
  std::cout << first.value << second.value;
  {
    Ref direct{Derived{}};
    Ref braced{{Derived{}}};
    std::cout << 'X';
  }
  std::cout << 'Y';
}
