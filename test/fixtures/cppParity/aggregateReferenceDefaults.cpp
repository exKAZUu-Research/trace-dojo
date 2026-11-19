#include <array>
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
struct DefaultBase { const Base& value{Derived{}}; };
struct DefaultDerived { const Derived& value{Derived{}}; };

void take(Ref value) { std::cout << 'T'; }

Ref namedReturn() {
  Ref result{Derived{}};
  return result;
}
Ref directReturn() { return Ref{Derived{}}; }
Ref bracedReturn() { return {Derived{}}; }
Ref conditionalReturn(bool flag) { return flag ? Ref{Derived{}} : Ref{Derived{}}; }
std::array<Ref, 1> arrayReturn() {
  std::array<Ref, 1> result{Ref{Derived{}}};
  return result;
}

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
  {
    DefaultBase base{};
    DefaultDerived derived{};
    std::cout << 'Z';
  }
  {
    DefaultBase builtIn[2]{};
    std::array<DefaultDerived, 2> library{};
    DefaultBase explicitBuiltIn[2]{{}, {}};
    std::array<DefaultDerived, 2> explicitLibrary{{{}, {}}};
    std::cout << 'A';
  }
  take(Ref{Derived{}});
  static_cast<void>(Ref{Derived{}});
  std::cout << 'Q';
  Ref* heap = new Ref{Derived{}};
  std::cout << 'H';
  delete heap;
  Ref named = namedReturn();
  std::cout << 'N';
  Ref direct = directReturn();
  std::cout << 'R';
  Ref braced = bracedReturn();
  std::cout << 'L';
  Ref branch = conditionalReturn(true);
  std::cout << 'C';
  auto array = arrayReturn();
  std::cout << 'A';
}
