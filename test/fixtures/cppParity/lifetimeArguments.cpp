#include <iostream>

struct T {
  int id;
  T(int i) : id(i) { std::cout << "C" << id << " "; }
  T(const T& other) : id(other.id + 10) { std::cout << "cp" << id << " "; }
  ~T() { std::cout << "D" << id << " "; }
};

int f(T t) {
  std::cout << "in f ";
  return t.id;
}

int g(int x) {
  std::cout << "in g ";
  return x;
}

void both(T a, T b) { std::cout << "in both "; }

void byReference(const T& t, int) {}

int fail() { throw 9; }

void failing(T t) {
  std::cout << "in failing ";
  throw 8;
}

struct S {
  S(T t, int) { std::cout << "S "; }
  void method(T t) { std::cout << "in method "; }
};

int main() {
  g(f(T(1)));
  std::cout << "\n";
  T x(2);
  g(f(x));
  std::cout << "\n";
  both(T(3), T(4));
  std::cout << "\n";
  int sum = f(T(5)) + f(T(6));
  std::cout << sum << "\n";
  S s(T(7), 0);
  std::cout << "\n";
  s.method(T(8));
  std::cout << "\n";
  try {
    byReference(T(11), fail());
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    f(T(12)) + fail();
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    S failed(T(13), fail());
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    failing(T(14));
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
}
