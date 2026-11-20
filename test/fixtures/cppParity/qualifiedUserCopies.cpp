#include <iostream>
#include <vector>

struct Choice {
  Choice() {}
  Choice(Choice&) { std::cout << 'M'; }
  Choice(const Choice&, int n = 7) { std::cout << n; }
};

struct Mutable {
  Mutable() {}
  Mutable(Mutable&) { std::cout << 'm'; }
};

struct Wrapped { Choice member; };
struct MutableWrapped { Mutable member; Choice other; };
class Parent {
public:
  Parent() {}
protected:
  Parent(const Parent&) { std::cout << 'p'; }
};
struct Child : Parent {};
struct Addresses {
  int value = 4;
  const Addresses* self = this;
  const int* member = &value;
  Addresses() {}
  Addresses(const Addresses& other) : value(other.value) {}
};
struct DerivedAddresses : Addresses {};

int main() {
  Choice source;
  const Choice fixed;
  Choice a = source;
  Choice b = fixed;
  Wrapped w;
  Wrapped x = w;
  MutableWrapped y;
  MutableWrapped z = y;
  Child child;
  Child copy = child;
  std::vector<Choice> choices;
  choices.push_back(source);
  std::vector<Choice> braceCopies{Choice()};
  std::cout << '\n';
  DerivedAddresses original;
  DerivedAddresses aliased = original;
  aliased.value = 9;
  std::cout << (aliased.self == &aliased) << ' ' << *aliased.member << '\n';
}
