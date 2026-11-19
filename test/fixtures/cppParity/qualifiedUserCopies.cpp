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
}
