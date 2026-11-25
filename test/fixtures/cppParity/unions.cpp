#include <iostream>
#include <cstdio>
union Value {
  int i;
  float f;
  char c[4];
};
struct Tagged {
  enum Kind { INT, DOUBLE } kind;
  union {
    int i;
    double d;
  };
};
union Point {
  struct { int x, y; } p;
  int arr[2];
};
struct S {
  int tag;
  union { int i; float f; };
  struct { int a, b; };
};
union U2 { int i; double d; };
void show(const Tagged& t) {
  if (t.kind == Tagged::INT) std::cout << "int " << t.i << "\n";
  else std::cout << "double " << t.d << "\n";
}
int main() {
  Value v;
  v.i = 42;
  std::cout << v.i << " " << sizeof(Value) << " " << alignof(Value) << "\n";
  v.f = 1.5f;
  std::cout << v.f << "\n";
  Value w = {7};
  std::cout << w.i << "\n";
  Value z = w;
  std::cout << z.i << "\n";
  Tagged a{Tagged::INT};
  a.i = 3;
  Tagged b;
  b.kind = Tagged::DOUBLE;
  b.d = 2.25;
  show(a);
  show(b);
  std::cout << sizeof(Tagged) << "\n";
  Point p;
  p.p.x = 1;
  p.p.y = 2;
  std::cout << p.p.x + p.p.y << " " << sizeof(Point) << "\n";
  p.arr[0] = 10;
  std::cout << p.arr[0] << "\n";
  union { int a; long b; } local;
  local.b = 5;
  std::cout << local.b << "\n";
  Value d{.f = 0.5f};
  printf("%.2f\n", d.f);
  {
  Point q{};
  q.arr[1] = 4;
  std::cout << q.arr[1] << "\n";
  Point r{{1, 2}};
  std::cout << r.p.y << "\n";
  S s{1, {5}, {6, 7}};
  std::cout << s.i << " " << s.a + s.b << " " << sizeof(S) << "\n";
  s.f = 2.5f;
  std::cout << s.f << "\n";
  U2 u = {3};
  U2 u2;
  u2 = u;
  std::cout << u2.i << " " << sizeof u2 << "\n";
  }
}
