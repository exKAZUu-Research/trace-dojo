#include <iostream>

struct Cell {
  int value;
  const Cell* address;
  Cell(int number) : value(number), address(this) {}
  Cell(const Cell& other) : value(other.value), address(this) { std::cout << 'C'; }
};

struct Base {
  Cell member;
};

struct Derived : Base {
  Derived(int number) : Base(number) {}
  Derived(const Derived& other) : Base(other) {}
};

struct BraceDerived : Base {
  BraceDerived(const Base& other) : Base{other} {}
};

int main() {
  Derived first(7);
  Derived second = first;
  BraceDerived third(first);
  std::cout << first.member.value << second.member.value << third.member.value << ' '
            << (first.member.address == &first.member) << (second.member.address == &second.member)
            << (third.member.address == &third.member) << '\n';
}
