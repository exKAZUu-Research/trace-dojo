#include <iostream>
#include <string>

struct T {
  int id;
  T(int i) : id(i) { std::cout << "C" << id << " "; }
  T(const T& other) : id(other.id + 10) { std::cout << "cp" << id << " "; }
  ~T() { std::cout << "D" << id << " "; }
};

T global(100);

T parenthesized() {
  T a(1);
  return (a);
}
T twoInOneScope(bool c) {
  T a(2);
  T b(3);
  if (c) return a;
  return b;
}
T namedThenTemporary(bool c) {
  T a(4);
  if (c) return a;
  return T(5);
}
T temporaryThenNamed(bool c) {
  if (c) return T(6);
  T a(7);
  return a;
}
T separateBlocks(bool c) {
  if (c) {
    T a(8);
    return a;
  } else {
    T b(9);
    return b;
  }
}
T innerThenOuter(bool c) {
  T a(10);
  if (c) {
    T b(11);
    return b;
  }
  return a;
}
T outerThenLater(bool c) {
  T a(12);
  if (c) return a;
  T b(13);
  return b;
}
T parameter(T p) { return p; }
T sameTwice(bool c) {
  T a(14);
  if (c) return a;
  return a;
}
T inLoop(int n) {
  for (int i = 0; i < 3; i++) {
    T a(i + 20);
    if (i == n) return a;
  }
  return T(29);
}
T inSwitch(int k) {
  switch (k) {
    case 0: {
      T a(30);
      return a;
    }
    default: {
      T b(31);
      return b;
    }
  }
}
T constant() {
  const T a(32);
  return a;
}
T fromGlobal() { return global; }
T fromStatic() {
  static T s(33);
  return s;
}
std::string staticString() {
  static std::string s = "a";
  return s;
}

int main() {
  { T x = parenthesized(); } std::cout << "\n";
  { T x = twoInOneScope(true); } std::cout << "\n";
  { T x = twoInOneScope(false); } std::cout << "\n";
  { T x = namedThenTemporary(true); } std::cout << "\n";
  { T x = namedThenTemporary(false); } std::cout << "\n";
  { T x = temporaryThenNamed(true); } std::cout << "\n";
  { T x = temporaryThenNamed(false); } std::cout << "\n";
  { T x = separateBlocks(true); } std::cout << "\n";
  { T x = separateBlocks(false); } std::cout << "\n";
  { T x = innerThenOuter(true); } std::cout << "\n";
  { T x = innerThenOuter(false); } std::cout << "\n";
  { T x = outerThenLater(true); } std::cout << "\n";
  { T x = outerThenLater(false); } std::cout << "\n";
  { T x = parameter(T(15)); } std::cout << "\n";
  { T x = sameTwice(false); } std::cout << "\n";
  { T x = inLoop(1); } std::cout << "\n";
  { T x = inLoop(5); } std::cout << "\n";
  { T x = inSwitch(0); } std::cout << "\n";
  { T x = inSwitch(1); } std::cout << "\n";
  { T x = constant(); } std::cout << "\n";
  { T x = fromGlobal(); } std::cout << "\n";
  { T x = fromStatic(); x.id = 0; } std::cout << "\n";
  { T x = fromStatic(); } std::cout << "\n";
  std::string s = staticString();
  s += "b";
  std::cout << staticString() << " " << s << "\n";
}
