#include <iostream>
#include <string>

struct P {
  int x, y;
};
struct Q {
  P p;
  int z;
};
struct A {
  int a[3];
  int b;
};
struct S {
  char name[8];
  int n;
};
struct T {
  int v;
  T(int x) : v(x) { std::cout << "T" << x << ' '; }
};
struct W {
  T t;
  int k;
};
struct V {
  std::string name;
  int n;
};
struct Ref {
  int& r;
};
struct CR {
  const int& c;
  int k;
};
struct K {
  const int id;
  int n;
};
struct Outer {
  Ref ref;
  int m;
};

int g[2][3] = {1, 2, 3, 4};
P gp[2] = {1, 2, 3, 4};
char gs[2][4] = {"ab", "cd"};

int main() {
  // Brace elision
  int m[2][3] = {1, 2, 3, 4};
  for (auto& row : m)
    for (int v : row) std::cout << v << ' ';
  for (auto& row : g)
    for (int v : row) std::cout << v << ' ';
  std::cout << '\n';
  P arr[2] = {1, 2, 3, 4};
  std::cout << arr[0].x << arr[0].y << arr[1].x << arr[1].y << gp[1].y << '\n';
  int n[2][2] = {{1}, 3};
  std::cout << n[0][0] << n[0][1] << n[1][0] << n[1][1] << '\n';
  int b[][2] = {1, 2, 3};
  std::cout << sizeof(b) / sizeof(b[0]) << b[1][0] << b[1][1] << '\n';
  Q q = {1, 2, 3};
  Q qs[2] = {1, 2, 3, {4, 5}};
  std::cout << q.p.x << q.p.y << q.z << qs[1].p.x << qs[1].p.y << qs[1].z << '\n';
  int c[2][2][2] = {1, 2, 3, 4, 5};
  std::cout << c[1][0][0] << c[1][1][1] << '\n';
  A a = {1, 2, 3, 4};
  A a2 = {{1}, 9};
  std::cout << a.a[2] << a.b << a2.a[0] << a2.a[1] << a2.b << '\n';
  int e[3][2] = {{1, 2}, 3, 4, {5}};
  std::cout << e[1][0] << e[1][1] << e[2][0] << '\n';
  P p1{1, 2};
  P ps[3] = {p1, 3, 4};
  std::cout << ps[0].y << ps[1].x << ps[1].y << ps[2].x << '\n';
  V vs[2] = {"ab", 1, "cd"};
  std::cout << vs[0].name << vs[0].n << vs[1].name << vs[1].n << '\n';
  std::string strings[2][2] = {"a", "b", "c"};
  std::cout << strings[1][0] << strings[1][1].size() << '\n';

  // Character arrays from string literals
  char s[2][4] = {"ab", "cd"};
  std::cout << s[0] << s[1] << gs[1] << '\n';
  char t[][3] = {"x", "yz"};
  char names[][6] = {"alice", "bob"};
  char one[] = {"xyz"};
  std::cout << sizeof(t) << t[1] << sizeof(names) << names[1] << sizeof(one) << one << '\n';
  S records[2] = {{"foo", 1}, {"bar", 2}};
  S record = {"hi", 3};
  std::cout << records[1].name << records[1].n << record.name << record.n << '\n';
  char u[2][4] = {{"ab"}, {'c', 'd'}};
  std::cout << u[0] << u[1] << '\n';

  // Classes without a default constructor
  T objects[2] = {T(4), 5};
  std::cout << objects[0].v << objects[1].v << '\n';
  T* dynamic = new T[2]{1, 2};
  std::cout << dynamic[0].v << dynamic[1].v << '\n';
  delete[] dynamic;
  T unsized[] = {7, 8, 9};
  std::cout << sizeof(unsized) / sizeof(T) << '\n';
  W w{T(3), 4};
  W w2{5, 6};
  std::cout << w.t.v << w.k << w2.t.v << w2.k << '\n';

  // new expressions
  int** pointers = new int*[2];
  int x = 3;
  int y = 9;
  pointers[0] = &x;
  pointers[1] = nullptr;
  std::cout << *pointers[0] << (pointers[1] == nullptr) << '\n';
  delete[] pointers;
  int* zeros = new int[3]();
  int* braced = new int[4]{1, 2};
  int* parenthesized = new int[3](1, 2, 3);
  std::cout << zeros[0] << zeros[2] << braced[1] << braced[3] << parenthesized[2] << '\n';
  delete[] zeros;
  delete[] braced;
  delete[] parenthesized;
  int** both = new int*[2]{&x, &y};
  int*** single = new int**(both);
  std::cout << *both[1] << **(*single) << '\n';
  delete single;
  delete[] both;

  // Aggregates with reference and const members
  int v = 1;
  Ref r1{v};
  r1.r = 5;
  Ref r2 = {v};
  r2.r++;
  std::cout << v << r1.r << '\n';
  CR cr{10, 2};
  std::cout << cr.c << cr.k << '\n';
  K k{7, 8};
  K k2 = k;
  std::cout << k2.id << k2.n << '\n';
  Outer o{{v}, 3};
  Outer o2{v, 4};
  o.ref.r = 20;
  std::cout << v << o2.ref.r << o2.m << '\n';
}
