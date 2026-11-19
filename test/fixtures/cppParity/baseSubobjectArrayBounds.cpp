#include <array>
#include <iostream>

struct Base {
  Base* end;
  Base() : end(this + 1) {}
  Base* endFromMethod() { return this + 1; }
};

struct Derived : Base { int padding[4]; };

void show(Derived* elements) {
  Base* first = elements;
  Base* second = static_cast<Base*>(elements + 1);
  Base& base = elements[0];
  Base& conditional = false ? base : elements[0];
  std::cout << (base.end == second) << (first + 1 == base.end)
            << (base.endFromMethod() == first + 1) << (&conditional + 1 == first + 1)
            << (static_cast<Derived*>(first) + 1 == elements + 1) << '\n';
  try { throw elements; }
  catch (Base* caught) { std::cout << (caught + 1 == base.end); }
  try { throw elements; }
  catch (Base* const& caught) { std::cout << (caught + 1 == base.end) << '\n'; }
}

int main() {
  Derived direct[2];
  show(direct);
  Derived* dynamic = new Derived[2];
  show(dynamic);
  delete[] dynamic;
  std::array<Derived, 2> stored;
  show(stored.data());
}
