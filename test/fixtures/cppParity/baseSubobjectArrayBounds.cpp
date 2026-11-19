#include <array>
#include <iostream>

struct Base {
  Base* end;
  Base() : end(this + 1) {}
  Base* endFromMethod() { return this + 1; }
};

struct Derived : Base { int padding[4]; };
struct SameSize : Base {};

int destroyed = 0;
struct VirtualBase { virtual ~VirtualBase() { ++destroyed; } };
struct VirtualDerived : VirtualBase {
  int padding[4];
  ~VirtualDerived() { destroyed += 2; }
};

struct Plain { int value; int other; };
struct Tagged : Plain { virtual void identify() {} };
struct Extended : Tagged {};
struct ArrayBase { int values[2][2]; };
struct TaggedArray : ArrayBase { virtual void identify() {} };
struct PlainArray : ArrayBase {};

void showArray(ArrayBase* p) {
  std::cout << (static_cast<void*>(p) == static_cast<void*>(&p->values))
            << (static_cast<void*>(p) == static_cast<void*>(p->values[0]))
            << (static_cast<void*>(p->values + 1) == static_cast<void*>(p->values[1]))
            << (static_cast<void*>(p->values + 2) == static_cast<void*>(&p->values + 1)) << '\n';
}

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

  Derived local;
  Derived* heap = new Derived;
  SameSize same;
  std::cout << (static_cast<void*>(local.end) == static_cast<void*>(&local + 1))
            << (static_cast<void*>(heap->end) == static_cast<void*>(heap + 1))
            << (static_cast<void*>(same.end) == static_cast<void*>(&same + 1)) << '\n';
  delete heap;
  VirtualBase* base = new VirtualDerived;
  delete base;
  std::cout << destroyed << '\n';

  Extended extended;
  Plain* localBase = &extended;
  Tagged* tagged = &extended;
  Tagged* allocated = new Tagged;
  Plain* heapBase = allocated;
  std::cout << (static_cast<void*>(localBase) == static_cast<void*>(&extended))
            << (static_cast<void*>(tagged) == static_cast<void*>(&extended))
            << (static_cast<void*>(localBase) == static_cast<void*>(&extended.value))
            << (static_cast<void*>(localBase + 1) == static_cast<void*>(&extended + 1))
            << (static_cast<void*>(heapBase) == static_cast<void*>(allocated))
            << (static_cast<void*>(heapBase) == static_cast<void*>(&allocated->value))
            << (static_cast<void*>(heapBase + 1) == static_cast<void*>(allocated + 1)) << '\n';
  delete allocated;
  PlainArray plainArray;
  TaggedArray* taggedArray = new TaggedArray;
  showArray(&plainArray);
  showArray(taggedArray);
  delete taggedArray;
}
