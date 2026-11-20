#include <iostream>

struct M {
  int id;
  M(int i) : id(i) { std::cout << "C" << id << " "; }
  ~M() { std::cout << "D" << id << " "; }
};

struct Base {
  M m{1};
  Base() { std::cout << "Base "; }
  ~Base() { std::cout << "~Base "; }
};

struct BodyThrows : Base {
  M a{2};
  M b{3};
  BodyThrows() {
    M local(4);
    std::cout << "body ";
    throw 1;
  }
  ~BodyThrows() { std::cout << "~BodyThrows "; }
};

struct BaseThrows {
  M m{5};
  BaseThrows() { throw 2; }
  ~BaseThrows() { std::cout << "~BaseThrows "; }
};

struct Derived : BaseThrows {
  M a{6};
};

struct Bad {
  Bad() { throw 3; }
};

struct MemberThrows {
  M a{7};
  Bad bad;
  M c{8};
};

struct Delegating {
  M a{9};
  Delegating(int) { std::cout << "target "; }
  Delegating() : Delegating(0) { throw 4; }
  ~Delegating() { std::cout << "~Delegating "; }
};

struct T {
  int id;
  T() : T(0) {}
  T(int i) : id(i) {
    if (i == 3) throw i;
    std::cout << "T" << id << " ";
  }
  ~T() { std::cout << "~T" << id << " "; }
};

struct Counted {
  static int count;
  int id;
  Counted() : id(++count) {
    if (id == 3) throw id;
    std::cout << "U" << id << " ";
  }
  ~Counted() { std::cout << "~U" << id << " "; }
};
int Counted::count = 0;

struct Aggregate {
  T a;
  T b;
  T c;
};

int main() {
  try {
    BodyThrows x;
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    BodyThrows* p = new BodyThrows;
    delete p;
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    Derived x;
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    MemberThrows x;
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    Delegating x;
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    T arr[4] = {T(1), T(2), T(3), T(4)};
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    T arr[4] = {1, 2, 3, 4};
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    T grid[2][2] = {{1, 2}, {3, 4}};
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    Counted arr[4];
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  Counted::count = 0;
  try {
    Counted* p = new Counted[4];
    delete[] p;
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    T* p = new T[4]{1, 2, 3, 4};
    delete[] p;
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
  try {
    Aggregate a = {T(1), T(2), T(3)};
  } catch (int e) {
    std::cout << "caught " << e << "\n";
  }
}
