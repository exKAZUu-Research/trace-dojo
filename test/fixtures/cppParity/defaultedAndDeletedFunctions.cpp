#include <iostream>
#include <string>
struct A {
  int x;
  std::string s;
  A() = default;
  A(int v) : x(v) {}
  A(const A&) = default;
  A& operator=(const A&) = default;
  ~A() = default;
};
struct Base { virtual ~Base() = default; virtual int f() const { return 1; } };
struct Derived : Base { int f() const override { return 2; } };
struct NoCopy {
  NoCopy() = default;
  NoCopy(const NoCopy&) = delete;
  NoCopy& operator=(const NoCopy&) = delete;
};
struct Counter {
  int n = 0;
  Counter& operator=(int v) { n = v * 10; return *this; }
};
struct Tracked {
  int id;
  Tracked(int i) : id(i) {}
  Tracked(const Tracked& o) : id(o.id + 100) { std::cout << "copy\n"; }
  Tracked& operator=(const Tracked& o) { id = o.id + 1000; std::cout << "assign\n"; return *this; }
};
struct Holder { Tracked t{1}; int k = 2; };
void takesInt(int) { std::cout << "int\n"; }
void takesInt(double) = delete;
int main() {
  A a{};
  std::cout << a.x << "[" << a.s << "]\n";
  A b(5);
  A c = b;
  c = a;
  std::cout << b.x << c.x << "\n";
  Base* p = new Derived;
  std::cout << p->f() << "\n";
  delete p;
  NoCopy n;
  Counter k;
  k = 4;
  std::cout << k.n << "\n";
  Holder h1, h2;
  h2.t.id = 7;
  h1 = h2;
  std::cout << h1.t.id << " " << h1.k << "\n";
  Holder h3 = h1;
  std::cout << h3.t.id << "\n";
  takesInt(3);
}
